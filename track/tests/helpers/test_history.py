"""TRACK-39 V3-S1 new helper invariant coverage, not test-proven.

These are isolated OS FIXTURE tests of real helper subprocesses. They never
start an engine or touch the user's config. Missing history.py means only
"not runnable before P1"; it is not a causal RED or implementation evidence.
"""
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


HISTORY = Path(__file__).resolve().parents[2] / "hooks" / "history.py"
WRITER_LOCK = Path(__file__).resolve().parents[2] / "hooks" / "writer-lock.py"
RUNNER = Path(__file__).resolve().parent / "history_pause_runner.py"
INLINE_FILE = "track_inline-a0b48c8b9db0.json"
SKILLS_FILE = "track_skills-dir-df6c9fc8073b.json"
ROOT_KEYS = {
    "v", "session_id", "seq", "generation", "checkpoint", "savedAt", "object",
    "request_id", "recent", "writer",
}
SCRUB_ENVIRONMENT = {
    "TRACK_LOCK_PROTOCOL", "TRACK_LOCK_DIR", "CLAUDE_CONFIG_DIR",
    "PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX",
}
PINNED_HELPERS = {
    "writer-lock.py": "0efc8d47f824647d3186e61315adf29e9342bd84ce3b51da29f1ffbc829900b1",
    "write_transactions.py": "65948f77cad0dba71cd23a5fc2770eb8f6caddf89035d9db5ae7d947ec68388b",
    "blob-fs.py": "bc96ee378e2e6db1d83238bc7628cc0351868064bbda37cb2360b44fee9e84fd",
}


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def checksum(data):
    return hashlib.sha256(data).hexdigest()


class OwnedChild:
    """Own one subprocess, its receipt pipe, and its bounded teardown."""

    def __init__(self, command, environment, cwd, data=None):
        self.process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL if data is None else subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
            cwd=cwd, bufsize=0, start_new_session=True,
        )
        if data is not None:
            try:
                self.process.stdin.write(data)
                self.process.stdin.close()
                self.process.stdin = None
            except BaseException:
                self.stop()
                raise

    def receipt(self, row):
        deadline = time.monotonic() + 10
        output = bytearray()
        while b"\n" not in output:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"{row}: lease/grant receipt timed out")
            readable, _, _ = select.select([self.process.stdout], [], [], remaining)
            if not readable:
                raise AssertionError(f"{row}: lease/grant receipt timed out")
            chunk = os.read(self.process.stdout.fileno(), 4097)
            if not chunk:
                raise AssertionError(f"{row}: child closed stdout before a receipt")
            output.extend(chunk)
            if len(output) > 4096:
                raise AssertionError(f"{row}: lease/grant receipt exceeds 4096 bytes")
        if output.count(b"\n") != 1 or not output.endswith(b"\n"):
            raise AssertionError(f"{row}: lease/grant must emit one complete receipt")
        return json.loads(output)

    def finish(self, timeout=10):
        stdout, stderr = self.process.communicate(timeout=timeout)
        return subprocess.CompletedProcess(
            self.process.args, self.process.returncode, stdout, stderr,
        )

    def stop(self, kill=False):
        try:
            if self.process.poll() is None:
                if kill:
                    self.process.kill()
                else:
                    self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=2)
            else:
                self.process.wait(timeout=0)
        finally:
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream is not None:
                    stream.close()


class HistoryFixture(unittest.TestCase):
    """Own isolated config files, children and history wire assertions."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="track39-history-home-")).resolve()
        self.config = Path(tempfile.mkdtemp(prefix="track39-history-config-")).resolve()
        self.scratch = Path(tempfile.mkdtemp(prefix="track39-history-fixture-")).resolve()
        for directory in (self.home, self.config, self.scratch):
            self.addCleanup(shutil.rmtree, directory)
        self.children = []
        self.addCleanup(self.stop_children)
        self.environment = {
            name: value for name, value in os.environ.items()
            if name not in SCRUB_ENVIRONMENT
        }
        self.environment.update(HOME=str(self.home), CLAUDE_CONFIG_DIR=str(self.config))
        self.session = str(uuid.uuid4())
        self.token = "history-" + uuid.uuid4().hex
        self.generation = str(uuid.uuid4())
        self.nonce = uuid.uuid4().hex + uuid.uuid4().hex
        # Deliberately raise FileNotFoundError, never skip or synthesize history.
        # This remains the sole pre-P1 result, not a claimed behaviour failure.
        HISTORY.stat()

    def stop_children(self):
        for child in reversed(self.children):
            child.stop()

    def spawn(self, command, environment=None, data=None):
        child = OwnedChild(command, self.environment if environment is None else environment,
                           self.scratch, data)
        self.children.append(child)
        return child

    def engine_file(self, kind="plugins", *, config=None, filename=INLINE_FILE, nonce=None):
        anchor = self.config if config is None else config
        parent = anchor / kind
        parent.mkdir(mode=0o700, exist_ok=True)
        store = parent / "store"
        store.mkdir(mode=0o700, exist_ok=True)
        path = store / filename
        path.write_bytes(compact({"v3:bind": {"v": 1, "nonce": nonce or self.nonce}}))
        path.chmod(0o600)
        return path

    def parse_response(self, completed, request, row, allow_empty=False, *, preparse_oversize=False):
        if allow_empty and not completed.stdout:
            return None
        self.assertTrue(completed.stdout.endswith(b"\n"),
                        f"{row}: missing JSON line; stderr={completed.stderr!r}")
        self.assertEqual(completed.stdout.count(b"\n"), 1, f"{row}: exactly one stdout line")
        response = json.loads(completed.stdout)
        self.assertIsInstance(response, dict, f"{row}: response object")
        self.assertEqual(completed.stdout, compact(response) + b"\n",
                         f"{row}: compact UTF-8 response")
        self.assertEqual(response.get("protocol"), 3, f"{row}: protocol 3")
        self.assertEqual(response.get("op"), request["op"], f"{row}: echoed operation")
        if preparse_oversize:
            self.assertEqual(row, "H-size b", "preparse identity exception is exclusive to H-size(b)")
            self.assertEqual(request["op"], "save", "H-size b: raw-limit case is a save")
            self.assert_refusal(completed, response, row, "request too large")
        if request["op"] in ("save", "resolve") and (
                not preparse_oversize or "request_id" in response):
            self.assertEqual(response.get("request_id"), request["request_id"],
                             f"{row}: echoed request_id")
        return response

    def invoke(self, request, row, *, history=HISTORY, environment=None,
               runner_options=(), raw=None, allow_empty=False, preparse_oversize=False):
        if preparse_oversize:
            self.assertTrue(row == "H-size b" and request["op"] == "save"
                            and raw is not None and len(raw) > 3145728,
                            "preparse identity exception requires H-size(b)'s oversized raw save")
        command = [sys.executable, str(history), request["op"]]
        if runner_options:
            command = [sys.executable, str(RUNNER), str(history), request["op"],
                       *runner_options]
        completed = subprocess.run(
            command, input=compact(request) if raw is None else raw,
            capture_output=True, env=self.environment if environment is None else environment,
            cwd=self.scratch, timeout=20,
        )
        return completed, self.parse_response(completed, request, row, allow_empty,
                                              preparse_oversize=preparse_oversize)

    def assert_ok(self, completed, response, row):
        self.assertEqual(completed.returncode, 0, f"{row}: exit 0; {completed.stderr!r}")
        self.assertIs(response.get("ok"), True, f"{row}: accepted; {response!r}")

    def assert_refusal(self, completed, response, row, reason=None, phase="precommit"):
        self.assertEqual(completed.returncode, 1, f"{row}: refusal exit 1")
        self.assertIs(response.get("ok"), False, f"{row}: refused")
        self.assertEqual(response.get("phase"), phase, f"{row}: refusal phase")
        if reason is not None:
            self.assertIn(reason, response.get("reason", ""), f"{row}: refusal reason")

    def bind_request(self):
        return {"v": 3, "op": "bind", "plugin": "track", "nonce": self.nonce}

    def bind(self, row, *, history=HISTORY, environment=None):
        completed, response = self.invoke(self.bind_request(), row, history=history,
                                          environment=environment)
        self.assert_ok(completed, response, row)
        return response["store"]

    def start_lease(self, row, *, protocol=2, helper=WRITER_LOCK, session=None):
        environment = dict(self.environment)
        if protocol == 2:
            environment["TRACK_LOCK_PROTOCOL"] = "2"
        else:
            environment.pop("TRACK_LOCK_PROTOCOL", None)
        child = self.spawn([sys.executable, str(helper), "lease", session or self.session,
                            self.token], environment)
        receipt = child.receipt(row)
        expected = {"ok": True, "mode": "lease", "token": self.token}
        if protocol == 2:
            expected["protocol"] = 2
        self.assertEqual(receipt, expected, f"{row}: real lease receipt")
        return child

    def prepare(self, row, *, lease=True):
        self.engine_file()
        store = self.bind(row)
        if lease:
            self.start_lease(row)
        return store

    def save_request(self, store, *, expect=None, revision=1, semantic_checksum=None,
                     ledger_text=None):
        return {
            "v": 3, "op": "save", "store": store, "session_id": self.session,
            "module_token": self.token, "request_id": str(uuid.uuid4()),
            "expect": {"absent": True} if expect is None else expect,
            "generation": self.generation,
            "checkpoint": {
                "v": 1, "ok": True, "source_session": self.session, "revision": revision,
                "checksum": semantic_checksum or checksum(b"checkpoint semantics one"),
                "counts": {"questions": 1, "answers": 0, "steps": 0},
            },
            "savedAt": 1700000000,
            "ledger_text": (compact({"rows": [{"id": "one"}], "metadata": {}}).decode("utf-8")
                            if ledger_text is None else ledger_text),
        }

    def seed(self, row, *, history=HISTORY):
        store = self.prepare(row)
        request = self.save_request(store)
        completed, receipt = self.invoke(request, row, history=history)
        self.assert_ok(completed, receipt, row)
        return store, request, receipt

    def expected_root(self, receipt):
        return {"seq": receipt["seq"], "root_sha256": receipt["root_sha256"]}

    def read(self, store, row, *, history=HISTORY):
        request = {"v": 3, "op": "read", "store": store, "session_id": self.session}
        completed, response = self.invoke(request, row, history=history)
        self.assert_ok(completed, response, row)
        return completed, response

    def resolve_request(self, save, resolve_id=None):
        return {
            "v": 3, "op": "resolve", "store": save["store"],
            "session_id": save["session_id"], "module_token": save["module_token"],
            "request_id": save["request_id"], "expect": copy.deepcopy(save["expect"]),
            "resolve_id": str(uuid.uuid4()) if resolve_id is None else resolve_id,
        }

    def root_path(self, store):
        return self.config / "state" / "track" / "v3" / store / "roots" / (self.session + ".json")

    def root_snapshot(self, store):
        path = self.root_path(store)
        if not path.exists():
            return None
        return path.read_bytes(), path.stat().st_ino

    def inventory(self):
        anchor = self.config / "state" / "track"
        v3 = anchor / "v3"
        if not v3.exists():
            return []
        entries = []
        for path in (v3, *v3.rglob("*")):
            info = path.lstat()
            kind = "directory" if stat.S_ISDIR(info.st_mode) else "file"
            digest = checksum(path.read_bytes()) if stat.S_ISREG(info.st_mode) else None
            entries.append((str(path.relative_to(anchor)), kind, stat.S_IMODE(info.st_mode),
                            info.st_nlink, info.st_size, digest, info.st_ino))
        return sorted(entries)

    @contextmanager
    def paused(self, request, target, row):
        ready = self.scratch / ("ready-" + uuid.uuid4().hex)
        go = self.scratch / ("go-" + uuid.uuid4().hex)
        os.mkfifo(ready, 0o600)
        os.mkfifo(go, 0o600)
        # RDWR keeps the parent endpoints open until the child completes; ready
        # readiness then means bytes arrived, never a transient FIFO EOF.
        ready_fd = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        go_fd = os.open(go, os.O_RDWR | os.O_NONBLOCK)
        child = None
        try:
            command = [sys.executable, str(RUNNER), str(HISTORY), request["op"],
                       "--pause-at", target, "--ready", str(ready), "--go", str(go)]
            child = self.spawn(command, data=compact(request))
            readable, _, _ = select.select([ready_fd], [], [], 10)
            self.assertTrue(readable, f"{row}: ready FIFO timed out at {target}")
            line = os.read(ready_fd, 4096)
            self.assertEqual(line, f"paused {target}\n".encode(),
                             f"{row}: exact pause handshake")

            def resume():
                self.assertEqual(os.write(go_fd, b"go\n"), 3, f"{row}: go handshake")

            yield child, resume
        finally:
            if child is not None:
                child.stop()
            os.close(go_fd)
            os.close(ready_fd)


class IdentityTests(HistoryFixture):
    """Pin engine-store identity without relying on a plugin's root path."""

    def test_h_key_cowork(self):
        self.engine_file("cowork_plugins")
        cowork = self.bind("H-key-cowork")
        second_config = self.scratch / "separate-config"
        second_config.mkdir(mode=0o700)
        self.engine_file(config=second_config)
        plugins = self.bind("H-key-cowork", environment=dict(
            self.environment, CLAUDE_CONFIG_DIR=str(second_config)))
        self.assertEqual(cowork, "cowork_plugins--track_inline-a0b48c8b9db0", "H-key-cowork")
        self.assertEqual(plugins, "plugins--track_inline-a0b48c8b9db0", "H-key-cowork")
        self.assertNotEqual(cowork, plugins, "H-key-cowork: namespaces differ")

    def test_h_key_skills_dir(self):
        self.engine_file(filename=SKILLS_FILE)
        self.assertEqual(self.bind("H-key-skills-dir"),
                         "plugins--track_skills-dir-df6c9fc8073b", "H-key-skills-dir: ce pin")

    def test_h_key_both(self):
        self.engine_file()
        self.engine_file("cowork_plugins")
        completed, response = self.invoke(self.bind_request(), "H-key-both")
        self.assert_refusal(completed, response, "H-key-both", "store identity ambiguous")
        self.assertEqual(self.inventory(), [], "H-key-both: no v3 created")

    def test_h_key_none(self):
        self.engine_file("other_cache")
        environment = dict(self.environment,
                           CLAUDE_CODE_PLUGIN_CACHE_DIR=str(self.config / "other_cache"))
        completed, response = self.invoke(self.bind_request(), "H-key-none",
                                          environment=environment)
        self.assert_refusal(completed, response, "H-key-none", "store identity unproven")
        self.assertEqual(self.inventory(), [], "H-key-none: no v3 created")

    def test_h_key_alias(self):
        self.engine_file()
        store = self.bind("H-key-alias")
        before = self.inventory()
        alias = self.scratch / "alias"
        alias.symlink_to(self.config, target_is_directory=True)
        aliased = self.bind("H-key-alias", environment=dict(
            self.environment, CLAUDE_CONFIG_DIR=str(alias)))
        self.assertEqual(aliased, store, "H-key-alias: canonical config identity")
        self.assertEqual(self.inventory(), before, "H-key-alias: one unchanged chain")

    def test_h_key_replace(self):
        engine = self.engine_file()
        store = self.bind("H-key-replace")
        old_inode = engine.stat().st_ino
        self.nonce = uuid.uuid4().hex + uuid.uuid4().hex
        replacement = engine.with_name("replacement")
        replacement.write_bytes(compact({"v3:bind": {"v": 1, "nonce": self.nonce}}))
        replacement.chmod(0o600)
        os.replace(replacement, engine)
        self.assertNotEqual(engine.stat().st_ino, old_inode, "H-key-replace: actual replacement")
        self.assertEqual(self.bind("H-key-replace"), store, "H-key-replace: inode independent")

    def test_h_key_symlinked_store(self):
        self.engine_file()
        (self.config / "cowork_plugins").symlink_to(self.config / "plugins",
                                                   target_is_directory=True)
        self.assertEqual(self.bind("H-key-symlinked-store"),
                         "plugins--track_inline-a0b48c8b9db0",
                         "H-key-symlinked-store: symlink candidate not scanned")

    def test_h_root(self):
        copies = []
        for name in ("plugin-one", "plugin-two"):
            directory = self.scratch / name
            directory.mkdir(mode=0o700)
            for filename in ("history.py", "write_transactions.py", "blob-fs.py"):
                shutil.copyfile(HISTORY.with_name(filename), directory / filename)
            copies.append(directory / "history.py")
        self.engine_file()
        store = self.bind("H-root", history=copies[0])
        self.start_lease("H-root")
        request = self.save_request(store)
        completed, response = self.invoke(request, "H-root", history=copies[0])
        self.assert_ok(completed, response, "H-root")
        self.assertEqual(self.bind("H-root", history=copies[1]), store, "H-root: same key")
        _, read = self.read(store, "H-root", history=copies[1])
        self.assertEqual(read["ledger_text"], request["ledger_text"], "H-root: cross-root read")

    def test_h_race(self):
        self.engine_file()
        request = self.bind_request()
        with self.paused(request, "after-acquire", "H-race") as (first, resume):
            second = self.spawn([sys.executable, str(HISTORY), "bind"], data=compact(request))
            readable, _, _ = select.select([second.process.stdout], [], [], 1.0)
            self.assertFalse(readable, "H-race: B has no receipt during the one-second probe")
            self.assertIsNone(second.process.poll(), "H-race: B remains running after 1.0 s")
            resume()
            first_result = first.finish(timeout=10)
            first_response = self.parse_response(first_result, request, "H-race A")
            self.assert_ok(first_result, first_response, "H-race A")
            second_result = second.finish(timeout=10)
            second_response = self.parse_response(second_result, request, "H-race B")
            self.assert_ok(second_result, second_response, "H-race B")
        self.assertEqual(first_response["store"], second_response["store"], "H-race: same key")
        self.assertEqual(len(self.inventory()), 4, "H-race: exactly one empty chain")

    def test_h_race_revert(self):
        engine = self.engine_file()
        self.bind("H-race-revert")
        before = self.inventory()
        engine.write_bytes(compact({"old": "engine snapshot without nonce"}))
        completed, response = self.invoke(self.bind_request(), "H-race-revert")
        self.assert_refusal(completed, response, "H-race-revert", "store identity unproven")
        self.assertEqual(self.inventory(), before, "H-race-revert: no chain mutation")


class PersistenceTests(HistoryFixture):
    """Pin persisted roots, compare-and-swap and semantic revision rules."""

    def test_h_p2(self):
        store, request, receipt = self.seed("H-P2")
        self.assertEqual(store, "plugins--track_inline-a0b48c8b9db0", "H-P2: inline ce pin")
        self.assertEqual(receipt["seq"], 1, "H-P2: first sequence")
        self.assertRegex(receipt["root_sha256"], r"^[0-9a-f]{64}$", "H-P2: root digest")
        self.assertEqual(receipt["request_id"], request["request_id"], "H-P2: request echo")
        _, read = self.read(store, "H-P2")
        self.assertEqual(read["state"], "valid", "H-P2: fresh-process read")
        self.assertEqual(read["ledger_text"], request["ledger_text"], "H-P2: saved ledger")
        self.assertEqual(set(read["root"]), ROOT_KEYS, "H-P2: exact A4 root keys")
        self.assertEqual(checksum(self.root_path(store).read_bytes()), receipt["root_sha256"],
                         "H-P2: receipt hashes actual root bytes")
        self.assertEqual(read["root_sha256"], receipt["root_sha256"], "H-P2: read root hash")
        self.assertEqual(read["root"]["recent"], [
            {"kind": "save", "request_id": request["request_id"], "seq": 1},
        ], "H-P2: exact first recent entry")
        prefix = "v3/" + store
        object_hash = checksum(request["ledger_text"].encode("utf-8"))
        expected_paths = {
            "v3", prefix, prefix + "/roots", prefix + "/objects",
            prefix + "/roots/" + self.session + ".json",
            prefix + "/objects/" + object_hash + ".json",
        }
        inventory = self.inventory()
        self.assertEqual({entry[0] for entry in inventory}, expected_paths, "H-P2: exact inventory")
        for entry in inventory:
            if entry[1] == "directory":
                self.assertEqual(entry[2], 0o700, "H-P2: private directory")
            else:
                self.assertEqual(entry[2], 0o600, "H-P2: private file")
                self.assertEqual(entry[3], 1, "H-P2: single-link file")

    def test_h_cas(self):
        store, first, first_receipt = self.seed("H-cas")
        before = self.root_snapshot(store)
        completed, response = self.invoke(first, "H-cas duplicate")
        self.assert_refusal(completed, response, "H-cas duplicate", "stale request")
        self.assertEqual(self.root_snapshot(store), before, "H-cas: duplicate keeps bytes and inode")
        second = self.save_request(store, expect=self.expected_root(first_receipt))
        completed, current_receipt = self.invoke(second, "H-cas current")
        self.assert_ok(completed, current_receipt, "H-cas current")
        self.assertEqual(current_receipt["seq"], 2, "H-cas: current CAS advances sequence")
        late = self.save_request(store, expect=self.expected_root(first_receipt))
        self.assertNotEqual(late["request_id"], first["request_id"], "H-cas: fresh late request id")
        self.assertNotEqual(late["request_id"], second["request_id"], "H-cas: late id is not replayed")
        before = self.root_snapshot(store)
        completed, response = self.invoke(late, "H-cas late")
        self.assert_refusal(completed, response, "H-cas late", "stale request")
        self.assertEqual(self.root_snapshot(store), before, "H-cas: late request keeps bytes and inode")
        wrong_digest = "0" * 64 if current_receipt["root_sha256"] != "0" * 64 else "1" * 64
        wrong_hash = self.save_request(store, expect={
            "seq": current_receipt["seq"], "root_sha256": wrong_digest,
        })
        self.assertNotIn(wrong_hash["request_id"],
                         (first["request_id"], second["request_id"], late["request_id"]),
                         "H-cas: wrong-digest request id is fresh")
        self.assertEqual(wrong_hash["expect"]["seq"], current_receipt["seq"],
                         "H-cas: wrong digest uses the current sequence")
        self.assertNotEqual(wrong_hash["expect"]["root_sha256"], current_receipt["root_sha256"],
                            "H-cas: wrong digest differs from the current digest")
        before = self.root_snapshot(store)
        completed, response = self.invoke(wrong_hash, "H-cas wrong digest")
        self.assert_refusal(completed, response, "H-cas wrong digest", "stale request")
        self.assertEqual(self.root_snapshot(store), before,
                         "H-cas: wrong digest keeps root bytes and inode")

    def test_h_gen(self):
        store, initial, receipt = self.seed("H-gen")
        metadata_only = json.loads(initial["ledger_text"])
        metadata_only["metadata"]["note"] = "changed outside the checkpoint"
        variants = (
            ("a", initial["ledger_text"], initial["checkpoint"]["checksum"], 1),
            ("b", compact(metadata_only).decode("utf-8"), initial["checkpoint"]["checksum"], 1),
            ("c", initial["ledger_text"], checksum(b"checkpoint semantics two"), 2),
        )
        for label, ledger, semantic_checksum, revision in variants:
            with self.subTest(case=label):
                request = self.save_request(store, expect=self.expected_root(receipt),
                                            ledger_text=ledger, revision=revision,
                                            semantic_checksum=semantic_checksum)
                completed, receipt = self.invoke(request, "H-gen " + label)
                self.assert_ok(completed, receipt, "H-gen " + label)
                self.assertEqual(receipt["seq"], {"a": 2, "b": 3, "c": 4}[label],
                                 "H-gen: every metadata or content save advances seq")
                _, read = self.read(store, "H-gen " + label)
                self.assertEqual(read["root"]["checkpoint"], request["checkpoint"],
                                 "H-gen: requested semantic checkpoint retained")
                self.assertEqual(read["ledger_text"], ledger, "H-gen: requested ledger retained")

    def test_h_gen_wrong(self):
        store, initial, receipt = self.seed("H-gen-wrong")
        for case in ("d", "e", "f", "g", "h"):
            with self.subTest(case=case):
                request = self.save_request(store, expect=self.expected_root(receipt))
                if case == "d":
                    request["checkpoint"]["checksum"] = checksum(b"different checkpoint")
                elif case == "e":
                    request["checkpoint"]["revision"] = initial["checkpoint"]["revision"] + 1
                elif case == "f":
                    request["checkpoint"].update(checksum=checksum(b"different checkpoint"), revision=3)
                elif case == "g":
                    request["generation"] = str(uuid.uuid4())
                else:
                    request["checkpoint"]["source_session"] = str(uuid.uuid4())
                before = self.root_snapshot(store)
                completed, response = self.invoke(request, "H-gen-wrong " + case)
                self.assert_refusal(completed, response, "H-gen-wrong " + case)
                self.assertEqual(self.root_snapshot(store), before,
                                 "H-gen-wrong: refused revision/identity keeps root bytes and inode")


class LeaseAndLockTests(HistoryFixture):
    """Probe real leases and kernel lock ownership through commit boundaries."""

    def test_h_lease_foreign_token(self):
        store = self.prepare("H-lease a")
        request = self.save_request(store)
        request["module_token"] = "foreign-" + uuid.uuid4().hex
        before = self.inventory()
        completed, response = self.invoke(request, "H-lease a")
        self.assert_refusal(completed, response, "H-lease a")
        self.assertEqual(self.inventory(), before, "H-lease a: zero new entries")

    def test_h_lease_protocol_one(self):
        store = self.prepare("H-lease b", lease=False)
        self.start_lease("H-lease b", protocol=1)
        before = self.inventory()
        completed, response = self.invoke(self.save_request(store), "H-lease b")
        self.assert_refusal(completed, response, "H-lease b")
        self.assertEqual(self.inventory(), before, "H-lease b: protocol 1 cannot mutate v3")

    def test_h_lease_dead(self):
        store = self.prepare("H-lease c", lease=False)
        lease = self.start_lease("H-lease c")
        lease.stop(kill=True)
        self.assertIsNotNone(lease.process.poll(), "H-lease c: owned lease was killed and reaped")
        before = self.inventory()
        completed, response = self.invoke(self.save_request(store), "H-lease c")
        self.assert_refusal(completed, response, "H-lease c")
        self.assertEqual(self.inventory(), before, "H-lease c: dead lease creates nothing")

    def test_h_flock_busy(self):
        store = self.prepare("H-flock busy")
        before = self.inventory()
        lock = self.config / "state" / "track" / "locks" / "store.lock"
        with lock.open("r+") as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            started = time.monotonic()
            completed, response = self.invoke(self.save_request(store), "H-flock busy")
            elapsed = time.monotonic() - started
        self.assert_refusal(completed, response, "H-flock busy", "store writer is busy")
        self.assertGreaterEqual(elapsed, 2.9, "H-flock: real bounded acquire waited at least 2.9 s")
        self.assertEqual(self.inventory(), before, "H-flock: busy save leaves inventory unchanged")

    def assert_commit_lock(self, target):
        row = "H-flock " + target
        store = self.prepare(row)
        request = self.save_request(store)
        lock = self.config / "state" / "track" / "locks" / "store.lock"
        with self.paused(request, target, row) as (child, resume):
            with lock.open("r+") as descriptor:
                with self.assertRaises(BlockingIOError, msg=row + ": EX held at commit boundary"):
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with lock.open("r+") as descriptor:
                with self.assertRaises(BlockingIOError, msg=row + ": shared probe blocked by exclusive save"):
                    fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            resume()
            completed = child.finish()
            response = self.parse_response(completed, request, row)
            self.assert_ok(completed, response, row)
        return response

    def test_h_flock_before_link(self):
        self.assertEqual(self.assert_commit_lock("before-link")["seq"], 1,
                         "H-flock before-link: publication completed under real lock")

    def test_h_flock_before_rename(self):
        self.assertEqual(self.assert_commit_lock("before-rename")["seq"], 1,
                         "H-flock before-rename: root commit completed under real lock")


class RecoveryTests(HistoryFixture):
    """Assert uncertain saves resolve by durable commit or durable fence."""

    def assert_fault_outcome(self, target, committed):
        row = "H-phase " + target
        store, _, receipt = self.seed(row)
        request = self.save_request(store, expect=self.expected_root(receipt),
                                    ledger_text='{"metadata":{"fault":"' + target + '"}}')
        before = self.root_snapshot(store)
        completed, response = self.invoke(request, row, runner_options=("--fail-at", target),
                                          allow_empty=target == "suppress-emit")
        if target == "suppress-emit":
            self.assertEqual(completed.returncode, 0, row + ": suppressed success exit")
            self.assertEqual(completed.stdout, b"", row + ": receipt lost")
        else:
            self.assert_refusal(completed, response, row,
                                phase="postcommit" if committed else "precommit")
        after = self.root_snapshot(store)
        if committed:
            self.assertNotEqual(after[0], before[0], row + ": actual committed root bytes changed")
        else:
            self.assertEqual(after, before, row + ": precommit root bytes and inode unchanged")
        resolution = self.resolve_request(request)
        completed, response = self.invoke(resolution, row + " resolve")
        self.assert_ok(completed, response, row + " resolve")
        return response["outcome"]

    def test_h_phase_before_publish(self):
        self.assertEqual(self.assert_fault_outcome("before-publish", False), "fenced",
                         "H-phase before-publish: resolve fences the uncommitted request")

    def test_h_phase_before_rename(self):
        self.assertEqual(self.assert_fault_outcome("before-rename", False), "fenced",
                         "H-phase before-rename: resolve fences the uncommitted request")

    def test_h_phase_after_rename_fsync(self):
        self.assertEqual(self.assert_fault_outcome("after-rename-fsync", True), "committed",
                         "H-phase after-rename-fsync: actual rename wins over failed fsync receipt")

    def test_h_phase_suppress_emit(self):
        self.assertEqual(self.assert_fault_outcome("suppress-emit", True), "committed",
                         "H-phase suppress-emit: lost receipt does not lose the commit")

    def fence_delayed_save(self, existing):
        row = "H-pend-before existing" if existing else "H-pend-before absent"
        if existing:
            store, _, receipt = self.seed(row)
            _, previous = self.read(store, row)
            expect = self.expected_root(receipt)
        else:
            store = self.prepare(row)
            previous = None
            expect = {"absent": True}
        request = self.save_request(store, expect=expect,
                                    ledger_text='{"metadata":{"delayed":true}}')
        resolution = self.resolve_request(request)
        with self.paused(request, "before-acquire", row) as (child, resume):
            completed, response = self.invoke(resolution, row + " resolve")
            self.assert_ok(completed, response, row + " resolve")
            self.assertEqual(response["outcome"], "fenced", row + ": durable fence wins")
            fence_snapshot = self.root_snapshot(store)
            fence = json.loads(fence_snapshot[0])
            resume()
            completed = child.finish()
            response = self.parse_response(completed, request, row)
            self.assert_refusal(completed, response, row, "stale request")
        self.assertEqual(self.root_snapshot(store), fence_snapshot, row + ": late save preserves fence")
        self.assertEqual(fence["request_id"], resolution["resolve_id"], row + ": fence writer id")
        self.assertEqual(fence["recent"][-1], {
            "kind": "fence", "request_id": resolution["resolve_id"],
            "seq": fence["seq"], "fences": request["request_id"],
        }, row + ": exact fence entry")
        return store, previous, fence

    def test_h_pend_before_existing(self):
        _, previous, fence = self.fence_delayed_save(True)
        self.assertEqual(fence["seq"], previous["root"]["seq"] + 1, "H-pend-before: fence seq+1")
        for field in ("generation", "checkpoint", "savedAt", "object"):
            self.assertEqual(fence[field], previous["root"][field],
                             "H-pend-before: existing content copied exactly")

    def test_h_pend_before_absent(self):
        store, _, fence = self.fence_delayed_save(False)
        self.assertEqual(fence["seq"], 1, "H-pend-before absent: first sequence")
        for field in ("generation", "checkpoint", "savedAt", "object"):
            self.assertIsNone(fence[field], "H-pend-before absent: all content fields null")
        _, read = self.read(store, "H-pend-before absent")
        self.assertEqual(read["state"], "valid", "H-pend-before absent: content-null root valid")
        self.assertIsNone(read["ledger_text"], "H-pend-before absent: empty history")

    def test_h_pend_after(self):
        store, _, receipt = self.seed("H-pend-after")
        request = self.save_request(store, expect=self.expected_root(receipt),
                                    ledger_text='{"metadata":{"inflight":true}}')
        resolution = self.resolve_request(request)
        with self.paused(request, "before-rename", "H-pend-after") as (child, resume):
            completed, response = self.invoke(resolution, "H-pend-after busy resolve")
            self.assert_refusal(completed, response, "H-pend-after busy resolve", "store writer is busy")
            resume()
            completed = child.finish()
            response = self.parse_response(completed, request, "H-pend-after save")
            self.assert_ok(completed, response, "H-pend-after save")
        completed, response = self.invoke(resolution, "H-pend-after terminal resolve")
        self.assert_ok(completed, response, "H-pend-after terminal resolve")
        self.assertEqual(response["outcome"], "committed", "H-pend-after: resolve sees completed save")

    def test_h_resolve_retry(self):
        store = self.prepare("H-resolve-retry")
        save = self.save_request(store)
        first = self.resolve_request(save)
        completed, _ = self.invoke(first, "H-resolve-retry lost receipt",
                                   runner_options=("--fail-at", "suppress-emit"), allow_empty=True)
        self.assertEqual(completed.returncode, 0, "H-resolve-retry: first fence succeeds")
        self.assertEqual(completed.stdout, b"", "H-resolve-retry: first fence receipt lost")
        before = self.root_snapshot(store)
        retry = self.resolve_request(save)
        self.assertNotEqual(retry["resolve_id"], first["resolve_id"], "H-resolve-retry: fresh resolve id")
        completed, response = self.invoke(retry, "H-resolve-retry")
        self.assert_ok(completed, response, "H-resolve-retry")
        self.assertEqual(response["outcome"], "fenced", "H-resolve-retry: same terminal outcome")
        _, read = self.read(store, "H-resolve-retry")
        self.assertEqual(sum(entry["kind"] == "fence" for entry in read["root"]["recent"]), 1,
                         "H-resolve-retry: exactly one fence entry")
        self.assertEqual(self.root_snapshot(store), before, "H-resolve-retry: no second root commit")


class SizeTests(HistoryFixture):
    """Pin independent raw-request and decoded UTF-8 ledger byte limits."""

    def padded_request(self, store):
        special = '"\\' + "".join(chr(code) for code in range(1, 32))
        ledger = compact({"special": special, "padding": "a" * 2048}).decode("utf-8")
        self.assertEqual(json.loads(ledger)["special"], special, "H-size: legal escaped controls")
        self.assertLessEqual(len(ledger.encode("utf-8")), 1048576, "H-size: bounded decoded ledger")
        request = self.save_request(store, ledger_text=ledger)
        base = compact(request)
        self.assertLess(len(base), 3145728, "H-size: compact base fits raw-input bound")
        padded = base + b" " * (3145728 - len(base))
        self.assertEqual(len(padded), 3145728, "H-size a: exactly 3 MiB raw stdin")
        self.assertEqual(json.loads(padded), request, "H-size a: whitespace preserves parsed object")
        return request, padded

    def ascii_ledger(self, length):
        overhead = len(compact({"payload": ""}))
        ledger = compact({"payload": "a" * (length - overhead)}).decode("utf-8")
        self.assertEqual(len(ledger.encode("utf-8")), length, "H-size: actual serialized ledger bytes")
        self.assertIsInstance(json.loads(ledger), dict, "H-size: valid JSON-object ledger")
        return ledger

    def test_h_size_a_request_limit(self):
        store = self.prepare("H-size a")
        request, raw = self.padded_request(store)
        completed, response = self.invoke(request, "H-size a", raw=raw)
        self.assert_ok(completed, response, "H-size a")
        read_result, read = self.read(store, "H-size a")
        self.assertEqual(read["ledger_text"], request["ledger_text"], "H-size a: escaped ledger retained")
        self.assertLessEqual(len(read_result.stdout), 4194304, "H-size a: fresh read fits SDK stdout")

    def test_h_size_b_request_over_limit(self):
        store = self.prepare("H-size b")
        request, raw = self.padded_request(store)
        completed, response = self.invoke(request, "H-size b setup", raw=raw)
        self.assert_ok(completed, response, "H-size b setup")
        before = self.root_snapshot(store)
        oversized = raw + b" "
        self.assertEqual(len(oversized), 3145729, "H-size b: exactly one byte over")
        self.assertEqual(json.loads(oversized), request, "H-size b: unchanged parsed object")
        completed, response = self.invoke(request, "H-size b", raw=oversized,
                                          preparse_oversize=True)
        self.assert_refusal(completed, response, "H-size b", "request too large")
        self.assertEqual(self.root_snapshot(store), before, "H-size b: root unchanged")

    def test_h_size_b_malformed_before_parse(self):
        store, _, receipt = self.seed("H-size b malformed setup")
        request = self.save_request(store, expect=self.expected_root(receipt))
        raw = b"{" + b" " * 3145728
        self.assertEqual(len(raw), 3145729, "H-size b: malformed input is exactly one byte over")
        with self.assertRaises(json.JSONDecodeError, msg="H-size b: oversized input is malformed"):
            json.loads(raw)
        before = self.root_snapshot(store)
        completed, response = self.invoke(request, "H-size b", raw=raw,
                                          preparse_oversize=True)
        self.assert_refusal(completed, response, "H-size b", "request too large")
        self.assertEqual(self.root_snapshot(store), before,
                         "H-size b: malformed oversized input keeps root bytes and inode")

    def test_h_size_utf8_byte_boundary(self):
        store = self.prepare("H-size UTF-8")
        overhead = len(compact({"payload": ""}))
        at_limit = compact({"payload": "é" * ((1048576 - overhead) // 2)
                            + "a" * ((1048576 - overhead) % 2)}).decode("utf-8")
        over_limit = compact({"payload": "é" * ((1048577 - overhead) // 2)
                              + "a" * ((1048577 - overhead) % 2)}).decode("utf-8")
        self.assertEqual(len(at_limit.encode("utf-8")), 1048576, "H-size UTF-8: exact byte limit")
        self.assertEqual(len(over_limit.encode("utf-8")), 1048577,
                         "H-size UTF-8: exactly one byte over ledger limit")
        self.assertLess(len(at_limit), len(at_limit.encode("utf-8")),
                        "H-size UTF-8: accepted ledger characters differ from bytes")
        self.assertLess(len(over_limit), 1048576,
                        "H-size UTF-8: oversized ledger has fewer than 1 MiB characters")
        self.assertLess(len(over_limit), len(over_limit.encode("utf-8")),
                        "H-size UTF-8: refused ledger characters differ from bytes")
        first = self.save_request(store, ledger_text=at_limit)
        self.assertLessEqual(len(compact(first)), 3145728,
                             "H-size UTF-8: accepted request fits raw-input bound")
        completed, receipt = self.invoke(first, "H-size UTF-8 at limit")
        self.assert_ok(completed, receipt, "H-size UTF-8 at limit")
        _, read_response = self.read(store, "H-size UTF-8 at limit")
        self.assertEqual(read_response["ledger_text"], at_limit,
                         "H-size UTF-8: fresh process reads identical ledger text")
        request = self.save_request(store, expect=self.expected_root(receipt),
                                    ledger_text=over_limit)
        self.assertNotEqual(request["request_id"], first["request_id"],
                            "H-size UTF-8: oversized ledger has a fresh request id")
        self.assertLessEqual(len(compact(request)), 3145728,
                             "H-size UTF-8: refused request fits raw-input bound")
        before = self.root_snapshot(store)
        completed, response = self.invoke(request, "H-size UTF-8 over limit")
        self.assert_refusal(completed, response, "H-size UTF-8 over limit", "ledger too large")
        self.assertEqual(self.root_snapshot(store), before,
                         "H-size UTF-8: refusal keeps root bytes and inode")

    def test_h_size_c_ledger_limit(self):
        store = self.prepare("H-size c")
        request = self.save_request(store, ledger_text=self.ascii_ledger(1048576))
        completed, response = self.invoke(request, "H-size c")
        self.assert_ok(completed, response, "H-size c")
        read_result, read = self.read(store, "H-size c")
        self.assertEqual(read["ledger_text"], request["ledger_text"], "H-size c: exact 1 MiB ledger")
        self.assertLessEqual(len(read_result.stdout), 4194304, "H-size c: fresh read fits SDK stdout")

    def test_h_size_d_ledger_over_limit(self):
        store, _, receipt = self.seed("H-size d")
        request = self.save_request(store, expect=self.expected_root(receipt),
                                    ledger_text=self.ascii_ledger(1048577))
        before = self.root_snapshot(store)
        completed, response = self.invoke(request, "H-size d")
        self.assert_refusal(completed, response, "H-size d", "ledger too large")
        self.assertEqual(self.root_snapshot(store), before, "H-size d: root unchanged")

    def test_h_size_e_nonobject_ledger(self):
        store, _, receipt = self.seed("H-size e")
        request = self.save_request(store, expect=self.expected_root(receipt), ledger_text="[]")
        before = self.root_snapshot(store)
        completed, response = self.invoke(request, "H-size e")
        self.assert_refusal(completed, response, "H-size e", "ledger is not a JSON object")
        self.assertEqual(self.root_snapshot(store), before, "H-size e: root unchanged")


class CompatibilityTests(HistoryFixture):
    """Keep legacy writers outside v3 and refuse untrusted root shapes."""

    def test_h_old(self):
        self.seed("H-old")
        old = self.scratch / "old-worktree"
        old.mkdir(mode=0o700)
        for filename, pinned in PINNED_HELPERS.items():
            source = WRITER_LOCK.with_name(filename)
            self.assertEqual(checksum(source.read_bytes()), pinned, "H-old: source bytes pinned")
            shutil.copyfile(source, old / filename)
            self.assertEqual(checksum((old / filename).read_bytes()), pinned, "H-old: copied bytes pinned")
        before = self.inventory()
        old_session = str(uuid.uuid4())
        old_lease = self.start_lease("H-old v2", helper=old / "writer-lock.py", session=old_session)
        environment = dict(self.environment, TRACK_LOCK_PROTOCOL="2")
        writer = self.spawn([sys.executable, str(old / "writer-lock.py"), "write", old_session,
                             self.token], environment)
        grant = writer.receipt("H-old write")
        self.assertIs(grant.get("ok"), True, "H-old: old protocol-2 write grant")
        self.assertEqual(grant.get("protocol"), 2, "H-old: write protocol")
        self.assertEqual(grant.get("mode"), "write", "H-old: write mode")
        writer.stop()
        guard = self.spawn([sys.executable, str(old / "writer-lock.py"), "guard", old_session,
                            self.token], environment)
        guard_receipt = guard.receipt("H-old guard")
        self.assertEqual(guard_receipt, {
            "ok": True, "protocol": 2, "mode": "guard", "token": self.token, "state": "live",
        }, "H-old: old guard sees its real live lease")
        guard.stop()
        old_lease.stop()
        self.start_lease("H-old v1", protocol=1, helper=old / "writer-lock.py",
                         session=str(uuid.uuid4()))
        legacy_text = '{"legacy":"object"}'
        legacy_blob = self.config / "state" / "track" / "blobs"
        digest = checksum(legacy_text.encode("utf-8"))
        completed = subprocess.run(
            [sys.executable, str(old / "blob-fs.py"), "publish", str(legacy_blob), digest],
            input=legacy_text.encode("utf-8"), capture_output=True,
            env=self.environment, cwd=self.scratch, timeout=20,
        )
        self.assertEqual(completed.returncode, 0, "H-old: legacy blob publication")
        self.assertIs(json.loads(completed.stdout)["ok"], True, "H-old: publication receipt")
        self.assertEqual((legacy_blob / (digest + ".json")).read_text(), legacy_text,
                         "H-old: publication actually wrote the legacy object")
        self.assertEqual(self.inventory(), before, "H-old: all legacy helpers leave v3 byte-identical")

    def assert_foreign_root_refused(self, kind):
        row = "H-foreign-entry " + kind
        store, _, receipt = self.seed(row)
        path = self.root_path(store)
        if kind == "v1":
            path.write_bytes(compact({"v": 1, "ledger": {"rows": []}, "session_id": self.session}))
        elif kind == "mode":
            path.chmod(0o644)
        else:
            os.link(path, self.scratch / "foreign-root-hardlink")
            self.assertEqual(path.stat().st_nlink, 2, row + ": actual hard link")
        before = self.root_snapshot(store)
        read = {"v": 3, "op": "read", "store": store, "session_id": self.session}
        completed, response = self.invoke(read, row + " read")
        self.assert_refusal(completed, response, row + " read", "v3 history damaged")
        self.assertEqual(self.root_snapshot(store), before, row + ": read preserves foreign bytes")
        request = self.save_request(store, expect=self.expected_root(receipt))
        completed, response = self.invoke(request, row + " save")
        self.assert_refusal(completed, response, row + " save", "v3 history damaged")
        self.assertEqual(self.root_snapshot(store), before, row + ": save preserves foreign bytes")
        return path

    def test_h_foreign_entry_v1(self):
        path = self.assert_foreign_root_refused("v1")
        self.assertEqual(json.loads(path.read_bytes())["v"], 1, "H-foreign-entry: v1 kept")

    def test_h_foreign_entry_mode(self):
        path = self.assert_foreign_root_refused("mode")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644, "H-foreign-entry: mode kept")

    def test_h_foreign_entry_hardlink(self):
        path = self.assert_foreign_root_refused("hardlink")
        self.assertEqual(path.stat().st_nlink, 2, "H-foreign-entry: links kept")


if __name__ == "__main__":
    unittest.main()
