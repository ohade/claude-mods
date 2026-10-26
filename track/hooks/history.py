#!/usr/bin/env python3
"""Opt-in v3 history roots, fenced under the protocol-2 store mutex.

The engine store supplies only a bind nonce. History content lives exclusively
in a verified config namespace, and every copy or mutation holds store.lock.
This module does no work at import time beyond loading its adjacent libraries.
"""
from contextlib import contextmanager, ExitStack
import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time
import uuid


def load_adjacent(name, filename):
    specification = importlib.util.spec_from_file_location(
        name, Path(__file__).resolve().with_name(filename))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


transactions = load_adjacent("track_history_transactions", "write_transactions.py")
blob_fs = load_adjacent("track_history_blob_fs", "blob-fs.py")

MAX_REQUEST = 3 * 1024 * 1024
MAX_LEDGER = 1024 * 1024
MAX_ROOT = 64 * 1024
MAX_RESPONSE = 4 * 1024 * 1024 - MAX_ROOT
MAX_STORE = 4 * 1024 * 1024 + MAX_ROOT
MAX_INTEGER = 9007199254740991
HEX = re.compile(r"[0-9a-f]{64}")
PLUGIN = re.compile(r"[a-z0-9-]{1,64}")
TOKEN = re.compile(r"[A-Za-z0-9-]{1,64}")
RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", re.I)
STORE_KEY = re.compile(
    r"(plugins|cowork_plugins)--([a-z0-9_-]{1,64}-[0-9a-f]{12})")
ROOT_KEYS = {"v", "session_id", "seq", "generation", "checkpoint", "savedAt",
             "object", "request_id", "recent", "writer"}
CHECKPOINT_KEYS = {"v", "ok", "source_session", "destination_session",
                   "applied_checksum", "revision", "checksum", "counts", "reason"}
ROOT_NAME = re.compile(r"([0-9a-f-]{36})\.json")
ROOT_TEMP = re.compile(r"\.[0-9a-f-]{36}\.[0-9]+\.[0-9a-f]{16}\.tmp")
TRASH_NAME = re.compile(r"([0-9a-f-]{36})\.([1-9][0-9]*)\.([0-9a-f]{64})\.([0-9]+)\.json")
OBJECT_NAME = re.compile(r"([0-9a-f]{64})\.json")
OBJECT_TEMP = re.compile(r"\.[0-9a-f]{64}\.[0-9]+\.[0-9a-f]{16}\.tmp")
EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
TRASH_GRACE_MS = 24 * 60 * 60 * 1000


class HistoryError(RuntimeError):
    """A refusal whose phase is determined by the root rename boundary."""


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def emit(response):
    sys.stdout.buffer.write(encode(response) + b"\n")
    sys.stdout.buffer.flush()


def require(condition, reason):
    if not condition:
        raise HistoryError(reason)


def exact_keys(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def safe_integer(value, minimum=0, maximum=MAX_INTEGER):
    return type(value) is int and minimum <= value <= maximum


def matches(expression, value):
    return isinstance(value, str) and expression.fullmatch(value) is not None


def is_uuid(value, version=None):
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return False
    return str(parsed) == value and (version is None or parsed.version == version)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def invalid_constant(value):
    raise HistoryError("non-finite JSON number")


def parse_json(data):
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=invalid_constant)


def validate_checkpoint(checkpoint, session):
    require(isinstance(checkpoint, dict) and set(checkpoint) <= CHECKPOINT_KEYS,
            "invalid checkpoint keys")
    require(checkpoint.get("source_session") == session
            and safe_integer(checkpoint.get("revision"), 1), "invalid checkpoint identity or revision")
    validators = {
        "v": lambda value: type(value) is int and value == 1,
        "ok": lambda value: type(value) is bool,
        "source_session": lambda value: value == session,
        "destination_session": is_uuid,
        "applied_checksum": lambda value: matches(HEX, value),
        "revision": lambda value: safe_integer(value, 1),
        "checksum": lambda value: value == "" or matches(HEX, value),
        "counts": lambda value: exact_keys(value, ("questions", "answers", "steps"))
        and all(safe_integer(count) for count in value.values()),
        "reason": lambda value: isinstance(value, str) and len(value) <= 1024,
    }
    for key, value in checkpoint.items():
        require(validators[key](value), "invalid checkpoint " + key)
    require(len(encode(checkpoint)) <= 4096, "checkpoint too large")


def validate_owner(owner):
    require(exact_keys(owner, ("pid", "start", "hostname", "boot_id", "unknown", "reason")),
            "invalid writer owner keys")
    require(safe_integer(owner["pid"], 1) and type(owner["unknown"]) is bool
            and isinstance(owner["reason"], str), "invalid writer owner")
    require(owner["hostname"] is None or isinstance(owner["hostname"], str),
            "invalid writer hostname")
    require(owner["boot_id"] is None or is_uuid(owner["boot_id"]), "invalid writer boot identity")
    start = owner["start"]
    require(start is None or (exact_keys(start, ("sec", "usec"))
                             and safe_integer(start["sec"], 1)
                             and safe_integer(start["usec"], 0, 999999)),
            "invalid writer birth identity")
    require(len(encode(owner)) <= 1024, "writer owner too large")


def validate_recent(root):
    recent = root["recent"]
    require(isinstance(recent, list) and 1 <= len(recent) <= 8, "invalid recent entries")
    previous = 0
    for entry in recent:
        require(isinstance(entry, dict), "invalid recent entry")
        kind = entry.get("kind")
        keys = {"kind", "request_id", "seq"} | ({"fences"} if kind == "fence" else set())
        require(kind in ("save", "fence") and exact_keys(entry, keys), "invalid recent entry keys")
        require(is_uuid(entry["request_id"], 4) and safe_integer(entry["seq"], previous + 1)
                and entry["seq"] <= root["seq"], "invalid recent identity or sequence")
        if kind == "fence":
            require(is_uuid(entry["fences"], 4), "invalid fenced request")
        previous = entry["seq"]
    require(recent[-1]["seq"] == root["seq"]
            and recent[-1]["request_id"] == root["request_id"], "recent does not describe root")


def validate_root(root, session):
    require(exact_keys(root, ROOT_KEYS), "invalid root keys")
    require(type(root["v"]) is int and root["v"] == 3
            and root["session_id"] == session and is_uuid(session, 4), "invalid root identity")
    require(safe_integer(root["seq"], 1) and is_uuid(root["request_id"], 4),
            "invalid root sequence or request")
    content = [root[key] for key in ("generation", "checkpoint", "savedAt", "object")]
    require(all(value is None for value in content) or all(value is not None for value in content),
            "inconsistent null content")
    if root["object"] is not None:
        require(is_uuid(root["generation"]), "invalid generation")
        validate_checkpoint(root["checkpoint"], session)
        require(type(root["savedAt"]) in (int, float) and math.isfinite(root["savedAt"]),
                "invalid savedAt")
        reference = root["object"]
        require(exact_keys(reference, ("checksum", "bytes"))
                and matches(HEX, reference["checksum"])
                and safe_integer(reference["bytes"], 0, MAX_LEDGER), "invalid object reference")
    validate_recent(root)
    writer = root["writer"]
    require(exact_keys(writer, ("module_token", "owner")) and matches(TOKEN, writer["module_token"]),
            "invalid writer")
    validate_owner(writer["owner"])


def validate_expect(expect):
    if exact_keys(expect, ("absent",)):
        require(expect["absent"] is True, "invalid absent expectation")
    else:
        require(exact_keys(expect, ("seq", "root_sha256"))
                and safe_integer(expect["seq"], 1) and matches(HEX, expect["root_sha256"]),
                "invalid root expectation")


def validate_request(request, operation):
    require(isinstance(request, dict), "request is not a JSON object")
    common = {"v", "op"}
    fields = {
        "bind": {"plugin", "nonce"},
        "read": {"store", "session_id"},
        "save": {"store", "session_id", "module_token", "request_id", "expect", "generation",
                 "checkpoint", "savedAt", "ledger_text"},
        "resolve": {"store", "session_id", "module_token", "request_id", "expect", "resolve_id"},
        "collect": {"store", "protected", "dry_run", "limit"},
        "restore": {"store", "session_id", "entry"},
    }
    require(exact_keys(request, common | fields[operation]) and type(request["v"]) is int
            and request["v"] == 3 and request["op"] == operation, "invalid request schema")
    if operation == "bind":
        require(matches(PLUGIN, request["plugin"]) and matches(HEX, request["nonce"]),
                "invalid bind identity")
        return
    if operation == "collect":
        protected = request["protected"]
        require(matches(STORE_KEY, request["store"]) and isinstance(protected, list)
                and len(protected) <= 64 and all(is_uuid(session, 4) for session in protected),
                "invalid namespace or protected sessions")
        require(type(request["dry_run"]) is bool and safe_integer(request["limit"], 1, 50),
                "invalid collect options")
        return
    require(matches(STORE_KEY, request["store"]) and is_uuid(request["session_id"], 4),
            "invalid namespace or session")
    if operation == "read":
        return
    if operation == "restore":
        entry = TRASH_NAME.fullmatch(request["entry"]) if isinstance(request["entry"], str) else None
        require(entry is not None and entry.group(1) == request["session_id"], "invalid trash entry")
        return
    require(matches(TOKEN, request["module_token"]) and is_uuid(request["request_id"], 4),
            "invalid writer or request identity")
    validate_expect(request["expect"])
    if operation == "resolve":
        require(is_uuid(request["resolve_id"], 4), "invalid resolve identity")
        return
    require(is_uuid(request["generation"]), "invalid generation")
    validate_checkpoint(request["checkpoint"], request["session_id"])
    require(type(request["savedAt"]) in (int, float) and math.isfinite(request["savedAt"]),
            "invalid savedAt")
    text = request["ledger_text"]
    require(isinstance(text, str), "ledger is not text")
    require(len(text.encode("utf-8")) <= MAX_LEDGER, "ledger too large")
    require(isinstance(parse_json(text), dict), "ledger is not a JSON object")


def engine_filename(storage_id):
    """Pinned engine 2.1.310 ce/nt, de=64 and st=12."""
    if (re.fullmatch(r"[a-z0-9._-]+", storage_id) and not RESERVED.match(storage_id)
            and len(storage_id) <= 64 and storage_id not in (".", "..")):
        return storage_id + ".json"
    stem = re.sub(r"[^a-zA-Z0-9_-]", "_", storage_id)[:64] or "plugin"
    return stem + "-" + hashlib.sha256(storage_id.encode("utf-8")).hexdigest()[:12] + ".json"


def enter_directory(handles, name, parent, device, *, private=False, create=False):
    missing = False
    if create:
        try:
            os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            missing = True
    descriptor = handles.enter_context(transactions.open_directory(
        name, parent=parent, private=private, create=create))
    require(os.fstat(descriptor).st_dev == device, "namespace crosses devices")
    if missing:
        os.fsync(parent)
    return descriptor


@contextmanager
def lock_namespace(config):
    with ExitStack() as handles:
        anchor = handles.enter_context(transactions.open_directory(config))
        device = os.fstat(anchor).st_dev
        state = enter_directory(handles, "state", anchor, device, create=True)
        track = enter_directory(handles, "track", state, device, create=True)
        locks = enter_directory(handles, "locks", track, device, private=True, create=True)
        yield {"anchor": anchor, "state": state, "track": track, "locks": locks}


@contextmanager
def history_namespace(config, key, locks, *, create=False):
    device = os.fstat(locks["anchor"]).st_dev
    with ExitStack() as handles:
        try:
            v3 = enter_directory(handles, "v3", locks["track"], device, private=True, create=create)
            namespace = enter_directory(handles, key, v3, device, private=True, create=create)
            children = {}
            # Validate both existing siblings before creating either missing one.
            for name in ("roots", "objects"):
                try:
                    children[name] = enter_directory(handles, name, namespace, device, private=True)
                except FileNotFoundError:
                    pass
            for name in ("roots", "objects"):
                if name not in children:
                    children[name] = enter_directory(
                        handles, name, namespace, device, private=True, create=create)
            roots, objects = children["roots"], children["objects"]
        except FileNotFoundError as error:
            raise HistoryError("namespace absent") from error
        directories = {**locks, "v3": v3, "namespace": namespace, "roots": roots, "objects": objects}
        verify_directories(config, key, directories)
        yield directories


def verify_directories(config, key, directories):
    """Reopen every component, so pinned fds cannot hide a replaced path."""
    with ExitStack() as handles:
        anchor = handles.enter_context(transactions.open_directory(config))
        require(transactions.same_file(os.fstat(anchor), os.fstat(directories["anchor"])),
                "config directory changed")
        device = os.fstat(anchor).st_dev
        opened = {"anchor": anchor}
        paths = (("state", "anchor", "state"), ("track", "state", "track"),
                 ("locks", "track", "locks"), ("v3", "track", "v3"),
                 ("namespace", "v3", key), ("roots", "namespace", "roots"),
                 ("objects", "namespace", "objects"))
        for label, parent, name in paths:
            descriptor = enter_directory(handles, name, opened[parent], device,
                                         private=label not in ("state", "track"))
            require(transactions.same_file(os.fstat(descriptor), os.fstat(directories[label])),
                    "namespace directory changed")
            opened[label] = descriptor


def read_leaf(directory, name, limit, *, sync=False):
    with transactions.open_leaf(directory, name) as descriptor:
        before = transactions.revalidate_leaf(directory, name, descriptor)
        require(stat.S_IMODE(before.st_mode) == 0o600, "file mode is not 0600")
        require(before.st_size <= limit, "file too large")
        data = os.pread(descriptor, limit + 1, 0)
        after = transactions.revalidate_leaf(directory, name, descriptor, before)
        require(len(data) <= limit and len(data) == after.st_size
                and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "file changed while reading")
        if sync:
            os.fsync(descriptor)
            os.fsync(directory)
            require(os.pread(descriptor, limit + 1, 0) == data, "file changed while syncing")
            synced = transactions.revalidate_leaf(directory, name, descriptor, before)
            require((after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                    == (synced.st_mode, synced.st_size, synced.st_mtime_ns, synced.st_ctime_ns),
                    "file changed while syncing")
        return data


def scan_bind(anchor, plugin, nonce):
    matches_found = []
    identities = set()
    for kind in ("plugins", "cowork_plugins"):
        with ExitStack() as handles:
            parent = None
            try:
                parent = handles.enter_context(transactions.open_directory(kind, parent=anchor))
                store = handles.enter_context(transactions.open_directory("store", parent=parent))
            except (FileNotFoundError, NotADirectoryError):
                continue
            except transactions.TransactionError as error:
                # Symlinked or non-directory candidate components are never scanned.
                try:
                    info = os.stat(kind, dir_fd=anchor, follow_symlinks=False)
                    unsafe_component = not stat.S_ISDIR(info.st_mode)
                    if not unsafe_component and parent is not None:
                        info = os.stat("store", dir_fd=parent, follow_symlinks=False)
                        unsafe_component = not stat.S_ISDIR(info.st_mode)
                except FileNotFoundError:
                    unsafe_component = True
                if unsafe_component:
                    continue
                raise HistoryError("store identity unproven") from error
            info = os.fstat(store)
            identity = (info.st_dev, info.st_ino)
            require(identity not in identities, "store directories alias")
            identities.add(identity)
            for source in ("inline", "skills-dir"):
                name = engine_filename(plugin + "@" + source)
                try:
                    with transactions.open_leaf(store, name) as descriptor:
                        info = transactions.revalidate_leaf(store, name, descriptor)
                        require(info.st_size <= MAX_STORE, "store identity unproven")
                        data = os.pread(descriptor, MAX_STORE + 1, 0)
                        require(len(data) <= MAX_STORE and len(data) == info.st_size,
                                "store identity unproven")
                        value = parse_json(data)
                        transactions.revalidate_leaf(store, name, descriptor, info)
                except FileNotFoundError:
                    continue
                require(isinstance(value, dict), "store identity unproven")
                binding = value.get("v3:bind")
                if (exact_keys(binding, ("v", "nonce")) and type(binding["v"]) is int
                        and binding["v"] == 1 and binding["nonce"] == nonce):
                    matches_found.append(kind + "--" + name[:-5])
    require(matches_found, "store identity unproven")
    require(len(matches_found) == 1, "store identity ambiguous")
    return matches_found[0]


def acquire_shared(descriptor, busy_reason, parent, disconnected):
    deadline = time.monotonic() + 3
    while True:
        require(transactions.owner_connected(parent, disconnected), "lock owner is no longer connected")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise HistoryError(busy_reason)
            time.sleep(0.01)


def read_current(directories, session):
    name = session + ".json"
    try:
        try:
            os.stat(name, dir_fd=directories["roots"], follow_symlinks=False)
        except FileNotFoundError:
            return None, None, None
        raw = read_leaf(directories["roots"], name, MAX_ROOT)
        root = parse_json(raw)
        validate_root(root, session)
        require(encode(root) == raw, "root is not compact UTF-8 JSON")
        text = None
        if root["object"] is not None:
            reference = root["object"]
            data = read_leaf(directories["objects"], reference["checksum"] + ".json", MAX_LEDGER)
            require(len(data) == reference["bytes"]
                    and hashlib.sha256(data).hexdigest() == reference["checksum"], "object checksum differs")
            text = data.decode("utf-8")
            require(isinstance(parse_json(text), dict), "object is not a JSON object")
        return root, hashlib.sha256(raw).hexdigest(), text
    except (HistoryError, transactions.TransactionError, OSError, ValueError, UnicodeError) as error:
        raise HistoryError("v3 history damaged: " + str(error)) from error


def read_response(root, digest, text):
    if root is None:
        return {"ok": True, "protocol": 3, "op": "read", "state": "absent"}
    return {"ok": True, "protocol": 3, "op": "read", "state": "valid",
            "root": root, "root_sha256": digest, "ledger_text": text}


def expectation_matches(expect, root, digest):
    if "absent" in expect:
        return root is None
    return root is not None and root["seq"] == expect["seq"] and digest == expect["root_sha256"]


def build_root(request, current, owner, *, fence=False):
    sequence = (current["seq"] if current else 0) + 1
    identifier = request["resolve_id"] if fence else request["request_id"]
    entry = {"kind": "fence" if fence else "save", "request_id": identifier, "seq": sequence}
    if fence:
        entry["fences"] = request["request_id"]
        content = {key: current[key] if current else None
                   for key in ("generation", "checkpoint", "savedAt", "object")}
    else:
        data = request["ledger_text"].encode("utf-8")
        content = {key: request[key] for key in ("generation", "checkpoint", "savedAt")}
        content["object"] = {"checksum": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    root = {"v": 3, "session_id": request["session_id"], "seq": sequence,
            **content, "request_id": identifier,
            "recent": (current["recent"][-7:] if current else []) + [entry],
            "writer": {"module_token": request["module_token"], "owner": owner}}
    validate_root(root, request["session_id"])
    require(len(encode(root)) <= MAX_ROOT, "root too large")
    return root


def check_revision(request, current):
    if current is None or current["object"] is None:
        return  # Request validation already requires a UUID and revision >= 1.
    require(request["generation"] == current["generation"], "generation does not match")
    previous = current["checkpoint"]
    expected_revision = previous["revision"] + (
        request["checkpoint"].get("checksum") != previous.get("checksum"))
    require(request["checkpoint"]["revision"] == expected_revision, "checkpoint revision does not match")


def publish_object(directories, object_path, checksum, text):
    name = checksum + ".json"
    data = text.encode("utf-8")
    pinned_objects = directories["objects"]
    pinned_identity = os.fstat(pinned_objects)

    def require_pinned_objects(descriptor):
        info = os.fstat(descriptor)
        transactions.validate_directory(info, private=True)
        require(transactions.same_file(info, pinned_identity)
                and info.st_dev == os.fstat(directories["anchor"]).st_dev,
                "object directory changed")

    def open_pinned_objects(directory):
        require(directory == object_path, "unexpected object directory")
        require_pinned_objects(pinned_objects)
        return os.dup(pinned_objects)

    def accept_pinned_existing(dir_fd, supplied_name, supplied_data):
        require_pinned_objects(dir_fd)
        require(supplied_name == name and supplied_data == data, "unexpected object publication")
        try:
            os.stat(supplied_name, dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            return False  # Only the initial pathname lookup can establish absence.
        require(read_leaf(dir_fd, supplied_name, MAX_LEDGER) == data, "existing object differs")
        return True

    # This fresh process handles one request; the publisher owns its duplicate.
    original_open_dir = blob_fs.open_dir
    original_accept_existing = blob_fs.accept_existing
    try:
        blob_fs.open_dir = open_pinned_objects
        blob_fs.accept_existing = accept_pinned_existing
        blob_fs.publish(object_path, checksum, text)
    finally:
        blob_fs.open_dir = original_open_dir
        blob_fs.accept_existing = original_accept_existing
    # Reuse must establish the same object-before-root barrier as a fresh publish.
    require(read_leaf(pinned_objects, name, MAX_LEDGER, sync=True) == data,
            "published object differs")


def commit_root(directories, root, mutation):
    name = root["session_id"] + ".json"
    temporary = "." + root["session_id"] + "." + str(os.getpid()) + "." + secrets.token_hex(8) + ".tmp"
    try:
        with transactions.open_leaf(directories["roots"], temporary, writable=True,
                                    create=True, exclusive=True) as descriptor:
            transactions.write_all(descriptor, encode(root))
            os.fsync(descriptor)
            transactions.revalidate_leaf(directories["roots"], temporary, descriptor)
        os.rename(temporary, name, src_dir_fd=directories["roots"], dst_dir_fd=directories["roots"])
        mutation["committed"] = True
        os.fsync(directories["roots"])
    finally:
        if not mutation["committed"]:
            try:
                os.unlink(temporary, dir_fd=directories["roots"])
            except FileNotFoundError:
                pass  # The exclusive temp was never created or was already renamed.


def run_history(request, config, directories, owner, mutation):
    operation = request["op"]
    session = request["session_id"]
    try:
        current, digest, text = read_current(directories, session)
    except (transactions.TransactionError, OSError) as error:
        raise HistoryError("v3 history damaged: " + str(error)) from error
    if operation == "read":
        response = read_response(current, digest, text)
        require(len(encode(response)) + 1 <= MAX_RESPONSE, "v3 history damaged: read response too large")
        verify_directories(config, request["store"], directories)
        return response
    if operation == "resolve":
        outcome = None
        for entry in current["recent"] if current else []:
            if entry["kind"] == "save" and entry["request_id"] == request["request_id"]:
                outcome = "committed"
                break
        if outcome is None and any(entry["kind"] == "fence" and entry["fences"] == request["request_id"]
                                   for entry in (current["recent"] if current is not None else [])):
            outcome = "fenced"
        if outcome is None and not expectation_matches(request["expect"], current, digest):
            outcome = "superseded"
        if outcome is not None:
            return {"ok": True, "protocol": 3, "op": operation, "request_id": request["request_id"],
                    "outcome": outcome, "seq": current["seq"] if current else None, "root_sha256": digest}
    else:
        require(expectation_matches(request["expect"], current, digest), "stale request")
        check_revision(request, current)
    root = build_root(request, current, owner, fence=operation == "resolve")
    raw = encode(root)
    new_digest = hashlib.sha256(raw).hexdigest()
    ledger = text if operation == "resolve" else request["ledger_text"]
    require(len(encode(read_response(root, new_digest, ledger))) + 1 <= MAX_RESPONSE, "ledger too large")
    verify_directories(config, request["store"], directories)
    if operation == "save":
        object_path = os.path.join(config, "state", "track", "v3", request["store"], "objects")
        publish_object(directories, object_path, root["object"]["checksum"], ledger)
        verify_directories(config, request["store"], directories)
    commit_root(directories, root, mutation)
    response = {"ok": True, "protocol": 3, "op": operation, "request_id": request["request_id"],
                "seq": root["seq"], "root_sha256": new_digest}
    if operation == "resolve":
        response["outcome"] = "fenced"
    return response


def now_ms():
    return time.time_ns() // 1000000


def stored_root(directory, name, session):
    """The compact bytes, root and digest of one root-shaped leaf."""
    raw = read_leaf(directory, name, MAX_ROOT)
    root = parse_json(raw)
    validate_root(root, session)
    require(encode(root) == raw, "root is not compact UTF-8 JSON")
    return raw, root, hashlib.sha256(raw).hexdigest()


def namespace_entries(directories, trash):
    """Every root, trash entry and object, or a refusal naming the first unknown entry."""
    roots, entries, objects = {}, {}, set()

    def unknown(name, error=None):
        raise HistoryError("v3 namespace has unknown entry: " + name) from error

    for name in sorted(os.listdir(directories["roots"])):
        found = ROOT_NAME.fullmatch(name)
        if found is None or not is_uuid(found.group(1), 4):
            if ROOT_TEMP.fullmatch(name) is None:
                unknown(name)
            continue
        try:
            raw, root, digest = stored_root(directories["roots"], name, found.group(1))
            mtime = os.stat(name, dir_fd=directories["roots"], follow_symlinks=False).st_mtime_ns // 1000000
        except (HistoryError, transactions.TransactionError, OSError, ValueError, UnicodeError) as error:
            unknown(name, error)
        roots[found.group(1)] = {"name": name, "root": root, "digest": digest, "mtime": mtime}
    for name in sorted(os.listdir(trash)) if trash is not None else []:
        found = TRASH_NAME.fullmatch(name)
        if found is None or not is_uuid(found.group(1), 4):
            unknown(name)
        try:
            raw, root, digest = stored_root(trash, name, found.group(1))
        except (HistoryError, transactions.TransactionError, OSError, ValueError, UnicodeError) as error:
            unknown(name, error)
        if root["seq"] != int(found.group(2)) or digest != found.group(3):
            unknown(name)
        entries[name] = {"root": root, "trashed_at": int(found.group(4))}
    for name in sorted(os.listdir(directories["objects"])):
        found = OBJECT_NAME.fullmatch(name)
        if found is None:
            if OBJECT_TEMP.fullmatch(name) is None:
                unknown(name)
            continue
        if not stat.S_ISREG(os.stat(name, dir_fd=directories["objects"], follow_symlinks=False).st_mode):
            unknown(name)
        objects.add(found.group(1))
    return roots, entries, objects


@contextmanager
def session_guard(locks, session):
    """Yields False while a live owner holds the session lease, else True with it held."""
    with ExitStack() as handles:
        try:
            descriptor = handles.enter_context(transactions.open_leaf(locks["locks"], session + ".lock"))
        except FileNotFoundError:
            descriptor = None  # No lock file means no live owner.
        if descriptor is not None:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
        yield True


def trash_directory(handles, directories, *, create):
    device = os.fstat(directories["anchor"]).st_dev
    try:
        return enter_directory(handles, "trash", directories["namespace"], device,
                               private=True, create=create)
    except FileNotFoundError:
        return None


def verify_trash(config, key, directories, trash):
    verify_directories(config, key, directories)
    current = os.stat("trash", dir_fd=directories["namespace"], follow_symlinks=False)
    require(transactions.same_file(current, os.fstat(trash)), "namespace directory changed")


def age_reason(saved_at, now):
    age = now - saved_at
    return "future" if age < 0 else "young" if age < EXPIRY_MS else None


def run_collect(request, config, directories, locks, mutation):
    """Moves expired roots to trash, then purges old trash and unnamed objects."""
    key, dry_run, protected = request["store"], request["dry_run"], set(request["protected"])
    with ExitStack() as handles:
        trash = trash_directory(handles, directories, create=False)
        roots, entries, objects = namespace_entries(directories, trash)
        now = now_ms()
        kept, candidates = [], []
        for session, found in sorted(roots.items()):
            root = found["root"]
            saved_at = found["mtime"] if root["savedAt"] is None else root["savedAt"]
            reason = "protected" if session in protected else age_reason(saved_at, now)
            if reason is None:
                candidates.append(session)
            else:
                kept.append({"session_id": session, "reason": reason})
        trashed, more = [], False
        for session in candidates:
            if len(trashed) == request["limit"]:
                more = True
                break
            found = roots[session]
            with session_guard(locks, session) as free:
                if not free:
                    kept.append({"session_id": session, "reason": "live"})
                    continue
                try:
                    unchanged = hashlib.sha256(read_leaf(directories["roots"], found["name"], MAX_ROOT)).hexdigest() == found["digest"]
                except FileNotFoundError:
                    unchanged = False
                if not unchanged:
                    kept.append({"session_id": session, "reason": "changed"})
                    continue
                if not dry_run:
                    if trash is None:
                        trash = trash_directory(handles, directories, create=True)
                    verify_trash(config, key, directories, trash)
                    name = "%s.%d.%s.%d.json" % (session, found["root"]["seq"], found["digest"], now_ms())
                    try:
                        os.stat(name, dir_fd=trash, follow_symlinks=False)
                        raise HistoryError("trash entry exists: " + name)
                    except FileNotFoundError:
                        pass
                    os.rename(found["name"], name, src_dir_fd=directories["roots"], dst_dir_fd=trash)
                    mutation["committed"] = True
                    os.fsync(trash)
                    os.fsync(directories["roots"])
                    entries[name] = {"root": found["root"], "trashed_at": now}
                trashed.append({"session_id": session, "seq": found["root"]["seq"],
                                "root_sha256": found["digest"]})
        kept.sort(key=lambda entry: entry["session_id"])
        purged_trash = sorted(name for name, entry in entries.items()
                              if now - entry["trashed_at"] >= TRASH_GRACE_MS)
        if purged_trash and not dry_run:
            verify_trash(config, key, directories, trash)
            for name in purged_trash:
                os.unlink(name, dir_fd=trash)
                mutation["committed"] = True
            os.fsync(trash)
        # A root changed outside history.py may name an object this run never saw.
        changed = any(entry["reason"] == "changed" for entry in kept)
        named = {found["root"]["object"]["checksum"] for found in roots.values() if found["root"]["object"] is not None}
        named |= {entry["root"]["object"]["checksum"] for name, entry in entries.items()
                  if name not in purged_trash and entry["root"]["object"] is not None}
        purged_objects = [] if changed else sorted(objects - named)
        if purged_objects and not dry_run:
            verify_directories(config, key, directories)
            for checksum in purged_objects:
                os.unlink(checksum + ".json", dir_fd=directories["objects"])
                mutation["committed"] = True
            os.fsync(directories["objects"])
    response = {"ok": True, "protocol": 3, "op": "collect", "dry_run": dry_run, "trashed": trashed,
                "purged_trash": purged_trash, "purged_objects": purged_objects, "kept": kept, "more": more}
    require(len(encode(response)) + 1 <= MAX_RESPONSE, "collect response too large")
    return response


def run_restore(request, config, directories, mutation):
    """Moves one trash entry back to its root while that root is absent."""
    session, entry = request["session_id"], request["entry"]
    name = session + ".json"
    with ExitStack() as handles:
        try:
            os.stat(name, dir_fd=directories["roots"], follow_symlinks=False)
            raise HistoryError("root exists")
        except FileNotFoundError:
            pass
        trash = trash_directory(handles, directories, create=False)
        try:
            require(trash is not None, "trash entry absent")
            os.stat(entry, dir_fd=trash, follow_symlinks=False)
        except FileNotFoundError as error:
            raise HistoryError("trash entry absent") from error
        found = TRASH_NAME.fullmatch(entry)
        try:
            raw, root, digest = stored_root(trash, entry, session)
            require(root["seq"] == int(found.group(2)) and digest == found.group(3), "trash entry name differs")
            if root["object"] is not None:
                checksum = root["object"]["checksum"]
                data = read_leaf(directories["objects"], checksum + ".json", MAX_LEDGER)
                require(hashlib.sha256(data).hexdigest() == checksum, "object checksum differs")
        except (HistoryError, transactions.TransactionError, OSError, ValueError, UnicodeError) as error:
            raise HistoryError("v3 history damaged: " + str(error)) from error
        verify_trash(config, request["store"], directories, trash)
        os.rename(entry, name, src_dir_fd=trash, dst_dir_fd=directories["roots"])
        mutation["committed"] = True
        os.fsync(directories["roots"])
        os.fsync(trash)
    return {"ok": True, "protocol": 3, "op": "restore", "seq": root["seq"], "root_sha256": digest}


def run_locked(request, mutation):
    config = transactions.selected_config()
    parent = os.getppid()
    operation = request["op"]
    owner = transactions.capture_identity()[0] if operation in ("save", "resolve") else None
    with transactions.output_disconnects() as disconnected, lock_namespace(config) as locks:
        with ExitStack() as handles:
            lease = None
            if operation in ("save", "resolve"):
                name = request["session_id"] + ".lock"
                lease = handles.enter_context(transactions.open_leaf(locks["locks"], name))
                transactions.require_lease(locks["locks"], name, lease, request["module_token"])
            store = handles.enter_context(transactions.open_leaf(
                locks["locks"], "store.lock", writable=True, create=True))
            acquire = acquire_shared if operation == "read" else transactions.acquire_lock
            acquire(store, "store writer is busy", parent, disconnected)
            transactions.revalidate_leaf(locks["locks"], "store.lock", store)
            if lease is not None:
                transactions.require_lease(locks["locks"], name, lease, request["module_token"])
            if operation == "bind":
                key = scan_bind(locks["anchor"], request["plugin"], request["nonce"])
                with history_namespace(config, key, locks, create=True):
                    emit({"ok": True, "protocol": 3, "op": operation, "store": key})
            else:
                with history_namespace(config, request["store"], locks) as directories:
                    if operation == "collect":
                        response = run_collect(request, config, directories, locks, mutation)
                    elif operation == "restore":
                        response = run_restore(request, config, directories, mutation)
                    else:
                        response = run_history(request, config, directories, owner, mutation)
                    emit(response)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("op", choices=("bind", "read", "save", "resolve", "collect", "restore"))
    try:
        arguments = parser.parse_args(argv)
    except SystemExit as error:
        return error.code
    operation = arguments.op
    request = None
    mutation = {"committed": False}
    previous_mask = os.umask(0o077)
    try:
        data = sys.stdin.buffer.read(MAX_REQUEST + 1)
        require(len(data) <= MAX_REQUEST, "request too large")
        request = parse_json(data.decode("utf-8"))
        validate_request(request, operation)
        run_locked(request, mutation)
        return 0
    except (HistoryError, transactions.TransactionError, blob_fs.PublishError,
            OSError, ValueError, UnicodeError, OverflowError, RecursionError) as error:
        response = {"ok": False, "protocol": 3, "op": operation,
                    "phase": "postcommit" if mutation["committed"] else "precommit",
                    "reason": str(error)}
        if operation in ("save", "resolve") and isinstance(request, dict) and "request_id" in request:
            response["request_id"] = request["request_id"]
        emit(response)
        return 1
    finally:
        os.umask(previous_mask)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
