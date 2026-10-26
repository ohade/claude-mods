"""TRACK-39 A2 pin rows from the manager's rulings on the collect self-check.

Same fixture as test_history_collect.py: real history.py processes and real
writer-lock leases in a temporary CLAUDE_CONFIG_DIR. P1-P3 change behaviour
(precommit response bound, damaged-root wording, lock-shape preflight); P4-P9
pin paths the first rows did not reach.
"""
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import time
import unittest
import uuid

from test_history import HISTORY, checksum, compact
from test_history_collect import COLLECT_RUNNER, DAY_MS, CollectFixture, now_ms

LIMIT_RUNNER = Path(__file__).resolve().parent / "history_limit_runner.py"
FIRST = "00000000-0000-4000-8000-000000000001"
SECOND = "00000000-0000-4000-8000-000000000002"


class CollectPinTests(CollectFixture):

    def locks(self):
        return self.config / "state" / "track" / "locks"

    def collect_paused(self, row, name, count, action):
        """Runs collect paused before the count-th open of leaf name, applying action there."""
        ready = self.scratch / ("ready-" + uuid.uuid4().hex)
        go = self.scratch / ("go-" + uuid.uuid4().hex)
        os.mkfifo(ready, 0o600)
        os.mkfifo(go, 0o600)
        ready_fd = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        go_fd = os.open(go, os.O_RDWR | os.O_NONBLOCK)
        try:
            request = {"v": 3, "op": "collect", "store": self.store, "protected": [], "dry_run": False, "limit": 50}
            child = self.spawn([sys.executable, str(COLLECT_RUNNER), str(HISTORY), "collect", "--pause-name", name,
                                "--pause-count", str(count), "--ready", str(ready), "--go", str(go)], data=compact(request))
            readable, _, _ = select.select([ready_fd], [], [], 10)
            self.assertTrue(readable, f"{row}: collect paused at {name}#{count}")
            os.read(ready_fd, 4096)
            action()
            os.write(go_fd, b"go\n")
            completed = child.finish()
        finally:
            os.close(go_fd)
            os.close(ready_fd)
        return completed, self.parse_response(completed, request, row)

    def collect_limited(self, row, limit):
        request = {"v": 3, "op": "collect", "store": self.store, "protected": [], "dry_run": False, "limit": 50}
        completed = subprocess.run([sys.executable, str(LIMIT_RUNNER), str(HISTORY), "collect", str(limit)],
                                   input=compact(request), capture_output=True, env=self.environment,
                                   cwd=self.scratch, timeout=20)
        return completed, self.parse_response(completed, request, row)

    def test_p1_response_over_the_bound_refuses_precommit_with_zero_changes(self):
        for _ in range(3):
            self.save_at("P1", now_ms() - 8 * DAY_MS)
        before = self.inventory()
        completed, response = self.collect_limited("P1", 400)
        self.assert_refusal(completed, response, "P1", "collect response too large")
        self.assertEqual(self.inventory(), before, "P1: refused before any rename")

    def test_p2_damaged_root_with_a_root_name_refuses_as_damaged(self):
        session = str(uuid.uuid4())
        path = self.namespace() / "roots" / (session + ".json")
        path.write_bytes(b"{}")
        path.chmod(0o600)
        before = self.inventory()
        completed, response = self.collect("P2")
        self.assert_refusal(completed, response, "P2", "v3 history damaged: roots/" + session + ".json")
        self.assertNotIn("unknown entry", response["reason"], "P2: a recognised name is not unknown")
        self.assertEqual(self.inventory(), before, "P2: zero changes")

    def test_p2b_damaged_trash_entry_with_a_trash_name_refuses_as_damaged(self):
        self.save_at("P2b", now_ms() - 8 * DAY_MS)
        self.collected("P2b trash")
        [entry] = self.trash_entries()
        path = self.namespace() / "trash" / entry
        path.write_bytes(path.read_bytes() + b" ")
        before = self.inventory()
        completed, response = self.collect("P2b")
        self.assert_refusal(completed, response, "P2b", "v3 history damaged: trash/" + entry)
        self.assertEqual(self.inventory(), before, "P2b: zero changes")

    def test_p3_an_odd_lock_shape_refuses_before_any_rename(self):
        self.save_at("P3", now_ms() - 8 * DAY_MS, session=FIRST)
        self.save_at("P3", now_ms() - 8 * DAY_MS, session=SECOND)
        os.link(self.locks() / (SECOND + ".lock"), self.locks() / "p3-extra-link")
        before = self.inventory()
        completed, response = self.collect("P3")
        self.assert_refusal(completed, response, "P3")
        self.assertEqual(self.inventory(), before, "P3: the first victim was not renamed either")

    def test_p4_content_null_fence_root_ages_by_mtime(self):
        stale, fresh = str(uuid.uuid4()), str(uuid.uuid4())
        for session in (stale, fresh):
            lease = self.start_lease("P4", session=session)
            request = {"v": 3, "op": "resolve", "store": self.store, "session_id": session,
                       "module_token": self.token, "request_id": str(uuid.uuid4()),
                       "expect": {"absent": True}, "resolve_id": str(uuid.uuid4())}
            completed, response = self.invoke(request, "P4 fence")
            self.assert_ok(completed, response, "P4 fence")
            self.assertEqual(response["outcome"], "fenced", "P4: a content-null fence root was written")
            lease.stop()
            self.children.remove(lease)
        old = (now_ms() - 8 * DAY_MS) / 1000
        os.utime(self.root_of(stale), (old, old))
        response = self.collected("P4")
        self.assertEqual([entry["session_id"] for entry in response["trashed"]], [stale], "P4: the 8-day fence root is trashed")
        self.assertEqual(self.kept(response).get(fresh), "young", "P4: the fresh fence root is kept young")

    def test_p5_missing_lock_file_means_no_live_owner(self):
        session, _ = self.save_at("P5", now_ms() - 8 * DAY_MS)
        (self.locks() / (session + ".lock")).unlink()
        response = self.collected("P5")
        self.assertEqual([entry["session_id"] for entry in response["trashed"]], [session], "P5: trashed without a lock file")

    def test_p6_own_temp_names_are_tolerated_and_left(self):
        self.save_at("P6", now_ms() - 6 * DAY_MS)
        temps = [self.namespace() / "roots" / ("." + str(uuid.uuid4()) + ".123.0123456789abcdef.tmp"),
                 self.namespace() / "objects" / ("." + checksum(b"temp") + ".123.0123456789abcdef.tmp")]
        for path in temps:
            path.write_bytes(b"partial")
            path.chmod(0o600)
        response = self.collected("P6")
        self.assertEqual(response["trashed"], [], "P6: nothing expired")
        self.assertTrue(all(path.exists() for path in temps), "P6: temp files are left in place")

    def test_p7_bad_collect_schema_refuses(self):
        base = {"v": 3, "op": "collect", "store": self.store, "protected": [], "dry_run": False, "limit": 50}
        cases = {"limit 0": {"limit": 0}, "limit 51": {"limit": 51}, "dry_run text": {"dry_run": "no"},
                 "protected not uuid4": {"protected": ["not-a-session"]},
                 "protected over 64": {"protected": [str(uuid.uuid4()) for _ in range(65)]},
                 "extra key": {"session_id": str(uuid.uuid4())}}
        for name, change in cases.items():
            completed, response = self.invoke({**base, **change}, "P7 " + name)
            self.assert_refusal(completed, response, "P7 " + name, "invalid")

    def test_p8_restore_of_an_absent_trash_entry_refuses(self):
        session, receipt = self.save_at("P8", now_ms() - 8 * DAY_MS)
        self.collected("P8")
        [entry] = self.trash_entries()
        other = entry.rsplit(".", 2)[0] + ".1.json"
        request = {"v": 3, "op": "restore", "store": self.store, "session_id": session, "entry": other}
        completed, response = self.invoke(request, "P8")
        self.assert_refusal(completed, response, "P8", "trash entry absent")
        self.assertEqual(self.trash_entries(), [entry], "P8: the real entry stays")

    def test_p9_restore_of_a_damaged_trash_entry_refuses(self):
        session, _ = self.save_at("P9", now_ms() - 8 * DAY_MS)
        self.collected("P9")
        [entry] = self.trash_entries()
        path = self.namespace() / "trash" / entry
        path.write_bytes(path.read_bytes() + b" ")
        request = {"v": 3, "op": "restore", "store": self.store, "session_id": session, "entry": entry}
        completed, response = self.invoke(request, "P9")
        self.assert_refusal(completed, response, "P9", "v3 history damaged")
        self.assertFalse(self.root_of(session).exists(), "P9: nothing was restored")


class CollectReworkPinTests(CollectFixture):
    """Refuter r1 rows: a failed recheck keeps its root instead of refusing after a rename."""

    collect_paused = CollectPinTests.collect_paused

    def test_m1_a_recheck_failure_after_a_rename_keeps_the_root_changed(self):
        self.save_at("M1", now_ms() - 8 * DAY_MS, session=FIRST)
        self.save_at("M1", now_ms() - 8 * DAY_MS, session=SECOND)
        second = self.root_of(SECOND)
        # Opens of SECOND.json: enumeration, then its recheck after FIRST's rename.
        completed, response = self.collect_paused("M1", SECOND + ".json", 2, lambda: second.chmod(0o644))
        self.assert_ok(completed, response, "M1")
        self.assertNotEqual(response.get("phase"), "postcommit", "M1: never a postcommit refusal")
        self.assertEqual([entry["session_id"] for entry in response["trashed"]], [FIRST], "M1: FIRST is reported trashed")
        self.assertEqual(self.kept(response).get(SECOND), "changed", "M1: SECOND is kept changed")
        self.assertTrue(second.exists(), "M1: SECOND stays in roots/")

    def test_m2_a_changed_root_suspends_object_purge_for_the_run(self):
        session, _ = self.save_at("M2", now_ms() - 8 * DAY_MS)
        orphan_text = compact({"rows": [{"id": "orphan"}], "metadata": {}})
        orphan = self.namespace() / "objects" / (checksum(orphan_text) + ".json")
        orphan.write_bytes(orphan_text)
        orphan.chmod(0o600)
        root = self.root_of(session)
        original = root.read_bytes()
        completed, response = self.collect_paused("M2", session + ".json", 2,
                                                  lambda: root.write_bytes(original + b" "))
        self.assert_ok(completed, response, "M2")
        self.assertEqual(self.kept(response).get(session), "changed", "M2: the root was kept changed")
        self.assertEqual(response["purged_objects"], [], "M2: no object is purged in a run with a changed root")
        self.assertTrue(orphan.exists(), "M2: the orphan object stays")
        root.write_bytes(original)
        response = self.collected("M2 again")
        self.assertEqual([entry["session_id"] for entry in response["trashed"]], [session], "M2: the restored root is trashed")
        self.assertEqual(response["purged_objects"], [checksum(orphan_text)], "M2: without a changed root the orphan is purged")
        self.assertFalse(orphan.exists(), "M2: the orphan object is gone")

    def test_l1_a_future_mtime_fence_root_is_kept_future(self):
        session = str(uuid.uuid4())
        lease = self.start_lease("L1", session=session)
        request = {"v": 3, "op": "resolve", "store": self.store, "session_id": session, "module_token": self.token,
                   "request_id": str(uuid.uuid4()), "expect": {"absent": True}, "resolve_id": str(uuid.uuid4())}
        completed, response = self.invoke(request, "L1 fence")
        self.assert_ok(completed, response, "L1 fence")
        lease.stop()
        self.children.remove(lease)
        future = (now_ms() + DAY_MS) / 1000
        os.utime(self.root_of(session), (future, future))
        response = self.collected("L1")
        self.assertEqual(response["trashed"], [], "L1: a future fence root is never trashed")
        self.assertEqual(self.kept(response).get(session), "future", "L1: kept future")

    def test_l1_trash_directory_is_created_private(self):
        self.save_at("L1 trash", now_ms() - 8 * DAY_MS)
        self.collected("L1 trash")
        self.assertEqual(stat.S_IMODE((self.namespace() / "trash").lstat().st_mode), 0o700, "L1: trash/ is 0700")



class CollectRoundTwoPinTests(CollectFixture):
    """Refuter r2 rows: a refusal after a rename names what was done; lock and trash faults keep the root."""

    collect_paused = CollectPinTests.collect_paused
    locks = CollectPinTests.locks

    def two_old_roots(self, row):
        first, receipt = self.save_at(row, now_ms() - 8 * DAY_MS, session=FIRST)
        self.save_at(row, now_ms() - 8 * DAY_MS, session=SECOND)
        return {"session_id": first, "seq": receipt["seq"], "root_sha256": receipt["root_sha256"]}

    def test_r2a_a_refusal_after_a_rename_names_the_trashed_rows(self):
        first = self.two_old_roots("R2a")
        objects = self.namespace() / "objects"

        def replace_objects():
            objects.rename(self.namespace() / "objects-moved")
            objects.mkdir(mode=0o700)

        # Opens of SECOND.json: enumeration, then its recheck after FIRST's rename.
        completed, response = self.collect_paused("R2a", SECOND + ".json", 2, replace_objects)
        self.assert_refusal(completed, response, "R2a", "namespace directory changed", phase="postcommit")
        self.assertEqual(set(response), {"ok", "protocol", "op", "phase", "reason", "trashed", "purged_trash", "purged_objects"},
                         "R2a: exact postcommit refusal keys")
        self.assertEqual(response.get("trashed"), [first], "R2a: the refusal names FIRST as trashed")
        self.assertEqual((response.get("purged_trash"), response.get("purged_objects")), ([], []), "R2a: nothing was purged")
        self.assertFalse(self.root_of(FIRST).exists(), "R2a: FIRST really is in trash")

    def test_r3a_a_refusal_before_any_rename_keeps_the_precommit_keys(self):
        self.two_old_roots("R3a")
        objects = self.namespace() / "objects"

        def replace_objects():
            objects.rename(self.namespace() / "objects-moved")
            objects.mkdir(mode=0o700)

        # Opens of FIRST.json: enumeration, then its recheck before any rename.
        completed, response = self.collect_paused("R3a", FIRST + ".json", 2, replace_objects)
        self.assert_refusal(completed, response, "R3a", "namespace directory changed")
        self.assertEqual(set(response), {"ok", "protocol", "op", "phase", "reason"}, "R3a: exact precommit refusal keys")
        self.assertTrue(self.root_of(FIRST).exists(), "R3a: FIRST is still in roots/")

    def test_r2b_a_lock_replaced_by_a_symlink_after_preflight_keeps_the_root_live(self):
        first = self.two_old_roots("R2b")
        lock = self.locks() / (SECOND + ".lock")
        target = self.scratch / "r2b-target"
        target.write_bytes(b"")

        def replace_lock():
            lock.unlink()
            lock.symlink_to(target)

        completed, response = self.collect_paused("R2b", SECOND + ".lock", 1, replace_lock)
        self.assert_ok(completed, response, "R2b")
        self.assertEqual(response["trashed"], [first], "R2b: FIRST is trashed")
        self.assertEqual(self.kept(response).get(SECOND), "live", "R2b: SECOND is kept live")

    def test_r2c_a_trash_directory_that_refuses_the_rename_keeps_the_root_changed(self):
        first = self.two_old_roots("R2c")
        trash = self.namespace() / "trash"
        try:
            completed, response = self.collect_paused("R2c", SECOND + ".json", 2, lambda: trash.chmod(0o500))
        finally:
            trash.chmod(0o700)
        self.assert_ok(completed, response, "R2c")
        self.assertEqual(response["trashed"], [first], "R2c: FIRST is trashed")
        self.assertEqual(self.kept(response).get(SECOND), "changed", "R2c: SECOND is kept changed")
        self.assertTrue(self.root_of(SECOND).exists(), "R2c: SECOND stays in roots/")


if __name__ == "__main__":
    unittest.main()
