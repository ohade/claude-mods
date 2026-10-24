"""FIXTURE: a cold landing uses checked SDK input; fake native CLI, real local Git/npm.

2026-10-20: native test/validate omitted generated types, so a healthy cold tree
failed typecheck. These declarations test provisioning only, not the engine API.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import tempfile
import time
import unittest
import contextlib
import errno
import importlib.util
import io
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
VERSION = '2.1.304'
DECLARATION = f'// Written by Claude Code {VERSION}.\n// FIXTURE: not engine API declarations.\n'


class SdkLandingTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repo = self.root / 'git/claude-mods'
        self.live = self.root / 'git/worktrees/claude-mods/live'
        self.sdk = self.root / 'sdk'
        self.state = self.root / '.claude/state'
        self.state.mkdir(parents=True)
        self.sut = self.root / 'sut'
        self.sut.mkdir()
        for name in ('land.sh', 'land-state.py'):
            shutil.copy2(ROOT / 'scripts' / name, self.sut / name)
        origin = self.root / 'origin.git'
        # Clone rather than depending on an empty fixture repository installed globally.
        self.run_command('git', 'clone', '--bare', '--single-branch', str(ROOT), str(origin))
        self.run_command('git', 'clone', str(origin), str(self.repo))
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        if self.git('branch', '--list', 'main').stdout.strip():
            self.git('checkout', 'main')
        else:
            self.git('checkout', '-b', 'main')
        # Only this disposable clone is replaced with the minimal test world.
        self.git('rm', '-r', '--', '.')
        mod = self.repo / 'track'
        (mod / '.claude-plugin').mkdir(parents=True)
        (mod / 'tests').mkdir()
        (mod / '.claude-plugin/plugin.json').write_text('{}')
        (mod / 'tests/input').write_text('fixture\n')
        (mod / 'tsconfig.json').write_text(json.dumps({'extends': './.claude-plugin/types/tsconfig.json'}))
        package = {'name': 'sdk-fixture', 'version': '1.0.0', 'private': True,
                   'scripts': {'typecheck': 'node verify-sdk.cjs'}}
        (mod / 'package.json').write_text(json.dumps(package))
        (mod / 'package-lock.json').write_text(json.dumps({
            'name': 'sdk-fixture', 'version': '1.0.0', 'lockfileVersion': 3,
            'packages': {'': {'name': 'sdk-fixture', 'version': '1.0.0'}},
        }))
        (mod / 'verify-sdk.cjs').write_text(
            "const fs = require('node:fs'); const assert = require('node:assert/strict');\n"
            "const path = '.claude-plugin/types/claude-code/index.d.ts';\n"
            "assert(fs.existsSync(path), 'checked SDK input must initialise the cold tree');\n"
            f"assert.equal(fs.readFileSync(path, 'utf8'), {json.dumps(DECLARATION)});\n"
        )
        files = {}
        for name, contents in {
            'tsconfig.json': '{}\n', 'claude-code/index.d.ts': DECLARATION,
            'claude-code-tools/index.d.ts': '// FIXTURE built-in tool types\n',
            'claude-code-mcp/index.d.ts': '// FIXTURE MCP tool types\n',
        }.items():
            relative = f'track/.claude-plugin/types/{name}'
            path = self.sdk / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.manifest = self.sut / 'sdk-types.json'
        self.manifest.write_text(json.dumps({'v': 1, 'version': VERSION, 'files': files}))
        self.git('add', '.')
        self.git('commit', '-qm', 'SDK landing fixture base')
        self.base = self.git('rev-parse', 'HEAD').stdout.strip()
        self.run_command('git', '-C', str(self.repo), 'worktree', 'add', '--detach', str(self.live), self.base)
        self.git('checkout', '-b', 'fixture-candidate')
        (self.repo / 'candidate').write_text('candidate\n')
        self.git('add', 'candidate')
        self.git('commit', '-qm', 'SDK landing fixture candidate')
        self.target = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('checkout', 'main')
        self.receipt = self.state / 'claude-mods-live.json'
        self.receipt.write_text(json.dumps({'commit': self.base, 'previous_commit': self.base}))
        self.before_receipt = self.receipt.read_bytes()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        cli = self.bin / 'claude'
        cli.write_text(
            '#!/bin/bash\nset -euo pipefail\n'
            'if [ "$1" = --version ]; then printf "%s (Claude Code)\\n" "${FIXTURE_ENGINE_VERSION:-2.1.304}"; exit 0; fi\n'
            '[ "$1" = plugin ] && [ "$2" = test ]\n'
            'printf "3 passed, 0 failed\\n"\n'
        )
        cli.chmod(0o700)
        self.env = dict(os.environ, CLAUDE_MODS_HOME=str(self.root),
                        CLAUDE_MODS_SDK_ROOT=str(self.sdk), PATH=f'{self.bin}:{os.environ["PATH"]}')

    def run_command(self, *argv):
        return subprocess.run(argv, capture_output=True, text=True, check=True, timeout=30)

    def git(self, *argv):
        return self.run_command('git', '-C', str(self.repo), *argv)

    def land(self):
        return subprocess.run(['bash', str(self.sut / 'land.sh'), self.target],
                              env=self.env, capture_output=True, text=True, timeout=60)

    def assert_refused(self, message):
        result = self.land()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').stdout.strip(), self.base)
        self.assertEqual(self.run_command('git', '-C', str(self.live), 'rev-parse', 'HEAD').stdout.strip(), self.base)
        self.assertEqual(self.receipt.read_bytes(), self.before_receipt)
        logs = '\n'.join(path.read_text() for path in self.state.glob('claude-mods-land-logs.*/track-sdk.log'))
        self.assertIn(message, logs, result.stderr)

    def test_checked_sdk_initialises_a_healthy_cold_tree(self):
        result = self.land()
        self.assertEqual(result.returncode, 0, 'checked SDK input must enable a healthy cold landing:\n' + result.stderr)
        proof = json.loads(self.receipt.read_text())['sdk']['track']
        self.assertEqual(proof['version'], VERSION)
        self.assertEqual(proof['manifest_sha256'], hashlib.sha256(self.manifest.read_bytes()).hexdigest())
        self.assertEqual(self.git('rev-parse', 'HEAD').stdout.strip(), self.target)

    def test_changed_sdk_bytes_are_refused(self):
        (self.sdk / 'track/.claude-plugin/types/claude-code-tools/index.d.ts').write_text('// altered\n')
        self.assert_refused('SDK hash mismatch')

    def test_engine_version_mismatch_is_refused(self):
        self.env['FIXTURE_ENGINE_VERSION'] = '2.1.305'
        self.assert_refused('SDK version mismatch')

    def test_missing_sdk_is_refused(self):
        self.env['CLAUDE_MODS_SDK_ROOT'] = str(self.root / 'missing')
        self.assert_refused('SDK input missing')

    # plan:105 (2026-10-24): an unset override read stale types from live, so every landing
    # needed a hand-typed root. The default is now a promoted root per pinned version.
    @property
    def default_root(self):
        return self.root / '.local/share/claude-mods/sdk' / VERSION

    def put_capture(self, target, header=VERSION, altered=False):
        shutil.copytree(self.sdk, target)
        types = Path(target) / 'track/.claude-plugin/types'
        if header != VERSION:
            (types / 'claude-code/index.d.ts').write_text(DECLARATION.replace(VERSION, header))
        if altered:
            (types / 'claude-code-tools/index.d.ts').write_text('// altered\n')
        return Path(target)

    def put_live_types(self, header):
        # Ignored like generated types, so a refusal cannot come from the dirty-live preflight.
        exclude = self.repo / '.git/info/exclude'
        exclude.parent.mkdir(exist_ok=True)
        with exclude.open('a') as handle:
            handle.write('track/.claude-plugin/types/\n')
        types = self.live / 'track/.claude-plugin/types'
        shutil.copytree(self.sdk / 'track/.claude-plugin/types', types)
        if header != VERSION:
            (types / 'claude-code/index.d.ts').write_text(DECLARATION.replace(VERSION, header))
        status = self.run_command('git', '-C', str(self.live), 'status', '--porcelain', '-uall').stdout
        self.assertEqual(status, '', 'fixture: live types must not dirty the live checkout')

    def assert_landed(self, result, why):
        self.assertEqual(result.returncode, 0, why + '\n' + result.stderr)
        proof = json.loads(self.receipt.read_text())['sdk']['track']
        self.assertEqual(proof, {'version': VERSION,
                                 'manifest_sha256': hashlib.sha256(self.manifest.read_bytes()).hexdigest()})
        self.assertEqual(self.git('rev-parse', 'HEAD').stdout.strip(), self.target)

    def assert_refused_alone(self, message):
        """Like assert_refused, but reads only the logs of this landing."""
        before = set(self.state.glob('claude-mods-land-logs.*'))
        result = self.land()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').stdout.strip(), self.base)
        self.assertEqual(self.run_command('git', '-C', str(self.live), 'rev-parse', 'HEAD').stdout.strip(), self.base)
        self.assertEqual(self.receipt.read_bytes(), self.before_receipt)
        logs = '\n'.join(path.read_text() for directory in set(self.state.glob('claude-mods-land-logs.*')) - before
                         for path in directory.glob('track-sdk.log'))
        self.assertIn(message, logs, result.stderr)

    def promote(self, capture=None, manifest=None):
        return subprocess.run(['python3', str(self.sut / 'land-state.py'), 'sdk-promote', str(capture or self.sdk),
                               str(manifest or self.manifest), str(self.root)],
                              capture_output=True, text=True, timeout=30)

    def assert_promote_refused(self, result, message):
        # Exit 1 with the helper's prefix; an argparse usage error (exit 2) is not a refusal.
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('land: sdk-promote: ', result.stderr)
        self.assertIn(message, result.stderr)

    def snapshot(self, base, times=False):
        """Inode, mode and content of every path under base; directory mtimes only when asked."""
        base = str(base)
        if not os.path.lexists(base):
            return None
        entries = {}

        def record(path):
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode):
                content = os.readlink(path)
            elif stat.S_ISREG(info.st_mode):
                content = Path(path).read_bytes()
            else:
                content = None
            mtime = info.st_mtime_ns if times or not stat.S_ISDIR(info.st_mode) else None
            entries[os.path.relpath(path, base)] = (info.st_ino, info.st_mode, content, mtime)

        record(base)
        if os.path.isdir(base) and not os.path.islink(base):
            for directory, dirs, files in os.walk(base):
                for name in dirs + files:
                    record(os.path.join(directory, name))
        return entries

    def stages(self):
        parent = self.default_root.parent
        if not parent.is_dir():
            return []
        return sorted(path.name for path in parent.iterdir() if path.name.startswith(f'.{VERSION}.stage-'))

    def assert_promoted(self):
        root = self.default_root
        self.assertFalse(root.is_symlink())
        found = {}
        for directory, dirs, files in os.walk(root):
            self.assertEqual(stat.S_IMODE(os.lstat(directory).st_mode), 0o700, directory)
            for name in files:
                path = Path(directory) / name
                self.assertTrue(stat.S_ISREG(path.lstat().st_mode), path)
                self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o600, path)
                found[str(path.relative_to(root))] = path.read_bytes()
        expected = {str(path.relative_to(self.sdk)): path.read_bytes() for path in self.sdk.rglob('*') if path.is_file()}
        self.assertEqual(len(expected), 4)
        self.assertEqual(found, expected)

    def test_d1_default_root_lands_without_reading_stale_live(self):
        self.env.pop('CLAUDE_MODS_SDK_ROOT')
        self.put_capture(self.default_root)
        self.put_live_types(header='2.1.303')
        self.assert_landed(self.land(), 'D1: an unset override must land from the promoted default root, not stale live')

    def test_d2_live_is_never_an_implicit_fallback(self):
        self.env.pop('CLAUDE_MODS_SDK_ROOT')
        self.put_live_types(header=VERSION)
        self.assertFalse(self.default_root.exists())
        self.assert_refused_alone('SDK input missing: promote a capture')

    def test_d3_explicit_bad_input_never_falls_back(self):
        self.put_capture(self.default_root)
        self.env['CLAUDE_MODS_SDK_ROOT'] = str(self.put_capture(self.root / 'stale', header='2.1.303'))
        self.assert_refused_alone('SDK hash mismatch')

    def test_d4_explicit_good_input_wins_over_altered_default(self):
        self.put_capture(self.default_root, altered=True)
        self.assert_landed(self.land(), 'D4: a healthy explicit input must win over the default root')

    def test_d5_stale_default_root_is_refused(self):
        self.env.pop('CLAUDE_MODS_SDK_ROOT')
        self.put_capture(self.default_root, altered=True)
        self.assert_refused_alone('SDK hash mismatch')

    def test_d6_invalid_manifest_version_builds_no_path(self):
        self.env.pop('CLAUDE_MODS_SDK_ROOT')
        packet = json.loads(self.manifest.read_text())
        for version in ('2.1.304/../x', '../x', '2.1'):
            with self.subTest(version=version):
                self.manifest.write_text(json.dumps(dict(packet, version=version)))
                self.assert_refused_alone('SDK manifest is invalid')
                self.assertFalse(os.path.lexists(self.root / '.local'))

    def test_p1_promotion_publishes_exact_private_root(self):
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'version': VERSION, 'root': str(self.default_root)})
        self.assert_promoted()
        for path in ('.local', '.local/share', '.local/share/claude-mods', '.local/share/claude-mods/sdk'):
            self.assertEqual(stat.S_IMODE((self.root / path).lstat().st_mode), 0o700, path)
        self.assertEqual(self.stages(), [])
        self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock'))

    def test_p2_identical_promotion_is_idempotent(self):
        self.assertEqual(self.promote().returncode, 0)
        before = self.snapshot(self.root / '.local', times=True)
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('already promoted', result.stdout)
        self.assertEqual(self.snapshot(self.root / '.local', times=True), before)

    def test_p3_different_existing_root_is_refused(self):
        self.put_capture(self.default_root, altered=True)
        before = self.snapshot(self.root / '.local')
        self.assert_promote_refused(self.promote(), 'SDK root exists and differs')
        self.assertEqual(self.snapshot(self.root / '.local'), before)
        self.assertEqual(self.stages(), [])

    def test_p4_bad_capture_is_refused_before_any_write(self):
        altered = self.put_capture(self.root / 'capture-altered', altered=True)
        header = self.put_capture(self.root / 'capture-header', header='2.1.303')
        header_manifest = self.root / 'header-manifest.json'
        header_manifest.write_text(json.dumps({'v': 1, 'version': VERSION, 'files': {
            str(path.relative_to(header)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in header.rglob('*') if path.is_file()}}))
        linked = self.put_capture(self.root / 'capture-symlink')
        tools = linked / 'track/.claude-plugin/types/claude-code-tools/index.d.ts'
        outside = self.root / 'outside-tools.d.ts'
        outside.write_bytes(tools.read_bytes())
        tools.unlink()
        tools.symlink_to(outside)
        for name, capture, manifest, message in (
                ('altered', altered, None, 'SDK hash mismatch'),
                ('header', header, header_manifest, 'declaration header differs'),
                ('symlink', linked, None, 'claude-code-tools/index.d.ts')):
            with self.subTest(name):
                self.assert_promote_refused(self.promote(capture, manifest), message)
                self.assertFalse(os.path.lexists(self.root / '.local'))
                self.assertFalse(os.path.lexists(self.default_root))
                self.assertEqual(self.stages(), [])

    def test_p5_symlink_or_empty_target_is_refused(self):
        self.default_root.parent.mkdir(parents=True)
        identical = self.put_capture(self.root / 'identical')
        self.default_root.symlink_to(identical)
        before, target = self.snapshot(self.root / '.local'), self.snapshot(identical)
        self.assert_promote_refused(self.promote(), 'SDK root exists and differs')
        self.assertEqual(self.snapshot(self.root / '.local'), before)
        self.assertEqual(self.snapshot(identical), target)
        self.default_root.unlink()
        self.default_root.mkdir()
        before = self.snapshot(self.root / '.local')
        self.assert_promote_refused(self.promote(), 'SDK root exists and differs')
        self.assertEqual(self.snapshot(self.root / '.local'), before)
        self.assertEqual(list(self.default_root.iterdir()), [])
        self.assertEqual(self.stages(), [])

    def test_p6_symlinked_ancestor_and_foreign_stages(self):
        (self.root / '.local/share').mkdir(parents=True)
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        (self.root / '.local/share/claude-mods').symlink_to(elsewhere)
        before = self.snapshot(self.root / '.local')
        self.assert_promote_refused(self.promote(), 'not a real directory owned by you')
        self.assertEqual(self.snapshot(self.root / '.local'), before)
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock'))
        (self.root / '.local/share/claude-mods').unlink()
        parent = self.default_root.parent
        parent.mkdir(parents=True)
        (parent / f'.{VERSION}.stage-x').mkdir()
        (parent / f'.{VERSION}.stage-x/marker').write_text('foreign\n')
        (parent / f'.{VERSION}.stage-link').symlink_to(elsewhere)
        leftovers = {name: self.snapshot(parent / name) for name in (f'.{VERSION}.stage-x', f'.{VERSION}.stage-link')}
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_promoted()
        self.assertEqual({name: self.snapshot(parent / name) for name in leftovers}, leftovers)
        self.assertEqual(self.stages(), sorted(leftovers))
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_p7_existing_parent_modes_are_kept(self):
        (self.root / '.local').mkdir()
        (self.root / '.local').chmod(0o755)
        (self.root / '.local/share').mkdir()
        (self.root / '.local/share').chmod(0o750)
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE((self.root / '.local').lstat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.root / '.local/share').lstat().st_mode), 0o750)
        for path in ('.local/share/claude-mods', '.local/share/claude-mods/sdk'):
            self.assertEqual(stat.S_IMODE((self.root / path).lstat().st_mode), 0o700, path)
        self.assert_promoted()

    def test_p8_concurrent_same_version_promotions(self):
        argv = ['python3', str(self.sut / 'land-state.py'), 'sdk-promote', str(self.sdk), str(self.manifest), str(self.root)]
        runs = [subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        results = []
        for run in runs:
            stdout, stderr = run.communicate(timeout=30)
            results.append((run.returncode, stdout, stderr))
        publishers = [item for item in results if item[0] == 0 and 'already promoted' not in item[1]]
        self.assertEqual(len(publishers), 1, results)
        other = next(item for item in results if item is not publishers[0])
        self.assertTrue((other[0] == 0 and 'already promoted' in other[1])
                        or (other[0] == 1 and 'lock held at' in other[2]), other)
        self.assert_promoted()
        self.assertEqual(self.stages(), [])
        self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock'))

    def test_p9_promotion_refuses_a_held_land_lock(self):
        lock = self.state / 'claude-mods-land.lock'
        lock.mkdir()
        (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid(), 'created_at': time.time(),
                                                     'host': socket.gethostname()}) + '\n')
        before = self.snapshot(lock)
        self.assert_promote_refused(self.promote(), 'lock held at')
        self.assertFalse(os.path.lexists(self.root / '.local'))
        self.assertEqual(self.snapshot(lock), before)
        self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock.reclaim'))

    # plan:105 r1 (2026-10-25): pins for paths the tests above never reach. Faults are injected
    # in-process into this test's own copy of the helper; no sleeps, no timing races.
    def load_helper(self):
        spec = importlib.util.spec_from_file_location('land_state_under_test', self.sut / 'land-state.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def promote_in_process(self, module):
        """Run sdk-promote in-process; return (exception or None, stderr text)."""
        stderr = io.StringIO()
        error = None
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
            try:
                module.sdk_promote(str(self.sdk), str(self.manifest), str(self.root))
            except (OSError, ValueError) as caught:
                error = caught
        return error, stderr.getvalue()

    def own_stage(self, foreign):
        names = [name for name in self.stages() if name not in foreign]
        self.assertEqual(len(names), 1, f'fixture: exactly one run stage expected, found {names}')
        return self.default_root.parent / names[0]

    def failing_fsync(self, on_call, before_raise=None):
        real, calls = os.fsync, []

        def fsync(fd):
            calls.append(fd)
            if len(calls) == on_call:
                if before_raise is not None:
                    before_raise()
                raise OSError(errno.EIO, os.strerror(errno.EIO))
            return real(fd)
        return fsync

    def test_c1a_failed_stage_removes_only_its_own_entries(self):
        parent = self.default_root.parent
        parent.mkdir(parents=True)
        (parent / f'.{VERSION}.stage-x').mkdir()
        (parent / f'.{VERSION}.stage-x/marker').write_text('foreign\n')
        (parent / f'.{VERSION}.stage-y').symlink_to(self.root / 'elsewhere')
        foreign = {name: self.snapshot(parent / name) for name in (f'.{VERSION}.stage-x', f'.{VERSION}.stage-y')}
        module, seen = self.load_helper(), {}

        def observe():
            stage = self.own_stage(foreign)
            seen['stage'] = stage
            entries = list(stage.rglob('*'))
            seen['has_dir'] = any(path.is_dir() and not path.is_symlink() for path in entries)
            seen['has_file'] = any(path.is_file() and not path.is_symlink() for path in entries)

        with mock.patch.object(module.os, 'fsync', self.failing_fsync(2, observe)):
            error, stderr = self.promote_in_process(module)
        self.assertIsInstance(error, OSError, stderr)
        self.assertEqual(error.errno, errno.EIO)
        self.assertTrue(seen['has_dir'], 'fixture: a subdirectory must exist before the failure')
        self.assertTrue(seen['has_file'], 'fixture: a file must exist before the failure')
        self.assertFalse(os.path.lexists(seen['stage']), 'C1a: the run must remove its own stage')
        self.assertEqual({name: self.snapshot(parent / name) for name in foreign}, foreign, 'C1a: foreign stages kept')
        self.assertEqual(self.stages(), sorted(foreign))
        self.assertFalse(os.path.lexists(self.default_root))
        self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock'))

    def test_c1b_swapped_stage_identity_removes_nothing(self):
        module, seen = self.load_helper(), {}

        def swap():
            stage = self.own_stage(set())
            side = self.root / 'moved-original-stage'
            os.rename(stage, side)
            stage.mkdir()
            (stage / 'replacement').write_text('not this run\n')
            seen.update(stage=stage, side=side, created=self.snapshot(side), replacement=self.snapshot(stage))

        with mock.patch.object(module.os, 'fsync', self.failing_fsync(2, swap)):
            error, stderr = self.promote_in_process(module)
        self.assertIsInstance(error, OSError, stderr)
        self.assertGreater(len(seen['created']), 2, 'fixture: the run must have created entries')
        self.assertEqual(self.snapshot(seen['side']), seen['created'],
                         'C1b: created entries preserved: a stage whose identity changed must lose nothing')
        self.assertEqual(self.snapshot(seen['stage']), seen['replacement'], 'C1b: the replacement is untouched')
        self.assertIn('identity', stderr)
        self.assertFalse(os.path.lexists(self.default_root))
        self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock'))

    def test_c2_publish_race_never_replaces_a_new_root(self):
        module, seen = self.load_helper(), {}
        real = module.no_replace_rename()
        self.assertIsNotNone(real, 'fixture: this platform needs a no-replace rename')

        def racing(source_fd, source, target_fd, target):
            os.mkdir(target, 0o700, dir_fd=target_fd)
            seen['inode'] = os.stat(target, dir_fd=target_fd, follow_symlinks=False).st_ino
            return real(source_fd, source, target_fd, target)

        with mock.patch.object(module, 'no_replace_rename', lambda: racing):
            error, stderr = self.promote_in_process(module)
        self.assertIsInstance(error, ValueError, stderr)
        self.assertIn('SDK root exists and differs', str(error))
        self.assertEqual(self.default_root.lstat().st_ino, seen['inode'])
        self.assertTrue(stat.S_ISDIR(self.default_root.lstat().st_mode))
        self.assertEqual(list(self.default_root.iterdir()), [])
        self.assertEqual(self.stages(), [])
        self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock'))

    def test_c3_promotion_validates_the_manifest_version(self):
        packet = json.loads(self.manifest.read_text())
        for version in ('../x', '2.1', '2.1.304/../x', '2.1.304\n'):
            with self.subTest(version=version):
                self.manifest.write_text(json.dumps(dict(packet, version=version)))
                self.assert_promote_refused(self.promote(), 'SDK manifest is invalid')
                self.assertFalse(os.path.lexists(self.root / '.local'))
                self.assertFalse(os.path.lexists(self.state / 'claude-mods-land.lock'))

    def test_c4_default_path_checks_the_engine_first(self):
        self.env.pop('CLAUDE_MODS_SDK_ROOT')
        self.env['FIXTURE_ENGINE_VERSION'] = '2.1.305'
        self.assertFalse(os.path.lexists(self.default_root))
        self.assert_refused_alone('SDK version mismatch')
        logs = '\n'.join(path.read_text() for path in self.state.glob('claude-mods-land-logs.*/track-sdk.log'))
        self.assertNotIn('SDK input missing', logs)


if __name__ == '__main__':
    unittest.main()
