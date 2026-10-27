#!/usr/bin/env python3
"""Private land.sh helpers: owner-safe locks, bounded processes and JSON receipts."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone


def read_json(path):
    return json.loads(Path(path).read_text())


def acquire_lock(path, pid):
    lock = Path(path)
    try:
        lock.mkdir()
    except FileExistsError:
        # Only one reclaimer may examine and retire an old lock. An unknown owner
        # or abandoned reclaimer requires operator inspection, never blind deletion.
        guard = Path(path + '.reclaim')
        try:
            guard.mkdir()
        except FileExistsError as error:
            raise ValueError(f'lock recovery already held at {guard}; inspect its owner before clearing') from error
        try:
            owner = read_json(lock / 'owner.json')
            if lock.is_symlink() or owner.get('host') != socket.gethostname():
                raise ValueError('lock owner is unknown or on another host')
            owner_pid = owner.get('pid')
            created = owner.get('created_at')
            if type(owner_pid) is not int or owner_pid <= 0 or type(created) not in (int, float):
                raise ValueError('lock owner metadata is invalid')
            if time.time() - created <= 1800:
                raise ValueError('lock is younger than 30 minutes')
            try:
                os.kill(owner_pid, 0)
            except ProcessLookupError:
                pass  # ESRCH is the only evidence that permits reclamation.
            else:
                raise ValueError(f'lock owner PID {owner_pid} is still alive')
            if sorted(p.name for p in lock.iterdir()) != ['owner.json']:
                raise ValueError('lock has unknown contents')
            (lock / 'owner.json').unlink()
            lock.rmdir()
            lock.mkdir()
            print(f'land: reclaimed stale lock from dead PID {owner_pid}', file=sys.stderr)
        except (OSError, ValueError, TypeError, AttributeError) as error:
            raise ValueError(f'lock held at {lock}: {error}; inspect owner/liveness before manually clearing it') from error
        finally:
            guard.rmdir()
    owner = {'pid': pid, 'created_at': time.time(), 'host': socket.gethostname()}
    (lock / 'owner.json').write_text(json.dumps(owner) + '\n')


def release_lock(path, pid):
    lock = Path(path)
    owner = read_json(lock / 'owner.json')
    if owner.get('pid') != pid or owner.get('host') != socket.gethostname():
        raise ValueError('lock ownership changed; leaving it untouched')
    (lock / 'owner.json').unlink()
    lock.rmdir()


def run_bounded(seconds, argv):
    if not argv:
        raise ValueError('missing command')
    process = subprocess.Popen(argv, start_new_session=True)
    try:
        return process.wait(timeout=seconds)
    except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        interrupted = isinstance(error, KeyboardInterrupt)
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass  # The owned group already exited.
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass  # Kill the whole group below, including children of an exited parent.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # No member remains; a parent exit alone does not prove that.
        process.wait()
        print(f'land: command interrupted or exceeded {seconds}s: {argv[0]}', file=sys.stderr)
        return 130 if interrupted else 1


def record_counts(log, name, path):
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', Path(log).read_text(errors='replace'))
    # Native Claude Code 2.1.293 footer, plus the compact fixture/older footer.
    passes = re.findall(r'^\s*(\d+) pass\s*$', text, re.M)
    failures = re.findall(r'^\s*(\d+) fail\s*$', text, re.M)
    compact = re.findall(r'^\s*(\d+) passed, (\d+) failed\s*$', text, re.M)
    if passes and failures:
        passed, failed = int(passes[-1]), int(failures[-1])
    elif compact:
        passed, failed = map(int, compact[-1])
    else:
        raise ValueError('test footer missing; cannot attest pass/fail counts')
    mods = read_json(path)
    mods[name] = {'pass': passed, 'fail': failed}
    Path(path).write_text(json.dumps(mods, sort_keys=True) + '\n')
    if passed <= 0 or failed != 0:
        raise ValueError(f'non-passing test counts: {passed} pass, {failed} fail')


SDK_VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+')
SDK_PARENTS = ('.local', 'share', 'claude-mods', 'sdk')
SDK_DEFAULT_MISSING = 'SDK input missing: promote a capture with land-state.py sdk-promote or set CLAUDE_MODS_SDK_ROOT'


def sdk_default_root(layout_root, version):
    """plan:105: the promoted root for the pinned version; V is validated before any path use."""
    if not isinstance(version, str) or SDK_VERSION.fullmatch(version) is None:
        raise ValueError('SDK manifest is invalid')
    return os.path.join(layout_root, *SDK_PARENTS, version)


def prepare_sdk(source_root, mod, manifest, version_log, proofs_path, layout_root=None):
    """Copy only pinned engine-written inputs, never a hand-written API substitute."""
    packet_bytes = Path(manifest).read_bytes()
    packet = json.loads(packet_bytes)
    version = packet.get('version')
    if packet.get('v') != 1 or not isinstance(version, str) or not isinstance(packet.get('files'), dict):
        raise ValueError('SDK manifest is invalid')
    missing = None
    if not source_root:
        # An unset override selects the promoted root; the live checkout is never read implicitly.
        if not layout_root:
            raise ValueError('SDK input missing: the default SDK root needs --layout-root')
        source_root, missing = sdk_default_root(layout_root, version), SDK_DEFAULT_MISSING
    installed = re.fullmatch(r'(\d+\.\d+\.\d+) \(Claude Code\)\s*', Path(version_log).read_text())
    if installed is None or installed[1] != version:
        raise ValueError('SDK version mismatch: refresh engine-written types and reviewed hashes')
    if missing is not None and not Path(source_root).is_dir():
        raise ValueError(missing)
    checked = check_sdk(source_root, mod, packet)
    destination = Path(mod)
    # Read and check every file before writing any; copy the checked bytes, not a second read.
    for relative, data in checked.items():
        target = destination / Path(relative).relative_to(destination.name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    proofs = read_json(proofs_path)
    proofs[destination.name] = {'version': version, 'manifest_sha256': hashlib.sha256(packet_bytes).hexdigest()}
    Path(proofs_path).write_text(json.dumps(proofs, sort_keys=True) + '\n')
    print(json.dumps(proofs[destination.name], sort_keys=True))


def check_sdk(source_root, mod, packet):
    """Read and check one mod's pinned SDK files; return {relative: bytes} and write nothing."""
    version = packet['version']
    source = Path(source_root)
    if not source.is_absolute() or not source.is_dir():
        raise ValueError('SDK input missing: set CLAUDE_MODS_SDK_ROOT to the engine-written mod layout')
    destination = Path(mod)
    prefix = destination.name + '/.claude-plugin/types/'
    names = {'tsconfig.json', 'claude-code/index.d.ts', 'claude-code-tools/index.d.ts', 'claude-code-mcp/index.d.ts'}
    expected = {prefix + name for name in names}
    files = {name: digest for name, digest in packet['files'].items() if name.startswith(prefix)}
    if set(files) != expected:
        raise ValueError(f'SDK manifest does not cover {destination.name}')
    checked = {}
    for relative, digest in files.items():
        path = source / relative
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
        except FileNotFoundError as error:
            raise ValueError(f'SDK input missing: {relative}') from error
        with os.fdopen(fd, 'rb') as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError(f'SDK input is not a regular file: {relative}')
            data = handle.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f'SDK hash mismatch: {relative}')
        checked[relative] = data
    header = checked[prefix + 'claude-code/index.d.ts'].splitlines()[0].decode('utf-8')
    if header != f'// Written by Claude Code {version}.':
        raise ValueError('SDK version mismatch: declaration header differs from the engine')
    return checked


def no_replace_rename():
    """Return a rename that fails with EEXIST instead of replacing, or None when libc lacks one."""
    libc = ctypes.CDLL(None, use_errno=True)
    # macOS renameatx_np(RENAME_EXCL), Linux renameat2(RENAME_NOREPLACE). Never plain rename.
    for name, flag in (('renameatx_np', 0x4), ('renameat2', 0x1)):
        function = getattr(libc, name, None)
        if function is None:
            continue
        function.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        function.restype = ctypes.c_int

        def rename(source_fd, source, target_fd, target, function=function, flag=flag):
            if function(source_fd, os.fsencode(source), target_fd, os.fsencode(target), flag) != 0:
                code = ctypes.get_errno()
                raise OSError(code, os.strerror(code), target)
        return rename
    return None


def open_directory(name, dir_fd=None):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def sdk_tree_matches(parent_fd, name, checked):
    """True only for a real directory tree holding exactly the checked files, byte for byte."""
    expected = {''}
    for relative in checked:
        parts = relative.split('/')[:-1]
        expected.update('/'.join(parts[:index]) for index in range(1, len(parts) + 1))
    found_dirs, found_files = set(), set()

    def walk(fd, prefix):
        found_dirs.add(prefix)
        for entry in os.listdir(fd):
            relative = f'{prefix}/{entry}' if prefix else entry
            mode = os.stat(entry, dir_fd=fd, follow_symlinks=False).st_mode
            if stat.S_ISDIR(mode) and relative in expected:
                child = open_directory(entry, fd)
                try:
                    if not walk(child, relative):
                        return False
                finally:
                    os.close(child)
            elif stat.S_ISREG(mode) and relative in checked:
                handle = os.fdopen(os.open(entry, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd), 'rb')
                with handle:
                    data = handle.read(len(checked[relative]) + 1)
                    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode) or data != checked[relative]:
                        return False
                found_files.add(relative)
            else:
                return False
        return True

    top = open_directory(name, parent_fd)
    try:
        return walk(top, '') and found_dirs == expected and found_files == set(checked)
    finally:
        os.close(top)


def discard_stage(created, sdk_fd, stage, identity):
    """Remove only entries this run created, deepest first, then its own stage directory.

    The stage's identity is checked first: on a mismatch or any error reading it, nothing is removed.
    The stage rmdir is refused when a second identity check just before it fails; that check narrows
    the window but is not atomic with the rmdir.
    """
    try:
        info = os.stat(stage, dir_fd=sdk_fd, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != identity:
            raise ValueError('stage identity changed')
    except (OSError, ValueError) as error:
        left = ', '.join(name for _, name, _ in created) or 'none'
        print(f'land: sdk-promote: left stage {stage} and every entry this run created ({left}): {error}',
              file=sys.stderr)
        return
    for parent_fd, name, is_directory in reversed(created):
        try:
            if is_directory:
                os.rmdir(name, dir_fd=parent_fd)
            else:
                os.unlink(name, dir_fd=parent_fd)
        except OSError as error:
            print(f'land: sdk-promote: could not remove stage entry {name}: {error}', file=sys.stderr)
    # Re-check just before the rmdir: the name may have been swapped during the loop. This narrows
    # the window but is not atomic with the rmdir; the land lock remains the exclusion contract.
    try:
        info = os.stat(stage, dir_fd=sdk_fd, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != identity:
            raise ValueError('stage identity changed')
    except (OSError, ValueError) as error:
        print(f'land: sdk-promote: left stage {stage}: identity not confirmed before its removal: {error}',
              file=sys.stderr)
        return
    try:
        os.rmdir(stage, dir_fd=sdk_fd)
    except OSError as error:
        print(f'land: sdk-promote: left stage {stage}: {error}', file=sys.stderr)


def open_sdk_chain(layout_root, opened):
    """Step 4: return the sdk directory fd, walking by fd and never following or re-moding a component."""
    try:
        parent = opened(layout_root)
    except OSError as error:
        raise ValueError(f'SDK layout root is not a real directory: {error}') from error
    for index, name in enumerate(SDK_PARENTS):
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            created = True
        except FileExistsError:
            created = False
        component = '/'.join(SDK_PARENTS[:index + 1])
        try:
            child = opened(name, parent)
        except OSError as error:
            raise ValueError(f'SDK root path is not a real directory owned by you: {component}') from error
        if os.fstat(child).st_uid != os.getuid():
            raise ValueError(f'SDK root path is not a real directory owned by you: {component}')
        if created:
            os.fchmod(child, 0o700)  # Only a component this run created; defeats the umask.
        parent = child
    return parent


def write_stage(stage_fd, checked, created, opened):
    """Step 6: write the checked bytes into the private stage, recording each entry it creates."""
    directories = {'': stage_fd}
    for relative in sorted(checked):
        parts = relative.split('/')
        for index in range(1, len(parts)):
            path = '/'.join(parts[:index])
            if path not in directories:
                holder = directories['/'.join(parts[:index - 1])]
                os.mkdir(parts[index - 1], 0o700, dir_fd=holder)
                created.append((holder, parts[index - 1], True))
                directories[path] = opened(parts[index - 1], holder)
                os.fchmod(directories[path], 0o700)
        holder = directories['/'.join(parts[:-1])]
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=holder)
        created.append((holder, parts[-1], False))
        with os.fdopen(fd, 'wb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(checked[relative])
            handle.flush()
            os.fsync(handle.fileno())
    for path in sorted(directories, key=len, reverse=True):
        os.fsync(directories[path])


def publish_sdk(layout_root, version, root, checked):
    """Steps 4-8 of sdk-promote; the caller holds the land lock."""
    descriptors = []

    def opened(name, dir_fd=None):
        descriptors.append(open_directory(name, dir_fd))
        return descriptors[-1]

    try:
        sdk_fd = open_sdk_chain(layout_root, opened)
        try:
            existing = os.stat(version, dir_fd=sdk_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            try:
                same = (stat.S_ISDIR(existing.st_mode) and existing.st_uid == os.getuid()
                        and sdk_tree_matches(sdk_fd, version, checked))
            except OSError:
                same = False  # An unreadable or swapped entry is not the checked tree.
            if same:
                print(json.dumps({'version': version, 'root': root, 'status': 'already promoted'}))
                return
            raise ValueError(f'SDK root exists and differs: {root}')
        rename = no_replace_rename()
        if rename is None:
            raise ValueError('no no-replace rename (renameatx_np or renameat2) is available; refusing to publish')
        leftovers = sorted(entry for entry in os.listdir(sdk_fd) if entry.startswith(f'.{version}.stage-'))
        if leftovers:
            print(f'land: sdk-promote: leaving foreign stage entries untouched: {", ".join(leftovers)}', file=sys.stderr)
        stage = os.path.basename(tempfile.mkdtemp(prefix=f'.{version}.stage-', dir=os.path.join(layout_root, *SDK_PARENTS)))
        info = os.stat(stage, dir_fd=sdk_fd, follow_symlinks=False)
        identity = (info.st_dev, info.st_ino)
        created, published = [], False
        try:
            stage_fd = opened(stage, sdk_fd)
            if (os.fstat(stage_fd).st_dev, os.fstat(stage_fd).st_ino) != identity:
                raise ValueError(f'SDK stage changed while it was opened: {stage}')
            write_stage(stage_fd, checked, created, opened)
            try:
                rename(sdk_fd, stage, sdk_fd, version)
            except FileExistsError as error:
                raise ValueError(f'SDK root exists and differs: {root}') from error
            published = True
            os.fsync(sdk_fd)
        except BaseException:
            if not published:
                discard_stage(created, sdk_fd, stage, identity)
            raise
        print(json.dumps({'version': version, 'root': root}))
    finally:
        for fd in descriptors:
            os.close(fd)


def sdk_promote(capture_root, manifest, layout_root):
    """plan:105: publish a checked capture as the stable root for its pinned version; never replace one."""
    packet = json.loads(Path(manifest).read_bytes())
    files = packet.get('files')
    if packet.get('v') != 1 or not isinstance(files, dict) or not files:
        raise ValueError('SDK manifest is invalid')
    if not os.path.isabs(layout_root):
        raise ValueError('SDK layout root must be absolute')
    root = sdk_default_root(layout_root, packet.get('version'))
    mods = sorted({name.split('/', 1)[0] for name in files})
    if any(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', mod) is None for mod in mods):
        raise ValueError('SDK manifest is invalid')
    # Hold every checked byte in memory before any destination work.
    checked = {}
    for mod in mods:
        checked.update(check_sdk(capture_root, mod, packet))
    if set(checked) != set(files):
        raise ValueError('SDK manifest is invalid')
    # The land lock, before any destination mkdir: promotion and landing exclude each other.
    lock = os.path.join(layout_root, '.claude', 'state', 'claude-mods-land.lock')
    pid = os.getpid()
    acquire_lock(lock, pid)
    try:
        publish_sdk(layout_root, packet['version'], root, checked)
    finally:
        release_lock(lock, pid)


IDENTITY_MODULE = 'hooks/build-identity.ts'


def source_fingerprint(repo, mod):
    """Failure-intake D1: sha256 over the sorted (path, sha256) list of the mod's tracked files, its identity module excluded."""
    listed = subprocess.run(['git', '-C', repo, 'ls-files', '-z', '--', mod], check=True, capture_output=True).stdout
    excluded = f'{mod}/{IDENTITY_MODULE}'
    paths = sorted(p for p in listed.decode().split('\0') if p and p != excluded)
    lines = ''.join(f'{p}\0{hashlib.sha256(Path(repo, p).read_bytes()).hexdigest()}\n' for p in paths)
    return hashlib.sha256(lines.encode()).hexdigest()


def identity_generate(repo, mod, source_base):
    """Writes the mod's build identity module; source_base is the commit the candidate branched from, never the deployed one."""
    if re.fullmatch(r'[0-9a-f]{40}', source_base) is None:
        raise ValueError('source base must be a full commit id')
    fingerprint = source_fingerprint(repo, mod)
    generated_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    Path(repo, mod, IDENTITY_MODULE).write_text(
        '// GENERATED by scripts/land-state.py identity generate; never edit by hand.\n'
        f"export const BUILD_IDENTITY = {{ v: 1, source_fingerprint: '{fingerprint}', "
        f"source_base: '{source_base}', generated_at: '{generated_at}' }}\n"
    )
    print(fingerprint)


def prepare_receipt(path, commit, previous, mods, log_dir, sdk=None):
    if Path(path).exists():
        prior = read_json(path)
        if prior.get('commit') == commit:
            previous = prior['previous_commit']
    receipt = {
        'commit': commit,
        'previous_commit': previous,
        'deployed_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'mods': read_json(mods),
        'log_dir': log_dir,
    }
    if sdk is not None:
        receipt['sdk'] = read_json(sdk)
    print(json.dumps(receipt, indent=2, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('lock', 'unlock'):
        child = commands.add_parser(name)
        child.add_argument('path')
        child.add_argument('pid', type=int)
    child = commands.add_parser('run')
    child.add_argument('seconds', type=int)
    child.add_argument('argv', nargs=argparse.REMAINDER)
    child = commands.add_parser('counts')
    for field in ('log', 'name', 'path'):
        child.add_argument(field)
    child = commands.add_parser('receipt')
    for field in ('path', 'commit', 'previous', 'mods', 'log_dir'):
        child.add_argument(field)
    child.add_argument('--sdk')
    child = commands.add_parser('sdk')
    for field in ('source_root', 'mod', 'manifest', 'version_log', 'proofs_path'):
        child.add_argument(field)
    child.add_argument('--layout-root')
    child = commands.add_parser('sdk-promote')
    for field in ('capture_root', 'manifest', 'layout_root'):
        child.add_argument(field)
    identity = commands.add_parser('identity').add_subparsers(dest='action', required=True)
    child = identity.add_parser('generate')
    for field in ('repo', 'mod', 'source_base'):
        child.add_argument(field)
    args = parser.parse_args()
    try:
        if args.command == 'lock':
            acquire_lock(args.path, args.pid)
        elif args.command == 'unlock':
            release_lock(args.path, args.pid)
        elif args.command == 'run':
            return run_bounded(args.seconds, args.argv)
        elif args.command == 'counts':
            record_counts(args.log, args.name, args.path)
        elif args.command == 'sdk':
            prepare_sdk(args.source_root, args.mod, args.manifest, args.version_log, args.proofs_path, args.layout_root)
        elif args.command == 'sdk-promote':
            sdk_promote(args.capture_root, args.manifest, args.layout_root)
        elif args.command == 'identity':
            identity_generate(args.repo, args.mod, args.source_base)
        else:
            prepare_receipt(args.path, args.commit, args.previous, args.mods, args.log_dir, args.sdk)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.CalledProcessError) as error:
        print(f'land: {args.command}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
