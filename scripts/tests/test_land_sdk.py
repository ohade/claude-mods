"""FIXTURE: a cold landing uses checked SDK input; fake native CLI, real local Git/npm.

2026-10-20: native test/validate omitted generated types, so a healthy cold tree
failed typecheck. These declarations test provisioning only, not the engine API.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


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
        self.git('checkout', '-b', 'fixture-main')
        self.git('branch', '-m', 'main')
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


if __name__ == '__main__':
    unittest.main()
