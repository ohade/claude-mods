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

## track

A pane beside the transcript, titled Session Tracker, that keeps the session's register: the questions you asked and
where each was answered, and the steps the model set itself, each with a completion ring.

- **Questions.** The model sends each question to the pane with `track_question` and closes it
  with `mark_answered` (answered or deferred); a standing rule in the system prompt asks it to.
  Both calls stay quiet in the transcript: the first draws nothing, the second one dim
  `✓ Q<n> answered` line. An answered question turns green.
- **Jump.** `[ Q ]` scrolls the transcript to your prompt, `[ A ]` to the answer. The row you land
  on lights up and fades out over about two seconds: your prompt, or the answer's last text row and
  the `✓ Q<n> answered` line under it. The digits 1–9 press the jumps while the pane has focus
  (ctrl+x tab).
- **Banner.** A colored line just above the steps says where the session stands: Working, Waiting on agents
  (an Agent call, or background agents and shell tasks still running), Waiting on you (a question
  dialog, or open questions and unfinished steps after the turn), or Safe to close.
- **Steps.** Filled from the model's own `TaskCreate`, `TaskUpdate`, `TodoWrite` and an approved
  plan (`ExitPlanMode`: its numbered and checkbox lines). A Task named like a plan step links to it.
  The step in progress shows who is on it: a spinner breathing in grey while the main session
  works, an amber hourglass while it waits on agents, a still purple `◆` while it waits on you.
- **Rings.** `◑ 4 of 8 · 50%` per section, counted over everything ever: **Clear completed** (`c`)
  hides finished rows and keeps them counted.
- **Clear all.** `q` and `s` empty the Questions or the Steps section; cleared open questions
  are withdrawn, so the model is told not to answer them.
- **Chat plans.** When the model starts work of more than one step (a skill such as `/retro`, a
  plan in chat, a multi-step task), it registers the steps with `track_steps` and ticks them with
  `mark_step`. Work that joins a running plan, such as review comments from Plannotator, is
  inserted with `track_steps({ steps, after })` after the step it follows. While a managed plugin
  bypasses the system-prompt rule, each typed prompt, skill command and plugin prompt carries the
  instruction beside it; built-in commands do not.
- **Withdraw.** `✕` removes a question; your next prompt tells the model not to answer it.
- **Nag.** While a question is open, each prompt carries a one-line reminder; a Stop hook holds a
  turn once if a question the model tracked in that turn is neither answered nor deferred. It
  runs after your own Stop hooks and never adds a second block.
  An organization's managed plugin may bypass a user plugin's Stop hook and its system-prompt
  section; the questions are still tracked, through the tools' own descriptions and the reminder.
- **Rewind and resume.** A `/rewind` drops the questions asked in the rewound turns. Each finished
  turn saves the register, so `/resume` brings it back.

It opens by itself by the built-in diff panel's rule, less the git condition: in the fullscreen
layout, at least 144 columns wide, and never after you closed it by hand (ctrl+x x). A reload of
the mod leaves an open pane open. `/track` shows or hides it at any width, and like `/btw` it acts
at once while a turn runs and adds nothing to the session; `/track status` prints the open
questions. To keep the diff
panel out of the slot, type `/diff` once.

Load it with `ln -s ../../git/claude-mods/track ~/.claude/skills/track`, or for one session
`claude --plugin-dir ~/git/claude-mods/track`. Tests: `claude plugin test track`.

## statusline

A two-line status line: model and effort, folder and branch, prompt-cache state, context use, and live 5-hour and weekly quota. `usage-live.py` reads Claude Code's OAuth credential from the macOS Keychain to fetch the quota; it never prints or stores the token.

Install it, which copies the scripts into `~/.claude` and points `statusLine` in `~/.claude/settings.json` at them after a backup:

```sh
./statusline/install.sh
```

[statusline/README.md](statusline/README.md) has the details. This folder was `ohade/claude-statusline-setup`, merged here with its history on 2026-10-04.
