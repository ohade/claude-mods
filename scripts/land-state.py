#!/usr/bin/env python3
"""Private land.sh helpers: owner-safe locks, bounded processes and JSON receipts."""
import argparse
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


def prepare_sdk(source_root, mod, manifest, version_log, proofs_path):
    """Copy only pinned engine-written inputs, never a hand-written API substitute."""
    packet_bytes = Path(manifest).read_bytes()
    packet = json.loads(packet_bytes)
    version = packet.get('version')
    if packet.get('v') != 1 or not isinstance(version, str) or not isinstance(packet.get('files'), dict):
        raise ValueError('SDK manifest is invalid')
    installed = re.fullmatch(r'(\d+\.\d+\.\d+) \(Claude Code\)\s*', Path(version_log).read_text())
    if installed is None or installed[1] != version:
        raise ValueError('SDK version mismatch: refresh engine-written types and reviewed hashes')
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
    # Read and check every file before writing any; copy the checked bytes, not a second read.
    for relative, data in checked.items():
        target = destination / Path(relative).relative_to(destination.name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    proofs = read_json(proofs_path)
    proofs[destination.name] = {'version': version, 'manifest_sha256': hashlib.sha256(packet_bytes).hexdigest()}
    Path(proofs_path).write_text(json.dumps(proofs, sort_keys=True) + '\n')
    print(json.dumps(proofs[destination.name], sort_keys=True))


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
            prepare_sdk(args.source_root, args.mod, args.manifest, args.version_log, args.proofs_path)
        else:
            prepare_receipt(args.path, args.commit, args.previous, args.mods, args.log_dir, args.sdk)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print(f'land: {args.command}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
