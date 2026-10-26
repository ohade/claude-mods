"""TRACK-39 A2 seven-day cleanup of v3 history roots (contract r2, c7d93fd6).

Isolated OS FIXTURE rows over real history.py processes and real writer-lock
leases in a temporary CLAUDE_CONFIG_DIR. Ages come from the savedAt each save
request carries; trash ages come from the trashedAt in a trash entry's name.
"""
import os
from pathlib import Path
import re
import select
import sys
import time
import unittest
import uuid

from test_history import HISTORY, HistoryFixture, checksum, compact

COLLECT_RUNNER = Path(__file__).resolve().parent / "history_collect_runner.py"
DAY_MS = 24 * 60 * 60 * 1000
HOUR_MS = 60 * 60 * 1000
TRASH_NAME = re.compile(r"^([0-9a-f-]{36})\.([1-9][0-9]*)\.([0-9a-f]{64})\.([0-9]+)\.json$")


def now_ms():
    return int(time.time() * 1000)


class CollectFixture(HistoryFixture):
    """Sessions saved at chosen ages, and collect/restore wire helpers."""

    def setUp(self):
        super().setUp()
        self.engine_file()
        self.store = self.bind("collect setUp")

    def namespace(self):
        return self.config / "state" / "track" / "v3" / self.store

    def root_of(self, session):
        return self.namespace() / "roots" / (session + ".json")

    def trash_entries(self):
        trash = self.namespace() / "trash"
        return sorted(path.name for path in trash.iterdir()) if trash.exists() else []

    def objects(self):
        return sorted(path.name for path in (self.namespace() / "objects").iterdir())

    def save_at(self, row, saved_at, *, session=None, ledger_text=None, keep_lease=False, expect=None):
        session = session or str(uuid.uuid4())
        lease = self.start_lease(row, session=session)
        request = self.save_request(self.store, expect=expect, ledger_text=ledger_text)
        request.update(session_id=session, savedAt=saved_at)
        request["checkpoint"]["source_session"] = session
        completed, receipt = self.invoke(request, row)
        self.assert_ok(completed, receipt, row)
        if not keep_lease:
            lease.stop()
            self.children.remove(lease)
        return session, receipt

    def collect(self, row, *, protected=(), dry_run=False, limit=50):
        request = {"v": 3, "op": "collect", "store": self.store, "protected": list(protected),
                   "dry_run": dry_run, "limit": limit}
        return self.invoke(request, row)

    def collected(self, row, **options):
        completed, response = self.collect(row, **options)
        self.assert_ok(completed, response, row)
        self.assertEqual(set(response), {"ok", "protocol", "op", "dry_run", "trashed", "purged_trash",
                                         "purged_objects", "kept", "more"}, f"{row}: exact collect response keys")
        return response

    def kept(self, response):
        return {entry["session_id"]: entry["reason"] for entry in response["kept"]}

    def retime_trash(self, session, age_ms):
        """Rename one validly named trash entry so its trashedAt is age_ms ago."""
        trash = self.namespace() / "trash"
        [name] = [entry for entry in self.trash_entries() if entry.startswith(session + ".")]
        match = TRASH_NAME.match(name)
        renamed = f"{match.group(1)}.{match.group(2)}.{match.group(3)}.{now_ms() - age_ms}.json"
        os.rename(trash / name, trash / renamed)
        return renamed


class CollectTests(CollectFixture):

    def test_c1_expired_root_is_trashed_and_young_root_kept(self):
        old, receipt = self.save_at("C1", now_ms() - 8 * DAY_MS)
        young, _ = self.save_at("C1", now_ms() - 6 * DAY_MS)
        before = now_ms()
        response = self.collected("C1")
        after = now_ms()
        self.assertEqual(response["trashed"], [{"session_id": old, "seq": receipt["seq"], "root_sha256": receipt["root_sha256"]}],
                         "C1: exactly the 8-day root is trashed")
        self.assertEqual(self.kept(response).get(young), "young", "C1: the 6-day root is kept young")
        self.assertFalse(self.root_of(old).exists(), "C1: the expired root left roots/")
        self.assertTrue(self.root_of(young).exists(), "C1: the young root stays")
        [name] = self.trash_entries()
        match = TRASH_NAME.match(name)
        self.assertIsNotNone(match, "C1: trash entry name matches the contract")
        self.assertEqual(match.groups()[:3], (old, str(receipt["seq"]), receipt["root_sha256"]), "C1: trash name carries session, seq and root sha")
        self.assertTrue(before <= int(match.group(4)) <= after, "C1: trashedAt is the collect time")
        self.assertIs(response["more"], False, "C1: nothing remains")

    def test_c2_live_lease_keeps_an_expired_root(self):
        session, _ = self.save_at("C2", now_ms() - 8 * DAY_MS, keep_lease=True)
        response = self.collected("C2")
        self.assertEqual(response["trashed"], [], "C2: a live session is never trashed")
        self.assertEqual(self.kept(response).get(session), "live", "C2: kept as live")
        self.assertTrue(self.root_of(session).exists(), "C2: root stays")

    def test_c3_dry_run_lists_victims_and_changes_nothing(self):
        session, receipt = self.save_at("C3", now_ms() - 8 * DAY_MS)
        before = self.inventory()
        response = self.collected("C3", dry_run=True)
        self.assertIs(response["dry_run"], True, "C3: echoed dry run")
        self.assertEqual([entry["session_id"] for entry in response["trashed"]], [session], "C3: dry run lists the victim")
        self.assertEqual(self.inventory(), before, "C3: dry run leaves the inventory byte-identical")
        self.assertFalse((self.namespace() / "trash").exists(), "C3: dry run creates no trash directory")

    def test_c4_unknown_entry_refuses_with_zero_changes(self):
        self.save_at("C4", now_ms() - 8 * DAY_MS)
        (self.namespace() / "roots" / "junk.txt").write_bytes(b"x")
        before = self.inventory()
        completed, response = self.collect("C4")
        self.assert_refusal(completed, response, "C4", "v3 namespace has unknown entry: junk.txt")
        self.assertEqual(self.inventory(), before, "C4: zero changes on an unknown entry")

    def test_c5_trash_grace_and_object_references(self):
        shared = compact({"rows": [{"id": "shared"}], "metadata": {}}).decode()
        gone = compact({"rows": [{"id": "gone"}], "metadata": {}}).decode()
        recent = compact({"rows": [{"id": "recent"}], "metadata": {}}).decode()
        expired_shared, _ = self.save_at("C5", now_ms() - 8 * DAY_MS, ledger_text=shared)
        self.save_at("C5", now_ms() - 1 * DAY_MS, ledger_text=shared)
        expired_gone, _ = self.save_at("C5", now_ms() - 8 * DAY_MS, ledger_text=gone)
        expired_recent, _ = self.save_at("C5", now_ms() - 8 * DAY_MS, ledger_text=recent)
        self.assertEqual(len(self.collected("C5 trash")["trashed"]), 3, "C5: three roots trashed first")
        old_shared = self.retime_trash(expired_shared, 25 * HOUR_MS)
        old_gone = self.retime_trash(expired_gone, 25 * HOUR_MS)
        young_trash = self.retime_trash(expired_recent, 23 * HOUR_MS)
        response = self.collected("C5 purge")
        self.assertEqual(sorted(response["purged_trash"]), sorted([old_shared, old_gone]), "C5: only 25-h trash entries are purged")
        self.assertEqual(self.trash_entries(), [young_trash], "C5: the 23-h trash entry stays")
        self.assertEqual(response["purged_objects"], [checksum(gone.encode())], "C5: only the unreferenced object is purged")
        self.assertEqual(self.objects(), sorted([checksum(shared.encode()) + ".json", checksum(recent.encode()) + ".json"]),
                         "C5: objects named by a live root or a trash entry stay")

    def test_c6_restore_returns_a_trashed_root_and_refuses_over_a_new_one(self):
        session, receipt = self.save_at("C6", now_ms() - 8 * DAY_MS)
        self.collected("C6")
        [entry] = self.trash_entries()
        request = {"v": 3, "op": "restore", "store": self.store, "session_id": session, "entry": entry}
        completed, response = self.invoke(request, "C6 restore")
        self.assert_ok(completed, response, "C6 restore")
        self.assertEqual((response["seq"], response["root_sha256"]), (receipt["seq"], receipt["root_sha256"]), "C6: the same root returns")
        self.assertEqual(self.trash_entries(), [], "C6: the trash entry was moved back")
        read = {"v": 3, "op": "read", "store": self.store, "session_id": session}
        completed, response = self.invoke(read, "C6 read")
        self.assert_ok(completed, response, "C6 read")
        self.assertEqual(response["root_sha256"], receipt["root_sha256"], "C6: read sees the restored root")
        self.collected("C6 again")
        [entry] = self.trash_entries()
        self.save_at("C6 new", now_ms(), session=session)
        completed, response = self.invoke({**request, "entry": entry}, "C6 refuse")
        self.assert_refusal(completed, response, "C6 refuse", "root exists")
        self.assertEqual(self.trash_entries(), [entry], "C6: the refused entry stays in trash")

    def test_c7_root_changed_before_recheck_is_kept(self):
        session, _ = self.save_at("C7", now_ms() - 8 * DAY_MS)
        name = session + ".json"
        ready = self.scratch / ("ready-" + uuid.uuid4().hex)
        go = self.scratch / ("go-" + uuid.uuid4().hex)
        os.mkfifo(ready, 0o600)
        os.mkfifo(go, 0o600)
        ready_fd = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        go_fd = os.open(go, os.O_RDWR | os.O_NONBLOCK)
        try:
            request = {"v": 3, "op": "collect", "store": self.store, "protected": [], "dry_run": False, "limit": 50}
            child = self.spawn([sys.executable, str(COLLECT_RUNNER), str(HISTORY), "collect", "--pause-name", name,
                                "--pause-count", "2", "--ready", str(ready), "--go", str(go)], data=compact(request))
            readable, _, _ = select.select([ready_fd], [], [], 10)
            self.assertTrue(readable, "C7: collect paused before its recheck")
            os.read(ready_fd, 4096)
            path = self.root_of(session)
            path.write_bytes(path.read_bytes() + b" ")
            os.write(go_fd, b"go\n")
            completed = child.finish()
        finally:
            os.close(go_fd)
            os.close(ready_fd)
        response = self.parse_response(completed, request, "C7")
        self.assert_ok(completed, response, "C7")
        self.assertEqual(response["trashed"], [], "C7: a changed root is never trashed")
        self.assertEqual(self.kept(response).get(session), "changed", "C7: kept as changed")
        self.assertTrue(self.root_of(session).exists(), "C7: root stays")

    def test_c8_limit_bounds_victims_and_reports_more(self):
        for _ in range(3):
            self.save_at("C8", now_ms() - 8 * DAY_MS)
        first = self.collected("C8 first", limit=2)
        self.assertEqual((len(first["trashed"]), first["more"]), (2, True), "C8: two trashed, more remain")
        second = self.collected("C8 second", limit=2)
        self.assertEqual((len(second["trashed"]), second["more"]), (1, False), "C8: the third trashed next run")

    def test_c9_future_saved_at_is_kept(self):
        session, _ = self.save_at("C9", now_ms() + DAY_MS)
        response = self.collected("C9")
        self.assertEqual(response["trashed"], [], "C9: a future root is never trashed")
        self.assertEqual(self.kept(response).get(session), "future", "C9: kept as future")

    def test_c10_protected_session_is_kept(self):
        session, _ = self.save_at("C10", now_ms() - 8 * DAY_MS)
        response = self.collected("C10", protected=[session])
        self.assertEqual(response["trashed"], [], "C10: a protected session is never trashed")
        self.assertEqual(self.kept(response).get(session), "protected", "C10: kept as protected")


if __name__ == "__main__":
    unittest.main()
