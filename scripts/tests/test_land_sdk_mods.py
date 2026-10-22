"""Characterisation of the real two-mod layout: only Track declares npm checks."""
import json
import unittest

import test_land_sdk as fixtures


class TwoModSdkTest(unittest.TestCase):
    def test_mod_without_package_needs_no_sdk_manifest_entry(self):
        fixture = fixtures.SdkLandingTest('test_checked_sdk_initialises_a_healthy_cold_tree')
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        fixture.git('checkout', 'fixture-candidate')
        other = fixture.repo / 'image-thumbs'
        (other / '.claude-plugin').mkdir(parents=True)
        (other / 'tests').mkdir()
        (other / '.claude-plugin/plugin.json').write_text('{}')
        (other / 'tsconfig.json').write_text(json.dumps({'extends': './.claude-plugin/types/tsconfig.json'}))
        (other / 'tests/input').write_text('fixture\n')
        fixture.git('add', 'image-thumbs')
        fixture.git('commit', '-qm', 'second mod has no declared npm typecheck')
        fixture.target = fixture.git('rev-parse', 'HEAD').stdout.strip()
        fixture.git('checkout', 'main')
        result = fixture.land()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        receipt = json.loads(fixture.receipt.read_text())
        self.assertEqual(set(receipt['mods']), {'track', 'image-thumbs'})
        self.assertEqual(set(receipt['sdk']), {'track'})


if __name__ == '__main__':
    unittest.main()
