#!/usr/bin/env python3
"""Private land.sh helpers: owner-safe locks, bounded processes and JSON receipts."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socket
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
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        print(f'land: command interrupted or exceeded {seconds}s: {argv[0]}', file=sys.stderr)
        return 130 if sys.exc_info()[0] is KeyboardInterrupt else 1


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


def prepare_receipt(path, commit, previous, mods, log_dir):
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
        else:
            prepare_receipt(args.path, args.commit, args.previous, args.mods, args.log_dir)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print(f'land: {args.command}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
