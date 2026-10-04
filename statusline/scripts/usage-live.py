#!/usr/bin/env python3
"""
Fetch live Claude Code usage with Claude Code's OAuth credential.

This is not an Anthropic API-key call. It reads the local Claude Code OAuth
credential from macOS Keychain, calls Claude Code's OAuth usage endpoint, and
writes a sanitized cache for the statusline. The bearer token is never printed
or stored.
"""
from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


HOME = Path.home()
CACHE_PATH = HOME / ".claude" / "usage-live.json"
LOCK_PATH = HOME / ".claude" / "usage-live.lock"
ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
BETA_HEADER = "oauth-2025-04-20"
KEYCHAIN_SERVICE = "Claude Code-credentials"
DEFAULT_TTL_SECONDS = 300


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    old_umask = os.umask(0o077)
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, sort_keys=True)
            fh.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        os.umask(old_umask)


def is_cache_fresh(path: Path, ttl_seconds: int) -> bool:
    try:
        return (time.time() - path.stat().st_mtime) < ttl_seconds
    except FileNotFoundError:
        return False


def acquire_lock(lock_path: Path, max_age_seconds: int = 60) -> int | None:
    try:
        st = lock_path.stat()
        if time.time() - st.st_mtime > max_age_seconds:
            lock_path.unlink(missing_ok=True)
    except FileNotFoundError:
        pass

    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, str(os.getpid()).encode("ascii"))
        return fd
    except FileExistsError:
        return None


def release_lock(fd: int | None, lock_path: Path) -> None:
    if fd is not None:
        try:
            os.close(fd)
        finally:
            lock_path.unlink(missing_ok=True)


def claude_code_version() -> str:
    override = os.environ.get("CLAUDE_CODE_VERSION")
    if override:
        return override

    candidates = [
        Path("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/package.json"),
        Path("/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json"),
        HOME / ".npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json",
    ]
    for path in candidates:
        data = read_json(path)
        if data and isinstance(data.get("version"), str):
            return data["version"]
    return "unknown"


def read_oauth_credential() -> tuple[str, str]:
    account = os.environ.get("CLAUDE_CODE_KEYCHAIN_ACCOUNT") or getpass.getuser()
    cmd = [
        "/usr/bin/security",
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        account,
        "-w",
    ]
    raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
    credential = json.loads(raw)
    oauth = credential.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        oauth = credential
    token = oauth.get("accessToken")
    if not isinstance(token, str) or not token:
        raise RuntimeError("Claude Code Keychain credential has no access token")
    tier = oauth.get("rateLimitTier")
    return token, tier if isinstance(tier, str) else "unknown"


def fetch_usage(token: str, version: str, timeout_seconds: float = 12.0) -> tuple[dict[str, Any], dict[str, str], int]:
    req = urllib.request.Request(
        ENDPOINT,
        method="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": BETA_HEADER,
            "Content-Type": "application/json",
            "User-Agent": f"claude-code/{version}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        body = resp.read().decode("utf-8")
        data = json.loads(body)
        headers = {k.lower(): v for k, v in resp.headers.items()}
        return data, headers, resp.status


def first_present(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def pct_from(value: Any) -> int | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < 1.0:
        number *= 100.0
    return int(round(max(0.0, min(100.0, number))))


def parse_time(value: Any) -> tuple[str | None, str | None, int | None]:
    if value is None:
        return None, None, None

    parsed: dt.datetime | None = None
    if isinstance(value, (int, float)):
        if value > 10_000_000_000:
            value = value / 1000.0
        parsed = dt.datetime.fromtimestamp(value, tz=dt.timezone.utc)
    elif isinstance(value, str):
        raw = value.strip()
        if raw:
            try:
                parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                try:
                    parsed = dt.datetime.fromtimestamp(float(raw), tz=dt.timezone.utc)
                except ValueError:
                    parsed = None

    if parsed is None:
        return None, None, None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    parsed_utc = parsed.astimezone(dt.timezone.utc)
    local = parsed_utc.astimezone().isoformat(timespec="minutes")
    seconds = int((parsed_utc - utc_now()).total_seconds())
    return parsed_utc.isoformat(timespec="seconds"), local, seconds


def human_delta(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    if seconds <= 0:
        return "now"
    if seconds < 3600:
        return f"{round(seconds / 60)}m"
    if seconds < 24 * 3600:
        hours = seconds // 3600
        minutes = round((seconds % 3600) / 60)
        if minutes == 60:
            hours += 1
            minutes = 0
        return f"{hours}h{minutes}m"
    if seconds < 48 * 3600:
        return f"{round(seconds / 3600)}h"
    return f"{round(seconds / 86400, 1)}d"


def human_week_delta(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    if seconds <= 0:
        return "now"
    if seconds >= 24 * 3600:
        return f"{max(1, math.ceil(seconds / 86400))}d"
    if seconds >= 3600:
        return f"{max(1, math.ceil(seconds / 3600))}h"
    return f"{max(1, math.ceil(seconds / 60))}m"


def normalize_window(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}

    pct = pct_from(
        first_present(
            raw,
            (
                "utilization",
                "usage",
                "percent",
                "percentage",
                "used_percentage",
                "usage_percentage",
                "pct",
            ),
        )
    )
    reset_raw = first_present(
        raw,
        ("resets_at", "reset_at", "resetAt", "resetsAt", "reset", "reset_time"),
    )
    reset_utc, reset_local, reset_seconds = parse_time(reset_raw)
    out: dict[str, Any] = {}
    if pct is not None:
        out["pct"] = pct
    if reset_utc is not None:
        out["resets_at_utc"] = reset_utc
        out["resets_at_local"] = reset_local
        out["resets_in_seconds"] = reset_seconds
        out["resets_in"] = human_delta(reset_seconds)
    return out


def int_pct(value: Any) -> int | None:
    """Clamp an already-percentage value (0-100). Unlike pct_from it never
    rescales a sub-1 value, because the limits[] array reports whole percents."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(round(max(0.0, min(100.0, number))))


def normalize_scoped_limits(raw: Any) -> list[dict[str, Any]]:
    """Flatten the limits[] array's model-scoped entries.

    The OAuth usage endpoint reports per-model caps (currently Fable) only inside
    limits[], as kind=weekly_scoped with scope.model.display_name set. The legacy
    seven_day_<model> keys stay null for these models.
    """
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        scope = entry.get("scope")
        if not isinstance(scope, dict):
            continue
        model = scope.get("model")
        name = model.get("display_name") if isinstance(model, dict) else None
        if not isinstance(name, str) or not name.strip():
            continue
        item: dict[str, Any] = {
            "model": name.strip(),
            "model_key": name.strip().lower(),
            "kind": entry.get("kind"),
            "group": entry.get("group"),
            "severity": entry.get("severity"),
            "is_active": bool(entry.get("is_active")),
        }
        pct = int_pct(entry.get("percent"))
        if pct is not None:
            item["pct"] = pct
        reset_utc, reset_local, reset_seconds = parse_time(entry.get("resets_at"))
        if reset_utc is not None:
            item["resets_at_utc"] = reset_utc
            item["resets_at_local"] = reset_local
            item["resets_in_seconds"] = reset_seconds
            item["resets_in"] = human_delta(reset_seconds)
        out.append(item)
    return out


def build_statusline(payload: dict[str, Any]) -> dict[str, Any]:
    segments: list[str] = []
    week_segments: list[str] = []
    color_pct = 0
    five_hour = payload.get("five_hour") or {}
    seven_day = payload.get("seven_day") or {}
    opus = payload.get("seven_day_opus") or {}

    if isinstance(five_hour, dict) and five_hour.get("pct") is not None:
        text = f"5h-window {five_hour['pct']}%"
        if five_hour.get("resets_in"):
            text += f" ·↻{five_hour['resets_in']}"
        segments.append(text)
        color_pct = max(color_pct, int(five_hour["pct"]))

    if isinstance(seven_day, dict) and seven_day.get("pct") is not None:
        text = f"week {seven_day['pct']}%"
        reset = human_week_delta(seven_day.get("resets_in_seconds"))
        if reset:
            text += f" ·↻{reset}"
        week_segments.append(text)
        color_pct = max(color_pct, int(seven_day["pct"]))

    if isinstance(opus, dict) and opus.get("pct") is not None:
        week_segments.append(f"Opus {opus['pct']}%")
        color_pct = max(color_pct, int(opus["pct"]))

    return {
        "text": " · ".join(segments),
        "week_text": " · ".join(week_segments),
        "color_pct": color_pct,
    }


def normalize_response(raw: dict[str, Any], headers: dict[str, str], version: str, tier: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": True,
        "source": "anthropic_oauth_usage",
        "endpoint": ENDPOINT,
        "generated_at": utc_now().isoformat(timespec="seconds"),
        "claude_code_version": version,
        "rate_limit_tier": tier,
        "schema_keys": sorted(raw.keys()),
        "five_hour": normalize_window(raw.get("five_hour")),
        "seven_day": normalize_window(raw.get("seven_day")),
        "seven_day_opus": normalize_window(raw.get("seven_day_opus")),
        "seven_day_sonnet": normalize_window(raw.get("seven_day_sonnet")),
        "extra_usage": normalize_window(raw.get("extra_usage")),
        "scoped_limits": normalize_scoped_limits(raw.get("limits")),
        "http": {
            "status": 200,
            "request_id": headers.get("request-id") or headers.get("x-request-id"),
        },
    }
    payload["statusline"] = build_statusline(payload)
    return payload


def sanitized_error(exc: BaseException, status: int | None = None, body: str | None = None) -> dict[str, Any]:
    message = str(exc)
    if isinstance(exc, subprocess.CalledProcessError):
        message = "Claude Code Keychain credential not found or not readable"
    payload: dict[str, Any] = {
        "ok": False,
        "source": "anthropic_oauth_usage",
        "endpoint": ENDPOINT,
        "generated_at": utc_now().isoformat(timespec="seconds"),
        "error": message[:500],
    }
    if status is not None:
        payload["http"] = {"status": status}
    if body:
        payload["body_preview"] = body[:500]
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", default=str(CACHE_PATH), help="sanitized cache path")
    parser.add_argument("--ttl-seconds", type=int, default=DEFAULT_TTL_SECONDS)
    parser.add_argument("--http-timeout-seconds", type=float, default=12.0)
    parser.add_argument("--force", action="store_true", help="refresh even when cache is fresh")
    parser.add_argument("--quiet", action="store_true", help="suppress stdout")
    args = parser.parse_args()

    cache = Path(args.cache).expanduser()
    if not args.force and is_cache_fresh(cache, args.ttl_seconds):
        cached = read_json(cache)
        if cached:
            if not args.quiet:
                print(json.dumps(cached, sort_keys=True))
            return 0 if cached.get("ok") else 1

    lock_fd = acquire_lock(LOCK_PATH)
    if lock_fd is None:
        if not args.quiet:
            cached = read_json(cache)
            if cached:
                print(json.dumps(cached, sort_keys=True))
        return 0

    try:
        try:
            version = claude_code_version()
            token, tier = read_oauth_credential()
            raw, headers, _status = fetch_usage(token, version, args.http_timeout_seconds)
            payload = normalize_response(raw, headers, version, tier)
            atomic_write_json(cache, payload)
            if not args.quiet:
                print(json.dumps(payload, sort_keys=True))
            return 0
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            payload = sanitized_error(exc, exc.code, body)
        except Exception as exc:
            payload = sanitized_error(exc)

        existing = read_json(cache)
        if existing and existing.get("ok"):
            existing["last_refresh_error"] = payload
            atomic_write_json(cache, existing)
            if not args.quiet:
                print(json.dumps(existing, sort_keys=True))
            return 1

        atomic_write_json(cache, payload)
        if not args.quiet:
            print(json.dumps(payload, sort_keys=True))
        return 1
    finally:
        release_lock(lock_fd, LOCK_PATH)


if __name__ == "__main__":
    sys.exit(main())
