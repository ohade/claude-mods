# Claude Code statusline: model, context, and live quota

A two-line statusline for Claude Code. It renders like this (colour stripped):

```
fable5.1 | xhigh | 📁 git | 🌿 main | cache 92% 1h →21:24
▰▱▱▱ 7% | 5h ▰▰▰▰ 89% 2h26m | wk ▰▱▱▱ 15% 5d13h | fable wk ▰▰▱▱ 41%
```

Line 1 tells you which model and reasoning effort the session is on, where you are, and
whether the prompt cache is still warm. Line 2 tells you how full the context window is,
then how much of your rolling 5-hour, 7-day, and per-model weekly subscription quota you
have burned and when each window resets.

The `▶▶ auto mode on (shift+tab to cycle)` line you may see under it is **not** part of this
setup. Claude Code prints that itself; you get it for free.

## What you need

| Requirement | Why | Check |
| --- | --- | --- |
| macOS | The quota gauges read the Claude Code OAuth token from the login Keychain, and the script uses BSD `stat -f`. | `uname -s` prints `Darwin` |
| `jq` | The statusline parses its JSON input with it. | `command -v jq` |
| `python3` | Runs the quota fetcher. Standard library only, no `pip install`. | `command -v python3` |
| A Claude Pro or Max login | The quota endpoint is an OAuth endpoint. An `ANTHROPIC_API_KEY` will not work. | `claude` then `/login` |
| Claude Code 2.1.251 or later | Older versions do not send the `prompt_cache` object, so the cache segment stays hidden. | `claude --version` |

Lines 1 and 2 work without the macOS, `python3`, and login requirements; you just lose the
quota gauges. See [Troubleshooting](#troubleshooting).

## Install

You need two files from this folder: `statusline.sh` and `usage-live.py`.

### Option A — run the installer (recommended)

```bash
cd /path/to/claude-statusline-setup
./install.sh
```

It copies both scripts into place, backs up `~/.claude/settings.json` before editing it,
adds only the `statusLine` key, fetches your quota once, and prints a smoke-test render.
Running it twice is safe.

Then restart Claude Code, or run `/statusline` in an open session, to pick up the change.

### Option B — by hand

```bash
mkdir -p ~/.claude/scripts
install -m 755 statusline.sh  ~/.claude/statusline.sh
install -m 755 usage-live.py  ~/.claude/scripts/usage-live.py
```

Add this to `~/.claude/settings.json`, keeping whatever else is already in the file:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  }
}
```

Prime the quota cache once:

```bash
python3 ~/.claude/scripts/usage-live.py --force
```

## Verify it works

Feed the script a fake payload instead of waiting for a real session:

```bash
printf '%s' '{"model":{"display_name":"Claude Opus 5","id":"claude-opus-5"},
  "effort_level":"xhigh","workspace":{"current_dir":"'"$HOME"'/demo"},
  "context_window":{"used_percentage":7},"session_id":"smoke"}' \
  | COLUMNS=120 bash ~/.claude/statusline.sh
```

Two coloured lines mean the install is good. Check the quota half separately:

```bash
jq '{ok, five_hour, seven_day: .seven_day.pct}' ~/.claude/usage-live.json
```

`"ok": true` with a `five_hour.pct` number means the gauges will render.

## Reading the statusline

**Line 1** — `fable5.1 | xhigh | 📁 git | 🌿 main | cache 92% 1h →21:24`

- Model, shortened from the display name: `Claude Opus 5 (1M context)` becomes `opus5`.
- Reasoning effort, colour-coded: amber `low`, green `medium`, blue `high`, purple `xhigh`,
  red `max`. `xhigh-ultra` means ultracode is on. The segment hides itself when the session
  reports no effort level, so a missing label is not a broken install.
- Current directory, basename only.
- Git branch, shown only when the session's working directory is inside a repository.
- Prompt cache, described in [Reading the cache segment](#reading-the-cache-segment).

**Line 2** — `▰▱▱▱ 7% | 5h ▰▰▰▰ 89% 2h26m | wk ▰▱▱▱ 15% 5d13h | fable wk ▰▰▱▱ 41%`

- First bar and percent: how much of the **context window** this session has used.
- `5h`: your rolling five-hour quota, plus the time until it resets.
- `wk`: your seven-day quota, plus the time until that resets.
- `fable wk`: a weekly cap that applies to one model only. It appears only when the current
  model has its own cap. Its reset time shows only when it differs from the `wk` reset.
- Every bar turns green under 75%, amber at 75%, red at 90%.

In a terminal narrower than 50 columns the weekly gauges move to a third line prefixed
`limits:` so the numbers stay readable.

### Reading the cache segment

Every message resends the whole conversation to the model. The prompt cache stores what
was already sent, so the model reuses it instead of processing it again. A cache read costs
about a tenth of normal input, so a warm cache keeps long sessions cheap.

- `cache 92% 1h →21:24`: the cache is warm. 92% of this session's input came from the
  cache, the cache lifetime is 1 hour, and it expires at 21:24 if you send nothing. Each
  message resets the lifetime, so the time moves forward as you work. The percent turns
  amber below 80% and red below 50%.
- `cache cold rewrite 84k`: the lifetime passed. The next message must write all 84k tokens
  to the cache again, which costs more than normal input. It turns red at 100k or more,
  which is a good moment for `/clear` if the task is finished.
- `2 miss`: twice the cache should have been used and was not. Usually something early in
  the prompt changed, such as the model, the tools, or `CLAUDE.md`.
- `cache off`: no response this session reported cache use.

The segment shows the expiry as a clock time, not a countdown. Claude Code re-runs the
script only when something happens, so a countdown would stop moving while you are idle.
Claude Code does re-run it at the expiry time, which switches the segment to `cold`. The
segment reads the `prompt_cache` object Claude Code passes to the statusline; nothing
extra runs.

## How the quota gauges work

`statusline.sh` never calls the network itself. It reads `~/.claude/usage-live.json`, a
sanitized cache. When that cache is older than five minutes, it runs
`~/.claude/scripts/usage-live.py` with a 1.5-second timeout to refresh it.

The fetcher reads the Claude Code OAuth token from your macOS login Keychain
(`security find-generic-password -s "Claude Code-credentials"`), calls Anthropic's OAuth
usage endpoint, and writes only percentages and reset times to the cache at mode `600`.
**The bearer token is never printed and never stored in the cache.**

Two behaviours are worth knowing:

- A window can reset inside the five-minute cache lifetime. The script detects that it is
  past the recorded reset instant and refreshes immediately, so you never stare at a stuck
  `100% · 1m`.
- If the cache goes more than ten minutes stale, the line appends an amber `stale` marker
  rather than showing a confident wrong number.

Each render also writes `/tmp/claude-ctx-<session_id>.json` with the current context
percentage. That exists so other local tooling can read context pressure. It is harmless; if
you do not want it, delete the `Context monitor bridge` block from `statusline.sh`.

The script also has an optional fallback gauge that reads `~/.claude/usage-snapshot.json`.
That file and its refresher are not part of this repository, so the block does nothing
unless you provide them.

## Troubleshooting

**The statusline does not appear at all.** Check that `~/.claude/settings.json` is valid JSON
(`jq . ~/.claude/settings.json`) and that the script is executable
(`ls -l ~/.claude/statusline.sh` should show `-rwxr-xr-x`).

**Lines 1 and 2 render but the `5h` and `wk` gauges are missing.** Run the fetcher directly
and read the error:

```bash
python3 ~/.claude/scripts/usage-live.py --force | jq '{ok, error}'
```

- `Claude Code Keychain credential not found or not readable` — you are not logged in with a
  subscription, or you are using an API key. Run `claude`, then `/login`.
- An HTTP 401 or 403 — the token expired. Log in again the same way.
- Anything else — the gauges stay hidden and the rest of the statusline keeps working.

**`stale` shows up and will not clear.** The refresh has a hard 1.5-second timeout so it can
never hang your prompt. On a slow connection, prime the cache by hand with
`python3 ~/.claude/scripts/usage-live.py --force --http-timeout-seconds 12`.

**You are on Linux or WSL.** Line 1 and the context bar work. The gauges do not: the fetcher
reads the macOS Keychain, and the script uses BSD `stat -f %m`, which needs to become
`stat -c %Y`. The cache expiry clock uses BSD `date -r <seconds>`, which needs to become
`date -d @<seconds>`. All three are small changes if you want to port it.

**The model shows `model` or the directory shows `null`.** The script received an incomplete
payload. It degrades instead of failing, and always exits `0`, so it can never break your
session.

## Uninstall

```bash
rm ~/.claude/statusline.sh ~/.claude/scripts/usage-live.py ~/.claude/usage-live.json
```

Then remove the `statusLine` key from `~/.claude/settings.json`, or restore the
`settings.json.bak-*` file the installer left behind.

## Files

| File | Installed to | Role |
| --- | --- | --- |
| `statusline.sh` | `~/.claude/statusline.sh` | Renders the statusline from the JSON Claude Code sends on stdin. |
| `usage-live.py` | `~/.claude/scripts/usage-live.py` | Fetches the 5-hour, weekly, and per-model weekly quota into a sanitized cache. |
| `install.sh` | not installed | Copies both scripts into place and sets the `statusLine` key. |
