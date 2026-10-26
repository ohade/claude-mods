"""TRACK-39 F1-F3 FIXTURE pins; no LIVE engine or crash proof.

Each refusal check first runs an ordinary real-helper positive control. Fault
receipts prove the intended seam was reached before a behavior assertion runs.
The runner patches only its fresh process, never product or legacy helper bytes.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import unittest
import uuid

if __package__:
    from .test_history import HISTORY, HistoryFixture, checksum, compact
else:
    from test_history import HISTORY, HistoryFixture, checksum, compact


RUNNER = Path(__file__).resolve().with_name("history_f123_runner.py")


class HistoryF123Tests(HistoryFixture):
    """Exercise late entries, disappearing roots and retry barrier ordering."""

    def setUp(self):
        super().setUp()
        self.environment["PYTHONDONTWRITEBYTECODE"] = "1"

    def prepare_with_reuse_control(self):
        store = self.prepare("F123 ordinary save/reuse positive control")
        first = self.save_request(store, ledger_text='{"control":"ordinary save/reuse"}')
        completed, receipt = self.invoke(first, "F123 ordinary first save")
        self.assert_ok(completed, receipt, "F123 ordinary first save")
        object_path = self.object_path(first)
        object_inode = object_path.stat().st_ino
        second = self.save_request(store, expect=self.expected_root(receipt),
                                   ledger_text=first["ledger_text"])
        completed, reused = self.invoke(second, "F123 ordinary reuse")
        self.assert_ok(completed, reused, "F123 ordinary reuse")
        self.assertEqual(reused["seq"], 2, "positive control: reuse commits the next root")
        self.assertEqual(object_path.stat().st_ino, object_inode,
                         "positive control: identical content reuses the object inode")
        _, response = self.read(store, "F123 ordinary fresh read")
        self.assertEqual(response["ledger_text"], first["ledger_text"])
        self.session = str(uuid.uuid4())
        self.start_lease("F123 target session lease")
        return store

    def object_path(self, request):
        digest = checksum(request["ledger_text"].encode("utf-8"))
        return self.root_path(request["store"]).parent.parent / "objects" / (digest + ".json")

    def runner_command(self, request, trace, *options):
        command = [sys.executable, str(RUNNER), str(HISTORY), request["op"],
                   "--fixture-root", str(self.config),
                   "--root", str(self.root_path(request["store"])), "--trace", str(trace)]
        if request["op"] == "save":
            command.extend(["--object", str(self.object_path(request))])
        return [*command, *options]

    def invoke_injected(self, request, trace_name, *options):
        trace = self.config / trace_name
        completed = subprocess.run(
            self.runner_command(request, trace, *options), input=compact(request),
            capture_output=True, env=self.environment, cwd=self.scratch, timeout=20)
        events = self.trace_events(trace)
        response = self.parse_response(completed, request, trace_name)
        return completed, response, events

    def trace_events(self, trace):
        events = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(events, "injection setup: trace must contain a process receipt")
        self.assertEqual(events[0]["event"], "process-start")
        self.assertIsInstance(events[0]["pid"], int)
        return events

    @contextmanager
    def paused_publication(self, request, target):
        ready = self.config / "f1-ready.fifo"
        go = self.config / "f1-go.fifo"
        trace = self.config / "f1-trace.jsonl"
        os.mkfifo(ready, 0o600)
        os.mkfifo(go, 0o600)
        ready_descriptor = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        go_descriptor = os.open(go, os.O_RDWR | os.O_NONBLOCK)
        child = None
        try:
            command = self.runner_command(request, trace, "--pause-at", target,
                                          "--ready", str(ready), "--go", str(go))
            child = self.spawn(command, data=compact(request))
            readable, _, _ = select.select([ready_descriptor], [], [], 10)
            self.assertTrue(readable, "F1 setup: pause receipt must arrive before injection")
            receipt = json.loads(os.read(ready_descriptor, 4096))
            self.assertEqual(receipt, {"event": "paused", "at": target,
                                      "object_path": str(self.object_path(request))},
                             "F1 setup: pause must identify the exact target object path")

            def resume():
                self.assertEqual(os.write(go_descriptor, b"go\n"), 3,
                                 "F1 setup: bounded resume handshake")

            yield child, resume, trace
        finally:
            if child is not None:
                child.stop()
            os.close(go_descriptor)
            os.close(ready_descriptor)

    def assert_late_hardlink_refused(self, target):
        store = self.prepare_with_reuse_control()
        request = self.save_request(store)
        object_path = self.object_path(request)
        outside = self.config / "f1-outside-ledger.json"
        ledger = request["ledger_text"].encode("utf-8")
        outside.write_bytes(ledger)
        outside.chmod(0o644)
        self.assertFalse(object_path.exists(), "F1 setup: checksum object starts absent")
        with self.paused_publication(request, target) as (child, resume, trace):
            os.link(outside, object_path)
            linked = object_path.stat()
            self.assertEqual((linked.st_dev, linked.st_ino, linked.st_nlink,
                              stat.S_IMODE(linked.st_mode)),
                             (outside.stat().st_dev, outside.stat().st_ino, 2, 0o644),
                             "F1 setup: exact paused object is the owned outside 0644 hardlink")
            resume()
            completed = child.finish()
        events = self.trace_events(trace)
        self.assertIn({"event": "paused", "at": target, "object_path": str(object_path)}, events)
        if target == "before-link":
            self.assertIn({"event": "collision-file-exists", "object_path": str(object_path)},
                          events, "F1 setup: no-clobber link must hit its FileExistsError branch")
        response = self.parse_response(completed, request, "F1 " + target)
        observed = (completed.returncode, response.get("ok"), response.get("phase"),
                    outside.read_bytes(), stat.S_IMODE(outside.stat().st_mode),
                    self.root_path(store).exists())
        self.assertEqual(observed, (1, False, "precommit", ledger, 0o644, False),
                         "F1 late hardlink must refuse precommit, preserve outside bytes/mode, and leave no root")
        self.assertEqual(set(response), {"ok", "protocol", "op", "phase", "reason", "request_id"})

    def test_f1_late_hardlink_before_publish_refuses_without_outside_change(self):
        self.assert_late_hardlink_refused("before-object-publish")

    def test_f1_late_hardlink_at_link_collision_refuses_without_outside_change(self):
        self.assert_late_hardlink_refused("before-link")

    def test_f2_truly_absent_root_positive_control(self):
        store = self.prepare("F2 absent positive control", lease=False)
        completed, response = self.read(store, "F2 truly absent root")
        self.assert_ok(completed, response, "F2 truly absent root")
        self.assertEqual(response, {"ok": True, "protocol": 3, "op": "read", "state": "absent"})

    def test_f2_root_disappearing_after_open_is_damaged_not_absent(self):
        store, _, _ = self.seed("F2 existing-root positive control")
        _, before = self.read(store, "F2 valid-root positive control")
        self.assertEqual(before["state"], "valid")
        root = self.root_path(store)
        initial_inode = root.stat().st_ino
        request = {"v": 3, "op": "read", "store": store, "session_id": self.session}
        completed, response, events = self.invoke_injected(
            request, "f2-trace.jsonl", "--remove-root-on-revalidate")
        self.assertIn({"event": "root-removed-after-open", "root_path": str(root),
                       "opened_inode": initial_inode, "observed_inode": initial_inode}, events,
                      "F2 setup: removal must follow the initial successful root open")
        self.assertFalse(root.exists(), "F2 setup: only the fixture root was removed")
        self.assertEqual((completed.returncode, response.get("ok"), response.get("phase"),
                          "v3 history damaged" in response.get("reason", ""), response.get("state")),
                         (1, False, "precommit", True, None),
                         "F2 opened root disappearance must emit one damaged refusal, never absent success")
        self.assertEqual(set(response), {"ok", "protocol", "op", "phase", "reason"})

    def prepare_failed_publication(self):
        store = self.prepare_with_reuse_control()
        request = self.save_request(store)
        object_path = self.object_path(request)
        self.assertFalse(object_path.exists(), "F3 setup: target object starts absent")
        completed, response, events = self.invoke_injected(
            request, "f3-first-trace.jsonl", "--fail-objects-dir-fsync")
        self.assertIn({"event": "objects-dir-fsync-failed", "object_path": str(object_path)},
                      events, "F3 setup: first publication must reach the object-directory fault")
        self.assert_refusal(completed, response, "F3 first failed publication",
                            "F3 injected objects directory fsync failure")
        self.assertEqual(object_path.read_bytes(), request["ledger_text"].encode("utf-8"),
                         "F3 setup: publication left the correct object present")
        self.assertFalse(self.root_path(store).exists(), "F3 first barrier failure leaves no root")
        self.assertNotIn("root-rename", [event["event"] for event in events])
        return store, request, events[0]["pid"]

    def test_f3_retry_reuse_syncs_object_file_and_directory_before_root_rename(self):
        store, request, first_pid = self.prepare_failed_publication()
        completed, response, events = self.invoke_injected(request, "f3-retry-trace.jsonl")
        self.assertNotEqual(events[0]["pid"], first_pid, "F3 retry must run in a fresh helper process")
        self.assert_ok(completed, response, "F3 successful retry")
        self.assertTrue(self.root_path(store).is_file(), "F3 successful retry commits its root")
        names = [event["event"] for event in events]
        self.assertIn("root-rename", names, "F3 trace must observe the real root rename")
        before_rename = names[:names.index("root-rename")]
        self.assertTrue("object-file-fsync" in before_rename and "objects-dir-fsync" in before_rename,
                        "F3 retry reuse must complete object file and objects directory fsync before root rename; "
                        + repr(names))

    def test_f3_retry_reuse_refuses_when_object_directory_barrier_fails_again(self):
        store, request, first_pid = self.prepare_failed_publication()
        completed, response, events = self.invoke_injected(
            request, "f3-retry-trace.jsonl", "--fail-objects-dir-fsync")
        self.assertNotEqual(events[0]["pid"], first_pid, "F3 retry must run in a fresh helper process")
        names = [event["event"] for event in events]
        self.assertIn("objects-dir-fsync-failed", names,
                      "F3 retry reuse must reach the targeted objects directory fsync fault before root commit")
        self.assert_refusal(completed, response, "F3 retry barrier failure",
                            "F3 injected objects directory fsync failure")
        self.assertFalse(self.root_path(store).exists(), "F3 retry barrier failure leaves no root")
        self.assertNotIn("root-rename", names, "F3 failed retry barrier prevents root rename")


if __name__ == "__main__":
    unittest.main()
