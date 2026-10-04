# claude-mods

Personal customizations for Claude Code: function-hook plugins ("mods") and the status line.

## image-thumbs

Shows each image you paste into a prompt as a small framed thumbnail under your message.

- **Click the picture** to expand it in place, at full resolution, up to 24 rows tall. Click again to shrink it.
- **`open in pane`** under the frame opens the image in a pane. The pane docks beside the transcript in the fullscreen layout when the terminal is at least 110 columns wide; otherwise it opens above the prompt.
- **`/image [n]`** opens image `#n`, or the latest one, in the same pane.

Requirements: macOS (the mod uses `sips` and `base64`), Claude Code 2.1.289 or later with function-hook plugins, and a terminal that draws images with the kitty graphics protocol (Ghostty, kitty). Elsewhere the thumbnail shows its `[Image #n]` label instead.

Limits: thumbnails appear after you submit the prompt, not while you type. Images in a resumed session get no thumbnail. The decoded originals live in a private folder under `$TMPDIR` and are deleted when the session ends.

Load it in every session with one of:

```sh
ln -s ../../git/claude-mods/image-thumbs ~/.claude/skills/image-thumbs   # skills folder
claude --plugin-dir ~/git/claude-mods/image-thumbs                     # one session
```

or list the folder in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

Check it with `claude plugin validate image-thumbs`, and type-check it with `tsc -p image-thumbs` once Claude Code has loaded it (loading writes the API types into `.claude-plugin/types/`).

## statusline

`statusline.sh` draws the status line: model and effort, folder, prompt-cache state, and the 5-hour and weekly usage. It reads two helpers from `~/.claude/scripts/`:

- `usage-live.py` reads Claude Code's OAuth credential from the macOS Keychain, calls the usage endpoint, and caches a sanitized result. It never prints or stores the token.
- `usage-snapshot.sh` estimates weekly Opus usage from local transcripts.

Wire it in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
```

This folder is a snapshot of the live copy in `~/.claude`, taken 2026-10-04.
