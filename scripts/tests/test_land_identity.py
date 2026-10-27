"""FIXTURE tests for `land-state.py identity generate` (failure-intake D1, ruling Q64): the build identity of a mod tree."""
import hashlib
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/land-state.py'
IDENTITY = 'track/hooks/build-identity.ts'
MODULE = re.compile(
    r"export const BUILD_IDENTITY = \{ v: 1, source_fingerprint: '([0-9a-f]{64})', "
    r"source_base: '([0-9a-f]{40})', generated_at: '(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)' \}\n"
)


def git(repo, *argv):
    return subprocess.run(['git', '-C', str(repo), *argv], check=True, capture_output=True, text=True).stdout.strip()


def expected_fingerprint(repo):
    """D1 restated independently: sha256 over the sorted (path, sha256) list of tracked track/ files, the identity module excluded."""
    paths = sorted(p for p in git(repo, 'ls-files', '-z', '--', 'track').split('\0') if p and p != IDENTITY)
    lines = ''.join(f'{p}\0{hashlib.sha256((repo / p).read_bytes()).hexdigest()}\n' for p in paths)
    return hashlib.sha256(lines.encode()).hexdigest()


class IdentityGenerateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        git(self.repo, 'init', '-q')
        for path, text in {'track/hooks/register.tsx': 'one\n', 'track/tests/a.test.ts': 'two\n', 'other/x.ts': 'three\n'}.items():
            (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / path).write_text(text)
        git(self.repo, 'add', '-A')
        git(self.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
        self.base = git(self.repo, 'rev-parse', 'HEAD')

    def generate(self):
        return subprocess.run([sys.executable, str(HELPER), 'identity', 'generate', str(self.repo), 'track', self.base],
                              capture_output=True, text=True)

    def written(self):
        match = MODULE.fullmatch((self.repo / IDENTITY).read_text().split('\n', 1)[1])
        self.assertIsNotNone(match, 'the module is one generated-comment line, then the BUILD_IDENTITY export')
        return match

    def test_writes_the_fingerprint_of_the_tracked_tree_and_the_source_base(self):
        result = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        fingerprint, base, _ = self.written().groups()
        self.assertEqual(fingerprint, expected_fingerprint(self.repo))
        self.assertEqual(base, self.base)

    def test_the_identity_module_itself_untracked_files_and_other_mods_do_not_count(self):
        self.assertEqual(self.generate().returncode, 0)
        first = self.written()[1]
        git(self.repo, 'add', IDENTITY)
        (self.repo / 'track/untracked.ts').write_text('ignored\n')
        (self.repo / 'other/x.ts').write_text('changed\n')
        self.assertEqual(self.generate().returncode, 0)
        self.assertEqual(self.written()[1], first)

    def test_a_tracked_byte_change_changes_the_fingerprint(self):
        self.assertEqual(self.generate().returncode, 0)
        first = self.written()[1]
        (self.repo / 'track/tests/a.test.ts').write_text('two!\n')
        self.assertEqual(self.generate().returncode, 0)
        self.assertNotEqual(self.written()[1], first)
        self.assertEqual(self.written()[1], expected_fingerprint(self.repo))


if __name__ == '__main__':
    unittest.main()
