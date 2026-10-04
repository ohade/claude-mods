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

A two-line status line: model and effort, folder and branch, prompt-cache state, context use, and live 5-hour and weekly quota. `usage-live.py` reads Claude Code's OAuth credential from the macOS Keychain to fetch the quota; it never prints or stores the token.

Install it, which copies the scripts into `~/.claude` and points `statusLine` in `~/.claude/settings.json` at them after a backup:

```sh
./statusline/install.sh
```

[statusline/README.md](statusline/README.md) has the details. This folder was `ohade/claude-statusline-setup`, merged here with its history on 2026-10-04.
