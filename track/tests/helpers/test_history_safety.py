"""TRACK-39 safety regression FIXTUREs using real isolated subprocesses.

These checks reject permissive wire decoding, creation before unsafe-sibling
preflight, and lexical-path publication after namespace substitution. No LIVE
engine or user config is involved. Frozen fixture helpers remain unchanged.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import select
import stat
import sys
import tempfile
import uuid

from test_history import HISTORY, HistoryFixture, checksum, compact


RUNNER = Path(__file__).with_name("history_safety_runner.py")


def snapshot_tree(anchor):
    """Record entries, bytes and metadata without following any symlink."""
    if not anchor.exists():
        return []
    paths = [anchor]
    for parent, directories, files in os.walk(anchor, followlinks=False):
        paths.extend(Path(parent) / name for name in directories + files)
    entries = []
    for path in paths:
        info = path.lstat()
        digest = checksum(path.read_bytes()) if stat.S_ISREG(info.st_mode) else None
        target = os.readlink(path) if stat.S_ISLNK(info.st_mode) else None
        entries.append((str(path.relative_to(anchor)), stat.S_IFMT(info.st_mode),
                        stat.S_IMODE(info.st_mode), info.st_uid, info.st_dev,
                        info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns,
                        digest, target))
    return sorted(entries)


class HistorySafetyTests(HistoryFixture):
    """Exercise the three safety hypotheses inside owned temporary trees."""

    def assert_wire_encoding_refused(self, encoding):
        # Wrong implementation rejected: json.loads(bytes) autodetects non-UTF-8.
        self.engine_file()
        request = self.bind_request()
        namespace = self.config / "state" / "track" / "v3"
        before = snapshot_tree(namespace)
        completed, response = self.invoke(
            request, "wire " + encoding, raw=compact(request).decode("utf-8").encode(encoding))
        after = snapshot_tree(namespace)
        # Run the UTF-8 positive control even when the invalid encoding was accepted.
        control, accepted = self.invoke(request, "wire UTF-8 control")
        self.assert_ok(control, accepted, "wire UTF-8 control")
        self.assertEqual((completed.returncode, response.get("ok"),
                          response.get("phase"), after), (1, False, "precommit", before),
                         encoding + ": reject wire encoding without creating v3 entries")

    def test_wire_utf16_refused(self):
        self.assert_wire_encoding_refused("utf-16")

    def test_wire_utf32_refused(self):
        self.assert_wire_encoding_refused("utf-32")

    def assert_unsafe_sibling_refused(self, unsafe_name, unsafe_kind):
        # Wrong implementation rejected: create roots before checking objects,
        # or chmod an existing unsafe directory into acceptance.
        store = self.prepare("partial namespace", lease=False)
        namespace = self.root_path(store).parent.parent
        roots = namespace / "roots"
        objects = namespace / "objects"
        roots.rmdir()  # Both are empty directories created by this fixture's bind.
        objects.rmdir()
        unsafe = namespace / unsafe_name
        missing = namespace / ("roots" if unsafe_name == "objects" else "objects")
        if unsafe_kind == "symlink":
            target = Path(tempfile.mkdtemp(prefix="unsafe-target-", dir=self.scratch))
            unsafe.symlink_to(target, target_is_directory=True)
        else:
            unsafe.mkdir(mode=0o700)
            unsafe.chmod(0o755)
        anchor = self.config / "state" / "track" / "v3"
        before = snapshot_tree(anchor)
        completed, response = self.invoke(self.bind_request(), "unsafe partial namespace")
        self.assert_refusal(completed, response, "unsafe partial namespace")
        self.assertEqual(snapshot_tree(anchor), before,
                         unsafe_name + " " + unsafe_kind + ": refusal must preserve inventory and modes")
        self.assertFalse(missing.exists(), "refusal must not create the missing sibling")

    def test_partial_unsafe_objects_symlink(self):
        self.assert_unsafe_sibling_refused("objects", "symlink")

    def test_partial_unsafe_objects_mode(self):
        self.assert_unsafe_sibling_refused("objects", "mode")

    def test_partial_unsafe_roots_symlink(self):
        self.assert_unsafe_sibling_refused("roots", "symlink")

    def test_partial_unsafe_roots_mode(self):
        self.assert_unsafe_sibling_refused("roots", "mode")

    @contextmanager
    def paused_before_object_open(self, request):
        """Keep both FIFO endpoints owned and bound every child wait."""
        ready = self.scratch / ("ready-" + uuid.uuid4().hex)
        go = self.scratch / ("go-" + uuid.uuid4().hex)
        os.mkfifo(ready, 0o600)
        os.mkfifo(go, 0o600)
        ready_fd = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        go_fd = None
        child = None
        try:
            go_fd = os.open(go, os.O_RDWR | os.O_NONBLOCK)
            child = self.spawn([sys.executable, str(RUNNER), str(HISTORY),
                                "--ready", str(ready), "--go", str(go)], data=compact(request))
            readable, _, _ = select.select([ready_fd], [], [], 10)
            self.assertTrue(readable, "publication setup: object-publish pause timed out")
            self.assertEqual(os.read(ready_fd, 4096), b"paused before-object-publish\n",
                             "publication setup: exact before-publish handshake")

            def resume():
                self.assertEqual(os.write(go_fd, b"go\n"), 3, "publication: go handshake")

            yield child, resume
        finally:
            if child is not None:
                child.stop()
            if go_fd is not None:
                os.close(go_fd)
            os.close(ready_fd)

    def test_publication_positive_control(self):
        store, request, receipt = self.seed("publication positive control")
        self.assertEqual(receipt["seq"], 1, "positive control: successful first root")
        blob = self.root_path(store).parent.parent / "objects" / (
            checksum(request["ledger_text"].encode("utf-8")) + ".json")
        self.assertEqual(blob.read_bytes(), request["ledger_text"].encode("utf-8"),
                         "positive control: publisher stored the requested bytes")
        _, response = self.read(store, "publication positive control read")
        self.assertEqual(response["ledger_text"], request["ledger_text"],
                         "positive control: fresh helper reads published content")

    def test_publication_namespace_substitution(self):
        # Wrong implementation rejected: absolute lexical publication followed
        # only by a late namespace check can refuse after an escaped write.
        store = self.prepare("publication substitution")
        request = self.save_request(store)
        namespace = self.root_path(store).parent.parent
        moved = namespace.with_name("moved-" + uuid.uuid4().hex)
        outside = Path(tempfile.mkdtemp(prefix="outside-", dir=self.config))
        (outside / "objects").mkdir(mode=0o700)
        marker = outside / "objects" / "untouched-marker"
        marker.write_bytes(b"outside fixture must remain byte-identical")
        marker.chmod(0o600)
        before = snapshot_tree(outside)
        with self.paused_before_object_open(request) as (child, resume):
            namespace.rename(moved)
            namespace.symlink_to(outside, target_is_directory=True)
            self.assertTrue(namespace.is_symlink(), "publication setup: lexical path substituted")
            resume()
            completed = child.finish(timeout=10)
        response = self.parse_response(completed, request, "publication substitution")
        self.assert_refusal(completed, response, "publication substitution")
        self.assertEqual(list((moved / "roots").iterdir()), [],
                         "substitution must not commit a successful root in the pinned tree")
        self.assertFalse((outside / "roots").exists(),
                         "substitution must not commit a successful root outside")
        self.assertEqual(snapshot_tree(outside), before,
                         "publication must not add outside files or change outside bytes/modes")
