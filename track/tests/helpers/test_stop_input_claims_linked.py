"""FIXTURE: input claims are published by one link, never rolled back and never expired."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import test_stop_input_claim_failures as claim_fixture
import test_stop_inputs as inputs_fixture


stop = claim_fixture.stop
FIRST = (1, inputs_fixture.REASON)
SECOND = (2, "track: the second input needs its own Track row.")
BLOCK = {"decision": "block", "reason": inputs_fixture.REASON}
WRAPPED = ("open", "fchmod", "fstat", "write", "fsync", "close", "link", "unlink", "remove", "stat", "lstat")
REAL = {name: getattr(os, name) for name in WRAPPED}


def run(*rows, turn="t1"):
    snapshot = {"v": 2, "session_id": inputs_fixture.SESSION, "turn_id": turn, "open": [], "candidates": [],
                "held": [], "inputs": [{"id": identity, "reason": reason} for identity, reason in rows]}
    return stop.decision({"session_id": inputs_fixture.SESSION}, snapshot)


def claim_path(config, identity=1):
    name = stop.claim_name(inputs_fixture.SESSION, f"input:{identity}", "uncovered_input")
    return Path(config) / "state" / "track" / "stop-holds" / "inputs" / name


def files(config):
    return sorted(str(path.relative_to(config)) for path in Path(config).rglob("*") if path.is_file())


def name_of(target):
    return None if isinstance(target, int) else Path(os.fsdecode(target)).name


class StorageFault:
    """Wraps the helper's os calls for one Stop.

    fail: name of one os call that always raises. after_publication: the first call made
    once the claim path exists raises (any mechanism: after O_EXCL create or after link).
    replace_on_inspect: a peer swaps the claim path right after code stats it, or right
    before code unlinks it. Every unlink target is recorded.
    """

    def __init__(self, claim, fail=None, after_publication=False, replace_on_inspect=False):
        self.claim, self.fail = claim, fail
        self.after_publication, self.replace_on_inspect = after_publication, replace_on_inspect
        self.failed = self.replaced = False
        self.unlinked, self.descriptors, self.link_errors = [], [], []
        self.stack = ExitStack()

    def published(self):
        try:
            REAL["lstat"](self.claim)
        except OSError:
            return False
        return True

    def replace(self):
        self.claim.rename(self.claim.with_name(self.claim.name + ".original"))
        self.claim.write_text("foreign replacement", encoding="utf-8")
        self.replaced = True

    def wrap(self, name):
        real = REAL[name]

        def call(*args, **kwargs):
            on_claim = bool(args) and name_of(args[0]) == self.claim.name
            if name in ("unlink", "remove"):
                self.unlinked.append(name_of(args[0]))
                if on_claim and self.replace_on_inspect and not self.replaced:
                    self.replace()
            if name == self.fail:
                raise PermissionError(f"FIXTURE: {name} denied")
            if self.after_publication and not self.failed and name != "open" and self.published():
                self.failed = True
                raise PermissionError(f"FIXTURE: {name} failed after the claim was published")
            try:
                result = real(*args, **kwargs)
            except FileExistsError:
                if name == "link":
                    self.link_errors.append("EEXIST")
                raise
            if name == "open":
                self.descriptors.append(result)
            if name in ("stat", "lstat") and on_claim and self.replace_on_inspect and not self.replaced:
                self.replace()
            return result
        return call

    def __enter__(self):
        for name in WRAPPED:
            self.stack.enter_context(patch.object(stop.os, name, self.wrap(name)))
        return self

    def __exit__(self, *exc):
        self.stack.close()
        return False


class LinkedInputClaimTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = directory.name
        environment = patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": self.config})
        environment.start()
        self.addCleanup(environment.stop)
        self.claim = claim_path(self.config)

    def test_peer_claim_published_first_is_kept_and_reported_held(self):  # pin (a)
        real_link, real_open = os.link, os.open

        def peer_publishes():
            if not self.claim.exists():
                self.claim.write_text("peer claim", encoding="utf-8")

        def link(source, target, *args, **kwargs):
            if name_of(target) == self.claim.name:
                peer_publishes()  # the window between the creator's temp and its link
            return real_link(source, target, *args, **kwargs)

        def exclusive_open(path, flags, *args, **kwargs):
            if name_of(path) == self.claim.name and flags & os.O_EXCL:
                peer_publishes()
            return real_open(path, flags, *args, **kwargs)

        with patch.object(stop.os, "link", link), patch.object(stop.os, "open", exclusive_open):
            self.assertEqual(run(FIRST, SECOND), {"decision": "block", "reason": SECOND[1]},
                             "a peer-held input must report held while the other input still blocks")
        self.assertEqual(self.claim.read_text(encoding="utf-8"), "peer claim", "the peer claim was touched")
        second = claim_path(self.config, 2)
        self.assertEqual(files(self.config), sorted(str(path.relative_to(self.config)) for path in (self.claim, second)),
                         "a creator temp or extra file was left behind")
        self.assertEqual(run(FIRST, SECOND, turn="t2"), {})

    def test_failure_before_link_leaves_no_claim_or_temp_and_retry_succeeds(self):  # pin (b)
        for call in ("fsync", "link", "close"):
            with self.subTest(call=call), tempfile.TemporaryDirectory() as config, \
                    patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
                with StorageFault(claim_path(config), fail=call) as fault:
                    self.assertEqual(run(FIRST), {}, f"{call} failure must not report a spent hold")
                if call == "close":
                    for descriptor in fault.descriptors:
                        try:
                            REAL["close"](descriptor)
                        except OSError:
                            pass
                self.assertEqual(files(config), [], f"{call} failure left a claim or temp behind")
                self.assertEqual(run(FIRST), BLOCK, f"{call} failure did not leave the input retryable")
                self.assertEqual(run(FIRST, turn="t2"), {})

    def test_replacement_after_a_successful_claim_is_never_touched(self):  # pin (c)
        with StorageFault(self.claim, after_publication=True, replace_on_inspect=True) as fault:
            run(FIRST)
        if not fault.replaced:
            fault.replace()  # no code inspected the path in flight: replace it after the claim
        self.assertTrue(self.claim.exists(), "cleanup deleted the replacement at the claim path")
        self.assertEqual(run(FIRST, turn="t2"), {})
        self.assertTrue(stop.claim_once(inputs_fixture.SESSION, "t3", "untracked_edit"))  # freshness cleanup ran
        old = time.time() - 30 * 24 * 60 * 60
        for path in Path(self.config).rglob("*"):
            os.utime(path, (old, old))
        self.assertTrue(stop.claim_once(inputs_fixture.SESSION, "t4", "untracked_edit"))
        self.assertTrue(self.claim.exists(), "a later cleanup deleted the replacement")
        self.assertEqual(self.claim.read_text(encoding="utf-8"), "foreign replacement")
        self.assertEqual(run(FIRST, turn="t5"), {})

    def test_input_claims_never_enter_the_freshness_cleanup_scan(self):  # pin (d)
        names = set()
        for identity in (1, 2, 3):
            self.assertTrue(stop.claim_once(inputs_fixture.SESSION, f"input:{identity}", "uncovered_input"))
            names.add(claim_path(self.config, identity).name)
        seen, original = [], Path.iterdir

        def recorded(path):
            rows = list(original(path))
            seen.extend(row.name for row in rows)
            return iter(rows)

        with patch.object(Path, "iterdir", recorded):
            self.assertTrue(stop.claim_once(inputs_fixture.SESSION, "t1", "untracked_edit"))
        self.assertFalse(names & set(seen), "the freshness cleanup scanned input claims")
        self.assertLessEqual(set(seen), {"inputs"}, "input claims take more than one parent entry")

    def test_claim_older_than_any_ttl_is_still_held(self):  # pin (e)
        self.assertEqual(run(FIRST), BLOCK)
        for path in Path(self.config).rglob("*"):
            os.utime(path, (1, 1))
        self.assertTrue(stop.claim_once(inputs_fixture.SESSION, "later", "untracked_edit"))
        self.assertTrue(self.claim.exists(), "an aged input claim was removed")
        self.assertEqual(run(FIRST, turn="t2"), {})

    def test_published_claim_path_is_never_unlinked_by_any_branch(self):  # amendment pin (1)
        scenarios = {"failure after publication": {"after_publication": True}}
        scenarios.update({f"{call} failure": {"fail": call} for call in ("fchmod", "write", "fsync", "close", "link")})
        for label, options in scenarios.items():
            with self.subTest(label), tempfile.TemporaryDirectory() as config, \
                    patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
                claim = claim_path(config)
                with StorageFault(claim, **options) as fault:
                    run(FIRST)
                if options.get("fail") == "close":
                    for descriptor in fault.descriptors:
                        try:
                            REAL["close"](descriptor)
                        except OSError:
                            pass
                self.assertNotIn(claim.name, fault.unlinked, f"{label}: a published claim path was unlinked")
                if options.get("after_publication"):
                    self.assertTrue(claim.exists(), f"{label}: the published claim was rolled back")
                temps = [name for name in fault.unlinked if name.startswith(claim.name + ".") and name.endswith(".tmp")]
                self.assertEqual(fault.unlinked, temps, f"{label}: unlinked something other than the creator's temp")

    def test_failure_after_link_reports_held_and_a_retry_sees_eexist(self):  # amendment pin (2)
        with StorageFault(self.claim, after_publication=True) as fault:
            self.assertEqual(run(FIRST), BLOCK, "a failure after publication must not look like not-held")
        self.assertTrue(fault.failed, "the fixture never reached a step after publication")
        self.assertTrue(self.claim.exists(), "the published claim was rolled back")
        with StorageFault(self.claim) as retry:
            self.assertEqual(run(FIRST, turn="t2"), {})
        self.assertEqual(retry.link_errors, ["EEXIST"], "the retry did not meet the published claim at link")

    def test_output_failure_after_the_claim_keeps_the_input_held(self):  # amendment pin (2), output step
        payload = json.dumps({"session_id": inputs_fixture.SESSION})
        snapshot = {"v": 2, "session_id": inputs_fixture.SESSION, "turn_id": "t1", "open": [], "candidates": [],
                    "held": [], "inputs": [{"id": FIRST[0], "reason": FIRST[1]}]}
        environment = {**os.environ, "CLAUDE_CONFIG_DIR": self.config, "TRACK_GATE_SNAPSHOT": json.dumps(snapshot)}
        read, write = os.pipe()
        os.close(read)  # the host stopped reading: writing the block fails
        try:
            subprocess.run(["python3", str(inputs_fixture.SCRIPT)], input=payload, text=True, stdout=write,
                           stderr=subprocess.PIPE, env=environment, timeout=5, check=False)
        finally:
            os.close(write)
        self.assertTrue(self.claim.exists(), "the claim was not published or was rolled back")
        self.assertEqual(run(FIRST, turn="t2"), {})


if __name__ == "__main__":
    unittest.main()
