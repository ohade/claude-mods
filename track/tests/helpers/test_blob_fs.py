"""TRACK-35 U2b: blob-fs.py publishes one content-addressed blob, 0600 in a 0700 dir, no clobber.

Every test uses its own temporary directory; none touches a real config directory.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[2] / "hooks" / "blob-fs.py"
_spec = importlib.util.spec_from_file_location("blob_fs", HELPER)
blob_fs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(blob_fs)

TEXT = json.dumps({"v": 1, "questions": [], "steps": [], "note": "héllo"})
SUM = hashlib.sha256(TEXT.encode("utf-8")).hexdigest()
BYTES = len(TEXT.encode("utf-8"))


def mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


class BlobFsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dir = self.root / "config" / "state" / "track" / "blobs"
        self.target = self.dir / f"{SUM}.json"

    def tearDown(self):
        self.tmp.cleanup()

    def assertRefused(self, directory, checksum=SUM, text=TEXT, before_link=None):
        try:
            blob_fs.publish(str(directory), checksum, text, before_link)
        except blob_fs.PublishError:
            return
        self.fail("publish was not refused")

    def cli(self, directory, checksum=SUM, text=TEXT):
        return subprocess.run(["python3", str(HELPER), "publish", str(directory), checksum],
                              input=text.encode("utf-8"), capture_output=True, timeout=10)

    def leftovers(self):
        return sorted(name for name in os.listdir(self.dir) if name != self.target.name) if self.dir.is_dir() else []

    def test_publish_creates_blob_0600_in_new_dirs_0700(self):
        receipt = blob_fs.publish(str(self.dir), SUM, TEXT)
        self.assertEqual(receipt, {"ok": True, "checksum": SUM, "bytes": BYTES})
        self.assertTrue(self.target.is_file(), "blob was not published")
        self.assertEqual(self.target.read_bytes(), TEXT.encode("utf-8"))
        self.assertEqual(mode(self.target), 0o600)
        for directory in (self.dir, self.dir.parent, self.dir.parent.parent, self.dir.parent.parent.parent):
            self.assertEqual((str(directory), mode(directory)), (str(directory), 0o700))
        self.assertEqual(self.leftovers(), [])

    def test_cli_prints_one_receipt_line(self):
        result = self.cli(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.decode("utf-8").splitlines()
        self.assertEqual([json.loads(line) for line in lines], [{"ok": True, "checksum": SUM, "bytes": BYTES}])
        self.assertTrue(self.target.is_file(), "CLI did not publish the blob")
        self.assertEqual(self.target.read_bytes(), TEXT.encode("utf-8"))

    def test_existing_dir_is_tightened_to_0700(self):
        self.dir.mkdir(parents=True)
        os.chmod(self.dir, 0o755)
        blob_fs.publish(str(self.dir), SUM, TEXT)
        self.assertEqual(mode(self.dir), 0o700)
        self.assertTrue(self.target.is_file(), "blob was not published")

    def test_matching_existing_blob_0644_ends_0600_unchanged(self):
        self.dir.mkdir(parents=True, mode=0o700)
        self.target.write_bytes(TEXT.encode("utf-8"))
        os.chmod(self.target, 0o644)
        before = os.stat(self.target).st_ino
        receipt = blob_fs.publish(str(self.dir), SUM, TEXT)
        self.assertEqual(receipt, {"ok": True, "checksum": SUM, "bytes": BYTES})
        self.assertEqual(mode(self.target), 0o600)
        self.assertEqual(self.target.read_bytes(), TEXT.encode("utf-8"))
        self.assertEqual(os.stat(self.target).st_ino, before)
        self.assertEqual(self.leftovers(), [])

    def test_differing_existing_blob_is_refused_and_kept(self):
        self.dir.mkdir(parents=True, mode=0o700)
        self.target.write_bytes(b"damaged")
        os.chmod(self.target, 0o644)
        self.assertRefused(self.dir)
        self.assertEqual(self.target.read_bytes(), b"damaged")
        self.assertEqual(mode(self.target), 0o644)
        self.assertEqual(self.leftovers(), [])
        result = self.cli(self.dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotEqual(result.stderr.strip(), b"")
        self.assertEqual(self.target.read_bytes(), b"damaged")

    def test_differing_blob_created_before_link_is_refused_and_kept(self):
        def race():
            self.target.write_bytes(b"other writer")
        self.assertRefused(self.dir, before_link=race)
        self.assertEqual(self.target.read_bytes(), b"other writer")
        self.assertEqual(self.leftovers(), [])

    def test_matching_blob_created_before_link_is_accepted(self):
        def race():
            self.target.write_bytes(TEXT.encode("utf-8"))
            os.chmod(self.target, 0o644)
        receipt = blob_fs.publish(str(self.dir), SUM, TEXT, race)
        self.assertEqual(receipt, {"ok": True, "checksum": SUM, "bytes": BYTES})
        self.assertTrue(self.target.is_file(), "blob was not published")
        self.assertEqual(mode(self.target), 0o600)
        self.assertEqual(self.leftovers(), [])

    def test_symlinked_dir_is_refused(self):
        real = self.root / "elsewhere"
        real.mkdir(mode=0o755)
        self.dir.parent.mkdir(parents=True)
        os.symlink(real, self.dir)
        self.assertRefused(self.dir)
        self.assertEqual(os.listdir(real), [])
        self.assertEqual(mode(real), 0o755)
        self.assertTrue(os.path.islink(self.dir))

    def test_dir_that_is_a_file_is_refused(self):
        self.dir.parent.mkdir(parents=True)
        self.dir.write_bytes(b"not a dir")
        self.assertRefused(self.dir)
        self.assertEqual(self.dir.read_bytes(), b"not a dir")

    def test_symlinked_target_is_refused_and_kept(self):
        self.dir.mkdir(parents=True, mode=0o700)
        elsewhere = self.root / "same-text.json"
        elsewhere.write_bytes(TEXT.encode("utf-8"))
        os.chmod(elsewhere, 0o644)
        os.symlink(elsewhere, self.target)
        self.assertRefused(self.dir)
        self.assertTrue(os.path.islink(self.target))
        self.assertEqual(mode(elsewhere), 0o644)
        self.assertEqual(self.leftovers(), [])

    def test_bad_arguments_are_refused_without_writing(self):
        self.assertRefused("relative/blobs")
        self.assertRefused(self.dir, checksum=SUM.upper())
        self.assertRefused(self.dir, checksum=SUM[:-1])
        self.assertRefused(self.dir, checksum=SUM, text=TEXT + " ")
        self.assertFalse(self.target.exists())
        self.assertFalse((self.root / "config").exists())
        result = self.cli(self.dir, text=TEXT + " ")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotEqual(result.stderr.strip(), b"")
        self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
