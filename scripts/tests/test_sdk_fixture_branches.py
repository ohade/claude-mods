"""FIXTURE: the SDK harness must accept main and topic source repositories.

2026-10-25: renaming fixture-main collided with main copied from the source.
The existing healthy landing case still uses real temporary Git/npm.
"""
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]


class FixtureResult(unittest.TextTestResult):
    def addError(self, test, error):
        super().addError(test, error)
        # The harness captures command stderr; retain it beside the traceback.
        stderr = getattr(error[1], 'stderr', None)
        if stderr:
            self.stream.writeln(stderr)


class SdkFixtureBranchesTest(unittest.TestCase):
    def assert_source_compatible(self, source_branch):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            (source / 'scripts').mkdir(parents=True)
            for name in ('land.sh', 'land-state.py'):
                shutil.copy2(ROOT / 'scripts' / name, source / 'scripts' / name)

            def git(*argv):
                return subprocess.run(['git', '-C', str(source), *argv], check=True,
                                      capture_output=True, text=True, timeout=30)

            git('init', '-b', 'main')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            git('add', 'scripts/land.sh', 'scripts/land-state.py')
            git('commit', '-qm', 'SDK fixture source')
            if source_branch != 'main':
                git('checkout', '-b', source_branch)

            spec = importlib.util.spec_from_file_location(
                'sdk_landing_under_test', ROOT / 'scripts/tests/test_land_sdk.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            case = module.SdkLandingTest('test_checked_sdk_initialises_a_healthy_cold_tree')
            output = io.StringIO()
            with mock.patch.object(module, 'ROOT', source):
                result = unittest.TextTestRunner(
                    stream=output, verbosity=2, resultclass=FixtureResult).run(case)
            self.assertTrue(result.wasSuccessful(),
                            f'SDK fixture source-branch compatibility for {source_branch}:\n'
                            + output.getvalue())
            self.assertEqual(result.skipped, [],
                             'SDK fixture must not skip its healthy case')
            self.assertEqual(result.expectedFailures, [],
                             'SDK fixture must not accept an expected failure')
            self.assertEqual(result.testsRun, 1)

    def test_sdk_fixture_from_source_main(self):
        self.assert_source_compatible('main')

    def test_sdk_fixture_from_source_topic(self):
        self.assert_source_compatible('fixture-source')


if __name__ == '__main__':
    unittest.main()
