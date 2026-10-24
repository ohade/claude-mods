"""TRACK-42 unit 1: blob-fs.py sweep deletes only old, unreferenced, regular blob files.

Every test uses its own temporary directory; none touches a real config directory.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HELPER = Path(__file__).resolve().parents[2] / "hooks" / "blob-fs.py"
_spec = importlib.util.spec_from_file_location("blob_fs", HELPER)
blob_fs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(blob_fs)

DAY = 24 * 60 * 60
WEEK = 7 * DAY


def checksum(label):
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def expected(**changes):
    """The full success receipt of a sweep that did nothing, with `changes` applied."""
    receipt = {"ok": True, "removed": [], "kept_referenced": 0, "kept_young": 0,
               "vanished": 0, "failed": 0, "more": False}
    receipt.update(changes)
    return receipt


class DirLock:
    """A flock held by the test on a blob directory, as another process would hold it."""

    def __init__(self, directory, mode):
        self.fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        fcntl.flock(self.fd, mode)

    def release(self):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


class BlobSweepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dir = self.root / "blobs"
        self.dir.mkdir(mode=0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def blob(self, label, age=None, directory=None):
        """Create `<sum>.json` aged `age` seconds (negative for a future mtime)."""
        name = f"{checksum(label)}.json"
        path = (directory or self.dir) / name
        path.write_text(label)
        if age is not None:
            now = time.time()
            os.utime(path, (now - age, now - age))
        return path

    def sweep(self, directory=None, keep=None, raw=None, extra=()):
        payload = raw if raw is not None else json.dumps({"keep": keep if keep is not None else [checksum("keep-anchor")]})
        return subprocess.run([sys.executable, str(HELPER), "sweep", str(directory or self.dir), *extra],
                              input=payload.encode("utf-8"), capture_output=True, timeout=10)

    def parse_ok_receipt(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return json.loads(result.stdout.decode())

    def names(self):
        return sorted(os.listdir(self.dir))

    def test_deletes_unreferenced_at_exactly_seven_days_keeps_one_second_younger(self):
        old = self.blob("old", WEEK)
        young = self.blob("young", WEEK - 1)
        receipt = self.parse_ok_receipt(self.sweep())
        self.assertFalse(old.exists())
        self.assertTrue(young.exists())
        self.assertEqual(receipt, expected(removed=[old.name], kept_young=1))

    def test_keeps_a_future_mtime_file(self):
        future = self.blob("future", -3600)
        receipt = self.parse_ok_receipt(self.sweep())
        self.assertTrue(future.exists())
        self.assertEqual(receipt, expected(kept_young=1))

    def test_keeps_referenced_file_aged_thirty_days(self):
        kept = self.blob("kept", 30 * DAY)
        receipt = self.parse_ok_receipt(self.sweep(keep=[checksum("kept")]))
        self.assertTrue(kept.exists())
        self.assertEqual(receipt, expected(kept_referenced=1))

    def assertIgnored(self, make_entry):
        """`make_entry(dir)` creates one aged decoy; the sweep must leave the tree untouched."""
        make_entry(self.dir)
        before = self.names()
        receipt = self.parse_ok_receipt(self.sweep())
        self.assertEqual(self.names(), before)
        self.assertEqual(receipt, expected())

    def test_ignores_uppercase_hex_name(self):
        def make(directory):
            path = directory / f"{checksum('upper').upper()}.json"
            path.write_text("x")
            os.utime(path, (1, 1))
        self.assertIgnored(make)

    def test_ignores_temp_file(self):
        def make(directory):
            path = directory / f".{checksum('temp')}.123.abcdef.tmp"
            path.write_text("x")
            os.utime(path, (1, 1))
        self.assertIgnored(make)

    def test_ignores_other_names(self):
        def make(directory):
            for name in ("notes.txt", checksum("nosuffix"), f"{checksum('short')[:63]}.json"):
                (directory / name).write_text("x")
                os.utime(directory / name, (1, 1))
        self.assertIgnored(make)

    def test_ignores_subdirectory_named_like_a_blob(self):
        def make(directory):
            subdir = directory / f"{checksum('subdir')}.json"
            subdir.mkdir()
            (subdir / "inner").write_text("x")
            os.utime(subdir, (1, 1))
        self.assertIgnored(make)
        self.assertTrue((self.dir / f"{checksum('subdir')}.json" / "inner").exists())

    def test_ignores_symlink_named_like_a_blob_and_keeps_its_target(self):
        victim = self.root / "victim.json"
        victim.write_text("outside")
        os.utime(victim, (1, 1))
        link = self.dir / f"{checksum('link')}.json"
        os.symlink(victim, link)
        os.utime(link, (1, 1), follow_symlinks=False)
        self.assertLess(os.lstat(link).st_mtime, 10)
        receipt = self.parse_ok_receipt(self.sweep())
        self.assertTrue(os.path.islink(link))
        self.assertTrue(victim.exists())
        self.assertEqual(victim.read_text(), "outside")
        self.assertEqual(receipt, expected(kept_young=0))

    def assertRefusedKeepSet(self, **kwargs):
        old = self.blob("old", 30 * DAY)
        result = self.sweep(**kwargs)
        self.assertEqual(result.returncode, 1, result.stderr.decode())
        self.assertTrue(result.stderr.decode().startswith("blob-fs: "), result.stderr.decode())
        self.assertTrue(old.exists())

    def test_refuses_empty_keep_set(self):
        self.assertRefusedKeepSet(raw=json.dumps({"keep": []}))

    def test_refuses_invalid_json(self):
        self.assertRefusedKeepSet(raw="{not json")

    def test_refuses_missing_or_non_list_keep(self):
        self.assertRefusedKeepSet(raw=json.dumps({"other": []}))
        self.assertRefusedKeepSet(raw=json.dumps({"keep": "abc"}))

    def test_refuses_one_invalid_keep_entry(self):
        for bad in ("A" * 64, "a" * 63, "a" * 65, 7, None):
            with self.subTest(bad=bad):
                self.assertRefusedKeepSet(raw=json.dumps({"keep": [checksum("ok"), bad]}))

    def test_refuses_symlinked_directory(self):
        real = self.root / "real"
        real.mkdir()
        old = self.blob("old", 30 * DAY, directory=real)
        link = self.root / "link"
        os.symlink(real, link)
        result = self.sweep(directory=link)
        self.assertEqual(result.returncode, 1, result.stderr.decode())
        self.assertTrue(old.exists())

    def test_refuses_non_directory_and_relative_paths(self):
        plain = self.root / "plain"
        plain.write_text("x")
        self.assertEqual(self.sweep(directory=plain).returncode, 1)
        self.assertEqual(self.sweep(directory=Path("relative/dir")).returncode, 1)

    def test_missing_directory_succeeds_and_is_not_created(self):
        missing = self.root / "absent" / "blobs"
        receipt = self.parse_ok_receipt(self.sweep(directory=missing))
        self.assertEqual(receipt, expected())
        self.assertFalse(missing.exists())
        self.assertFalse(missing.parent.exists())

    def test_max_limits_deletions_and_reports_more(self):
        files = sorted([self.blob(label, 10 * DAY) for label in ("a", "b", "c")], key=lambda p: p.name)
        receipt = self.parse_ok_receipt(self.sweep(extra=("--max", "2")))
        self.assertEqual(len(receipt["removed"]), 2)
        self.assertEqual(receipt["removed"], sorted(receipt["removed"]))
        self.assertTrue(receipt["more"])
        self.assertEqual(receipt["kept_referenced"], 0)
        self.assertEqual(receipt["kept_young"], 0)
        self.assertEqual(sum(path.exists() for path in files), 1)
        self.assertEqual(receipt, expected(removed=[path.name for path in files[:2]], more=True))

    def test_max_equal_to_eligible_count_reports_no_more(self):
        self.blob("a", 10 * DAY)
        self.blob("b", 10 * DAY)
        receipt = self.parse_ok_receipt(self.sweep(extra=("--max", "2")))
        self.assertEqual(len(receipt["removed"]), 2)
        self.assertEqual(receipt["removed"], sorted(receipt["removed"]))
        self.assertEqual(receipt, expected(removed=receipt["removed"]))

    def test_counts_mixed_population_exactly(self):
        gone = [self.blob("g1", 9 * DAY), self.blob("g2", 8 * DAY)]
        self.blob("r1", 20 * DAY)
        self.blob("y1", DAY)
        self.blob("y2", 60)
        receipt = self.parse_ok_receipt(self.sweep(keep=[checksum("r1")]))
        self.assertEqual(receipt["removed"], sorted(path.name for path in gone))
        self.assertEqual(receipt, expected(removed=sorted(path.name for path in gone), kept_referenced=1, kept_young=2))

    def test_custom_min_age(self):
        old = self.blob("old", 120)
        young = self.blob("young", 30)
        self.parse_ok_receipt(self.sweep(extra=("--min-age-seconds", "60")))
        self.assertFalse(old.exists())
        self.assertTrue(young.exists())

    def test_publishing_identical_text_refreshes_mtime_and_sweep_keeps_it(self):
        text = "reused blob text"
        sum_ = hashlib.sha256(text.encode("utf-8")).hexdigest()
        path = self.dir / f"{sum_}.json"
        blob_fs.publish(str(self.dir), sum_, text)
        old = time.time() - 30 * DAY
        os.utime(path, (old, old))
        blob_fs.publish(str(self.dir), sum_, text)
        self.assertLess(abs(os.lstat(path).st_mtime - time.time()), 5)
        receipt = self.parse_ok_receipt(self.sweep())
        self.assertTrue(path.exists())
        self.assertEqual(receipt, expected(kept_young=1))

    def test_publish_race_path_also_refreshes_mtime(self):
        text = "raced blob text"
        sum_ = hashlib.sha256(text.encode("utf-8")).hexdigest()
        path = self.dir / f"{sum_}.json"

        def appear_old():
            path.write_text(text)
            os.chmod(path, 0o600)
            old = time.time() - 30 * DAY
            os.utime(path, (old, old))

        blob_fs.publish(str(self.dir), sum_, text, before_link=appear_old)
        self.assertLess(abs(os.lstat(path).st_mtime - time.time()), 5)


class SweepInProcessTests(unittest.TestCase):
    """Direct calls of blob_fs.sweep / blob_age_state, with os-level fault injection."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dir = self.root / "blobs"
        self.dir.mkdir(mode=0o700)
        self.keep = {checksum("keep-anchor")}

    def tearDown(self):
        self.tmp.cleanup()

    def blob(self, label, age=10 * DAY):
        path = self.dir / f"{checksum(label)}.json"
        path.write_text(label)
        stamp = int(time.time()) - age
        os.utime(path, (stamp, stamp))
        return path

    def sweep(self, **kwargs):
        return blob_fs.sweep(str(self.dir), self.keep, **kwargs)

    def dir_fsyncs(self):
        """A recording stand-in for os.fsync; returns (patcher, list of directory-fsync fds)."""
        real = os.fsync
        calls = []

        def recording(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                calls.append(fd)
            return real(fd)
        return mock.patch.object(blob_fs.os, "fsync", recording), calls

    def test_defaults_are_pinned(self):
        self.assertEqual(blob_fs.DEFAULT_MAX_REMOVALS, 200)
        self.assertEqual(blob_fs.DEFAULT_MIN_AGE_SECONDS, 604800)

    def test_age_check_boundary_is_exact(self):
        path = self.blob("edge", 0)
        mtime = os.lstat(path).st_mtime
        self.assertEqual(mtime, int(mtime))
        dir_fd = os.open(self.dir, os.O_RDONLY | os.O_DIRECTORY)
        try:
            self.assertEqual(blob_fs.blob_age_state(dir_fd, path.name, mtime + 604800, 604800), "eligible")
            self.assertEqual(blob_fs.blob_age_state(dir_fd, path.name, mtime + 604799.999, 604800), "young")
        finally:
            os.close(dir_fd)

    def test_recheck_keeps_a_file_refreshed_after_the_scan(self):
        paths = sorted([self.blob(label) for label in ("a", "b", "c")], key=lambda p: p.name)
        target = paths[1]
        real = blob_fs.blob_age_state
        seen = []

        def refreshing(dir_fd, name, now, min_age):
            state = real(dir_fd, name, now, min_age)
            if name == target.name and not seen:
                seen.append(name)
                os.utime(target)
            return state

        with mock.patch.object(blob_fs, "blob_age_state", refreshing):
            receipt = self.sweep()
        self.assertTrue(target.exists())
        self.assertEqual(receipt, expected(removed=[paths[0].name, paths[2].name], kept_young=1))

    def test_recheck_counts_a_file_gone_after_the_scan_as_vanished(self):
        paths = sorted([self.blob(label) for label in ("a", "b", "c")], key=lambda p: p.name)
        target = paths[1]
        real = blob_fs.blob_age_state
        seen = []

        def deleting(dir_fd, name, now, min_age):
            state = real(dir_fd, name, now, min_age)
            if name == target.name and not seen:
                seen.append(name)
                target.unlink()
            return state

        with mock.patch.object(blob_fs, "blob_age_state", deleting):
            receipt = self.sweep()
        self.assertEqual(receipt, expected(removed=[paths[0].name, paths[2].name], vanished=1))

    def test_recheck_counts_a_file_replaced_by_a_symlink_as_vanished(self):
        paths = sorted([self.blob(label) for label in ("a", "b", "c")], key=lambda p: p.name)
        target = paths[1]
        victim = self.root / "victim.json"
        victim.write_text("outside")
        real = blob_fs.blob_age_state
        seen = []

        def replacing(dir_fd, name, now, min_age):
            state = real(dir_fd, name, now, min_age)
            if name == target.name and not seen:
                seen.append(name)
                target.unlink()
                os.symlink(victim, target)
                os.utime(target, (1, 1), follow_symlinks=False)
            return state

        with mock.patch.object(blob_fs, "blob_age_state", replacing):
            receipt = self.sweep()
        self.assertTrue(os.path.islink(target))
        self.assertEqual(victim.read_text(), "outside")
        self.assertEqual(receipt, expected(removed=[paths[0].name, paths[2].name], vanished=1))

    def test_file_owned_by_another_user_is_not_removed(self):
        old = self.blob("old")
        other_uid = os.geteuid() + 1
        with mock.patch.object(blob_fs.os, "geteuid", lambda: other_uid):
            receipt = self.sweep()
        self.assertTrue(old.exists())
        self.assertEqual(receipt, expected())

    def test_directory_is_fsynced_once_when_files_were_removed(self):
        for label in ("a", "b"):
            self.blob(label)
        patcher, calls = self.dir_fsyncs()
        with patcher:
            receipt = self.sweep()
        self.assertEqual(len(receipt["removed"]), 2)
        self.assertEqual(len(calls), 1)

    def test_directory_is_not_fsynced_when_nothing_was_removed(self):
        self.blob("young", 60)
        patcher, calls = self.dir_fsyncs()
        with patcher:
            receipt = self.sweep()
        self.assertEqual(receipt, expected(kept_young=1))
        self.assertEqual(calls, [])

    def test_unlink_permission_error_is_counted_and_the_run_continues(self):
        paths = sorted([self.blob(label) for label in ("a", "b", "c")], key=lambda p: p.name)
        real = os.unlink

        def failing(name, *args, **kwargs):
            if name == paths[1].name:
                raise PermissionError(13, "denied")
            return real(name, *args, **kwargs)

        patcher, calls = self.dir_fsyncs()
        with mock.patch.object(blob_fs.os, "unlink", failing), patcher:
            receipt = self.sweep()
        self.assertFalse(paths[0].exists())
        self.assertTrue(paths[1].exists())
        self.assertFalse(paths[2].exists())
        self.assertEqual(receipt, expected(removed=[paths[0].name, paths[2].name], failed=1))
        self.assertEqual(len(calls), 1)

    def test_unlink_file_not_found_is_counted_as_vanished(self):
        paths = sorted([self.blob(label) for label in ("a", "b")], key=lambda p: p.name)
        real = os.unlink

        def racing(name, *args, **kwargs):
            if name == paths[0].name:
                real(name, *args, **kwargs)
                raise FileNotFoundError(2, "gone")
            return real(name, *args, **kwargs)

        with mock.patch.object(blob_fs.os, "unlink", racing):
            receipt = self.sweep()
        self.assertEqual(receipt, expected(removed=[paths[1].name], vanished=1))

    def test_directory_is_fsynced_even_when_an_unexpected_error_aborts_the_run(self):
        paths = sorted([self.blob(label) for label in ("a", "b")], key=lambda p: p.name)
        real = os.unlink

        def exploding(name, *args, **kwargs):
            if name == paths[1].name:
                raise RuntimeError("boom")
            return real(name, *args, **kwargs)

        patcher, calls = self.dir_fsyncs()
        with mock.patch.object(blob_fs.os, "unlink", exploding), patcher:
            with self.assertRaises(RuntimeError):
                self.sweep()
        self.assertFalse(paths[0].exists())
        self.assertEqual(len(calls), 1)

    def test_unlink_failure_exits_zero_through_the_cli(self):
        old = self.blob("old")
        # A read-only directory makes the unlink fail for real (skip when running as root).
        if os.geteuid() == 0:
            self.skipTest("root ignores directory permissions")
        os.chmod(self.dir, 0o500)
        try:
            result = subprocess.run([sys.executable, str(HELPER), "sweep", str(self.dir)],
                                    input=json.dumps({"keep": [checksum("keep-anchor")]}).encode(),
                                    capture_output=True, timeout=10)
        finally:
            os.chmod(self.dir, 0o700)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue(old.exists())
        self.assertEqual(json.loads(result.stdout), expected(failed=1))

    def test_sweep_holds_an_exclusive_directory_lock_while_unlinking(self):
        self.blob("old")
        real = os.unlink
        outcomes = []

        def probing(name, *args, **kwargs):
            probe = os.open(self.dir, os.O_RDONLY | os.O_DIRECTORY)
            try:
                fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
                outcomes.append("acquired")
            except BlockingIOError:
                outcomes.append("blocked")
            finally:
                os.close(probe)
            return real(name, *args, **kwargs)

        with mock.patch.object(blob_fs.os, "unlink", probing):
            self.sweep()
        self.assertEqual(outcomes, ["blocked"])

    def test_publish_holds_a_shared_directory_lock_through_the_final_fsync(self):
        text = "locked publication"
        sum_ = hashlib.sha256(text.encode("utf-8")).hexdigest()
        real = os.fsync
        outcomes = []

        def probing(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                probe = os.open(self.dir, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    outcomes.append("acquired")
                except BlockingIOError:
                    outcomes.append("blocked")
                finally:
                    os.close(probe)
            return real(fd)

        with mock.patch.object(blob_fs.os, "fsync", probing):
            blob_fs.publish(str(self.dir), sum_, text)
        self.assertEqual(outcomes, ["blocked"])

    def raised_name(self, call, *args):
        with self.assertRaises(blob_fs.PublishError) as caught:
            call(*args)
        return type(caught.exception).__name__

    def test_sweep_errors_are_sweep_errors(self):
        link = self.root / "link"
        os.symlink(self.dir, link)
        self.assertEqual(self.raised_name(blob_fs.parse_keep_set, json.dumps({"keep": []})), "SweepError")
        self.assertEqual(self.raised_name(blob_fs.parse_keep_set, "{nope"), "SweepError")
        self.assertEqual(self.raised_name(blob_fs.sweep, str(link), self.keep), "SweepError")
        self.assertEqual(self.raised_name(blob_fs.sweep, "relative/dir", self.keep), "SweepError")

    def test_sweep_error_is_a_publish_error(self):
        self.assertTrue(issubclass(getattr(blob_fs, "SweepError", object), blob_fs.PublishError))


class DirectoryLockCliTests(unittest.TestCase):
    """sweep and publish exclude each other through flock on the blob directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "blobs"
        self.dir.mkdir(mode=0o700)
        self.locks = []

    def tearDown(self):
        for lock in self.locks:
            lock.release()
        self.tmp.cleanup()

    def hold(self, mode):
        lock = DirLock(self.dir, mode)
        self.locks.append(lock)
        return lock

    def old_blob(self):
        path = self.dir / f"{checksum('old')}.json"
        path.write_text("old")
        os.utime(path, (1, 1))
        return path

    def run_sweep(self):
        return subprocess.run([sys.executable, str(HELPER), "sweep", str(self.dir)],
                              input=json.dumps({"keep": [checksum("keep-anchor")]}).encode(),
                              capture_output=True, timeout=15)

    def start_publish(self, text):
        sum_ = hashlib.sha256(text.encode("utf-8")).hexdigest()
        process = subprocess.Popen([sys.executable, str(HELPER), "publish", str(self.dir), sum_],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return sum_, process

    def test_sweep_refuses_when_a_publisher_holds_the_lock(self):
        old = self.old_blob()
        self.hold(fcntl.LOCK_SH)
        result = self.run_sweep()
        self.assertEqual(result.returncode, 1, result.stderr.decode())
        self.assertEqual(result.stderr.decode().strip(), "blob-fs: blob directory is busy")
        self.assertTrue(old.exists())

    def test_sweep_waits_for_a_short_lived_publisher_lock(self):
        old = self.old_blob()
        lock = self.hold(fcntl.LOCK_SH)
        timer = threading.Timer(0.3, lock.release)
        timer.start()
        try:
            result = self.run_sweep()
        finally:
            timer.join()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertFalse(old.exists())

    def test_publish_waits_for_the_lock_and_then_completes(self):
        started = time.time()
        lock = self.hold(fcntl.LOCK_EX)
        timer = threading.Timer(0.3, lock.release)
        timer.start()
        sum_, process = self.start_publish("waited text")
        try:
            out, err = process.communicate(b"waited text", timeout=15)
        finally:
            timer.join()
        self.assertEqual(process.returncode, 0, err.decode())
        self.assertGreaterEqual(time.time() - started, 0.3)
        self.assertEqual(json.loads(out)["checksum"], sum_)
        self.assertEqual((self.dir / f"{sum_}.json").read_text(), "waited text")

    def test_publish_gives_up_after_five_seconds_and_writes_nothing(self):
        self.hold(fcntl.LOCK_EX)
        started = time.time()
        sum_, process = self.start_publish("never written")
        out, err = process.communicate(b"never written", timeout=20)
        elapsed = time.time() - started
        self.assertEqual(process.returncode, 1, err.decode())
        self.assertEqual(err.decode().strip(), "blob-fs: blob directory is busy")
        self.assertGreaterEqual(elapsed, 4.5)
        self.assertEqual(os.listdir(self.dir), [])


if __name__ == "__main__":
    unittest.main()
