#!/usr/bin/env bash
# Install the two-line Claude Code statusline (model | effort | dir | branch,
# then context % + live 5h/weekly quota gauges).
#
# Idempotent. Backs up settings.json before touching it. Run it from the folder
# that contains statusline.sh and usage-live.py, or pass that folder as $1.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DEST="$HOME/.claude"
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[38;2;210;153;34mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[38;2;248;81;73merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. preflight ─────────────────────────────────────────────────────────────
[ -f "$SRC/statusline.sh" ] || die "statusline.sh not found in $SRC"
[ -f "$SRC/usage-live.py" ] || die "usage-live.py not found in $SRC"

for bin in jq python3; do
    command -v "$bin" >/dev/null 2>&1 || die "$bin is required. Install it, then rerun."
done

if [ "$(uname -s)" != "Darwin" ]; then
    warn "Not macOS. Line 1 and the context bar will work; the 5h/weekly gauges will not,"
    warn "because they read the Claude Code OAuth token from the macOS login Keychain."
fi

# ── 2. install the scripts ───────────────────────────────────────────────────
mkdir -p "$DEST/scripts"
install -m 755 "$SRC/statusline.sh" "$DEST/statusline.sh"
install -m 755 "$SRC/usage-live.py" "$DEST/scripts/usage-live.py"
say "installed $DEST/statusline.sh and $DEST/scripts/usage-live.py"

# ── 3. point settings.json at it (backup first, keep every other key) ───────
SETTINGS="$DEST/settings.json"
if [ -f "$SETTINGS" ]; then
    cp "$SETTINGS" "$SETTINGS.bak-$STAMP"
    say "backed up settings.json to settings.json.bak-$STAMP"
else
    echo '{}' > "$SETTINGS"
    say "created an empty $SETTINGS"
fi

python3 - "$SETTINGS" <<'PY'
import json, sys, os, tempfile

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    text = fh.read().strip() or "{}"
try:
    data = json.loads(text)
except json.JSONDecodeError as exc:
    sys.exit(f"settings.json is not valid JSON ({exc}); fix it by hand, then rerun.")
if not isinstance(data, dict):
    sys.exit("settings.json must contain a JSON object.")

data["statusLine"] = {"type": "command", "command": "~/.claude/statusline.sh"}

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
os.replace(tmp, path)
print("==> settings.json now uses ~/.claude/statusline.sh")
PY

# ── 4. prime the quota cache ────────────────────────────────────────────────
say "fetching quota once (this needs a Claude Pro/Max login, not an API key)"
set +e
python3 "$DEST/scripts/usage-live.py" --quiet --force --http-timeout-seconds 12
LIVE_RC=$?
set -e
OK=$(jq -r '.ok // false' "$DEST/usage-live.json" 2>/dev/null || echo false)
if [ "$OK" = "true" ]; then
    say "quota cache OK: 5h $(jq -r '.five_hour.pct // "?"' "$DEST/usage-live.json")% / week $(jq -r '.seven_day.pct // "?"' "$DEST/usage-live.json")%"
else
    warn "quota fetch failed (exit $LIVE_RC): $(jq -r '.error // "unknown"' "$DEST/usage-live.json" 2>/dev/null)"
    warn "Lines 1-2 still render; the 5h/wk gauges stay hidden until this succeeds."
    warn "Most common cause: not logged in with a subscription. Run 'claude' and use /login."
fi

# ── 5. smoke test ───────────────────────────────────────────────────────────
say "smoke test render:"
printf '%s' '{"model":{"display_name":"Claude Opus 5","id":"claude-opus-5"},
  "effort_level":"xhigh","workspace":{"current_dir":"'"$HOME"'/demo"},
  "context_window":{"used_percentage":7},"session_id":"install-smoke"}' \
  | COLUMNS=120 bash "$DEST/statusline.sh"

say "done. Restart Claude Code, or run /statusline in an open session, to pick it up."
