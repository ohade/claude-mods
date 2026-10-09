# claude-mods

Personal customizations for Claude Code: function-hook plugins ("mods") and the status line.

Get them with `git clone https://github.com/ohade/claude-mods.git`; each section says how to load its mod.

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

A pane beside the transcript, titled Session Tracker, that keeps substantive questions, their answers,
and meaningful work. Claude decides what to register from any sender, including later content in a
running turn. Doorbells and informational notifications alone need no row. Track has no transport-specific workflow.

- **Questions.** The model sends each question to the pane with `track_question` and closes it
  with `mark_answered` (answered or deferred); a standing rule in the system prompt asks it to.
  A question with a verified user source links to that source. Otherwise its tracking call is the
  visible source. To mark it answered, Claude supplies the completed `answer_text`, or explicitly
  identifies the latest verified native response with `answer_request_id`. A bare answered status
  is refused without changing the ledger; latest progress text cannot supply an answer.
  The update draws one dim `✓ Q<n>. answered` line. If the explicit text has no verified native
  source, a separate answer row displays the saved words at that call. This can add answer tokens;
  the call's displayed answer may be the answer's first visible delivery. An answered question turns green. The instruction explicitly includes
  short follow-up questions before answering; a row still requires Claude to register it.
- **Jump.** The fixed `[ Q ]` and `[ A ]` columns scroll to the verified source and answer. The row you land
  on lights up and fades out over about two seconds: your prompt or the actual answer text alone.
  The acknowledgement is a separate row. `[ A ]` stays faded until captured answer text exists;
  an acknowledgement or an older answer with no saved text does not make it ready.
  Question and step labels use `Q1.` and `S1.`. The digits 1–9 press the jumps while the pane has focus
  (ctrl+x tab).
  Groups containing an uncleared question's tracking source or displayed restore stay unfolded;
  unrelated groups retain their native collapsed state. This exposes the ToolUse child that owns
  the target and changes how those groups appear in the transcript. Composer rows always have
  an owned wrapper. Transcript jumps use `requestId`; `{ key }` resolves only plugin panes and
  AbovePrompt, so it cannot reveal a transcript answer Box. Call-sourced answers use their stable
  ToolUse call ID. Assistant answers use the exact host render instance observed on this load.
  The bounded presentation cache is lost on reload; an unseen assistant or restore host refuses
  visibly, without falling back to an acknowledgement or a guessed key. Shading still selects
  only the answer text. Native jumps after reload remain an acceptance gate, including oldest
  and middle rows away from the viewport.
- **Layout.** The title stays at the top and the banner at the bottom. Questions and Steps are
  fixed regions, about a third and two thirds; each scrolls on its own under the wheel, and its
  header counts the rows hidden above and below (`↑2 ↓5`). Empty sections say only "None yet."
  Below 40 body columns, counts use `12/39`, questions place their Q/A controls below the text,
  and step clocks use a separate line. Short controls and hints fit a 17-column body. The banner
  keeps the state on one line and omits background counts when space is tight.
  Claude Code owns the draggable transcript/dock divider. Its 2.1.293 plugin API exposes no
  hover mouse-cursor control for that divider; Track cannot set a horizontal resize cursor there.
  For plugin authors: native JSX `Fragment` is a column Box. Horizontal row children must
  stay flat; wrapping them in a fragment stacks their labels and clips the measured region.
- **Banner.** Full-width colored rows at the bottom say where the session stands: Working, Waiting on agents
  (an Agent call or background agents), Waiting on tasks (background shell tasks), Waiting on you
  (a question dialog or an explicit waiting step), Paused, Activity unknown, Unsaved, or Idle.
  Use `waiting` only when the user must act; peer waits use `paused` or `pending` with an optional note.
  `mark_step({ delegated: true })` identifies work owned by agents, including agents launched
  through other tools. It shows the brown hourglass and agents banner. Use `delegated: false`
  when the main session resumes that step. This is explicit ownership, not a peer-liveness probe.
  Completed steps clear it. Concurrent main work stays grey on its own row.
  Explicit ownership leaves agent counts unknown; only native-only activity supplies a count.
  User waiting does not hide concurrent work: unsaved, agents, main work, and waiting on you
  are separate rows, top to bottom, and only the amber glyph pulses. A short pane collapses to
  the highest-priority row and a count.
  Paused, pending and user-waiting rows retain ownership metadata but do not count as active
  delegated work or show a running hourglass. An open question dialog alone does not imply
  that the main session is working. Actual native background activity still shows and pulses.
- **Steps.** Filled from the model's own `TaskCreate`, `TaskUpdate`, `TodoWrite` and explicit
  `track_steps` calls. Successful plan approval adds one reminder to reuse open steps and register
  missing work. It leaves the entire register unchanged. A Task named like a plan step links to it.
  The step in progress shows who is on it: a spinner breathing in grey while the main session
  works, an amber hourglass while it waits on agents, a still blue `◆` while it waits on you.
  A duration runs only for an in-progress step with a known start and no end. Pending, paused
  and waiting rows hide their clocks and reserve no clock space, even if an earlier start is
  retained. Completed rows show a fixed duration only when both times are known. These are
  wall-clock durations from the first start; resuming does not subtract parked intervals.
  Below a minute they show `<1m`; below an hour they show whole minutes such as `4m`
  or `11m`, without seconds or padding. At an hour or above they retain `1h 05m`.
  An interrupted main turn pauses only its own in-progress, non-delegated steps with an
  `interrupted` note. It preserves other turns, cleared rows and delegated work. Turn ownership
  survives reload in the same session; restoration into another session drops it while retaining
  the status and note. A late completion cannot stop a newer main turn's working banner.
- **Rings.** `◑ 4 of 8 · 50%` per section, counted over visible rows. **Clear completed**
  hides finished rows in its own section and removes them from that section's count.
  Questions has `a: clear completed` for answered questions; it keeps open and deferred
  questions and every step. Steps' `c: clear completed`, in both the header and bottom
  bar, keeps every question. Narrow panes shorten the labels to `a: done` and `c: done`.
  Each explicit action saves the ledger; rendering does not save it.
- **Clear all.** `q` and `s` empty the Questions or the Steps section; cleared open questions
  are withdrawn, so the model is told not to answer them. The Steps controls (`s: clear all`,
  `c: clear completed`) appear twice, in the Steps header and in the bottom bar, and neither
  moves when the steps scroll.
- **Chat plans.** When the model starts work of more than one step (a skill such as `/retro`, a
  plan in chat, a multi-step task), it registers the steps with `track_steps` and ticks them with
  `mark_step`. Work that joins a running plan, such as review comments from Plannotator, is
  inserted with `track_steps({ steps, after })` after the step it follows. While a managed plugin
  bypasses the system-prompt rule, each typed prompt, skill command and plugin prompt carries the
  instruction beside it; built-in commands do not. After reload, only the exact current composed
  instruction suppresses this fallback. A legacy boolean delivery flag is insufficient.
  Requests found in read content count as work even when they need one command. Claude reuses
  an open step for that same work. This is a generic instruction, not transport parsing.
- **Handoffs.** A handoff that clears the session and seeds a fresh one leaves the pane empty.
  `restore_tracker({ from_session })` copies the previous session's steps back, in order, with
  their ids and statuses, and its questions not cleared, with new ids after this session's own.
  Task ids start again in each session, so a restored Task step's id gains `restored:` and keeps
  no link to the old Task. When the model marks a question answered, the mod keeps the answer's
  text (up to 1,000 characters), and the restore call's row in the transcript shows each restored
  question with its answer, its deferral note, or "(answer text was not saved)" for one answered
  before answers were kept. `[ Q ]` and `[ A ]` reveal the observed restore row and shade their own
  question or answer inside it. A requestId reveals the whole row; a later question or answer may
  remain below the viewport in a large snapshot. Exact placement within that row is unresolved. The call
  refuses to overwrite unrelated steps unless `replace: true` is passed. Repeated restoration
  reuses stable source identities and keeps local progress. A model call supplies its displayed
  restore row; a programmatic call first appends and validates a plugin-owned user note.
  This note is model-visible and can repeat saved answer tokens, but does not submit a turn.
  It labels the saved words as passive tracking data, not a new request or authority.
  A refused or altered note leaves the ledger unchanged. Only the exact acknowledged body,
  stamped Track sender and matching native UUID family can acquire its `UserMessage` targets.
  Separate question and answer keys use an observed host instance when available, with no
  ledger or store writes during rendering. Repeat calls reuse the native message UUID.
  A repeat repairs an older system-notice target once, preserves local progress, and omits
  user-cleared questions. The supported note marker survives resume. The old `InfoNotice`
  fixture remains for legacy compatibility; it is not a native system-transcript route.
  Native note visibility and jumps still need acceptance. After plugin reload, the user
  also observed failures for older native question and answer targets; only the newest pair jumped.
  Restored data and passing render fixtures do not prove native jump behavior.
  Active target records stay while their questions are uncleared; only inactive
  snapshot history is capped at three. Store capacity failures remain visible.
- **Withdraw.** `✕` removes a question; your next prompt tells the model not to answer it.
- **Nag.** While a question is open, each prompt carries a one-line reminder; a Stop hook holds a
  turn once if a question the model tracked in that turn is neither answered nor deferred.
  Track publishes its own small gate snapshot for its ordinary command Stop hook; it does not use
  handoff's relay. Existing Stop blocks are preserved. A managed policy can deny or bypass plugin
  capabilities; such a denial stays unresolved and does not count as equivalent Stop behavior.
- **Rewind and resume.** A `/rewind` drops the questions asked in the rewound turns. Each finished
  turn saves the register, and native session startup loads it for `/resume`. Rewind observations
  are coalesced and fenced to their session; compaction and capped transcript reads do not imply
  that older calls were rewound. A refused rewind save holds the prompt until the save can succeed.
  Answer jumps use event order within the question's actual tracking turn. Text before the tracking
  call cannot become its answer, even when wall-clock timestamps are equal. A later turn may answer
  an older question. A mark before a response must provide completed `answer_text`. A later response
  can reanchor it only when the full completed words match exactly and only one eligible question matches.
  Unidentified future text never supplies missing answer words.
  An explicit `answer_request_id` must match the latest host-observed response; unknown sources
  are refused. If both text and a native source id are provided, their full words must match.
  A bounded SHA-256 fingerprint compares full answers before the saved-text limit is applied;
  different endings cannot match just because their saved prefixes are equal. Event order is
  reserved before fingerprint calculation. During that calculation, a concurrent source-id call
  with long text can be refused; it leaves the ledger unchanged. Explicit text alone can still
  save its words at the tracking call. This concurrent publication window is not live-proven.
  Saved text is bounded to 1,000 Unicode code points. Legacy progress saved as an answer is not
  silently rewritten. An already captured answer stays unchanged. Step updates name the affected step.

It opens by itself by the built-in diff panel's rule, less the git condition: in the fullscreen
layout, at least 144 columns wide, and never after you closed it by hand (ctrl+x x). A reload of
the mod leaves an open pane open. `/track` shows or hides it at any width, and like `/btw` it acts
at once while a turn runs and adds nothing to the session; `/track status` prints the open
questions. To keep the diff
panel out of the slot, type `/diff` once.

Requirements: Claude Code with function-hook plugins, macOS/POSIX file locks, and Python 3.
The first compatibility target is the generated 2.1.292 API. Engine and fresh-process checks use
2.1.293. A 2.1.292 runtime run and a seated managed-policy Stop run are not available on this Mac.

Load it from the clone folder (`cd claude-mods`), wherever it sits, with one of:

```sh
mkdir -p ~/.claude/skills && ln -s "$PWD/track" ~/.claude/skills/track   # every session
claude --plugin-dir "$PWD/track"                                         # one session
```

or list the clone's `track` folder in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`.

Check it with `claude plugin validate track`, test it with `claude plugin test track`, and
type-check it with `tsc -p track` once Claude Code has loaded it: `track/tsconfig.json` extends
the API types that loading writes into `track/.claude-plugin/types/`.

What it saves: acknowledged tracking mutations, captured answers, explicit UI actions, completed
turns, and session end write through the existing `$.store` API and verify the result. Save failures
remain visibly **Unsaved**. Rendering performs no persistence. For each session the store holds:

- the first line of each prompt you type, without image tags, cut to 200 characters, with its
  time; prompts that start with `/` are left out; the last 200 prompts;
- each tracked question as the model summed it up, cut to 200 Unicode code points, with its status,
  optional note, stable source identity, and answer text (up to 1,000 code points); up to 200;
- the title and status of each step, cut to 200 characters; the last 300.

The store budgets serialized UTF-8 conservatively below its 4 MiB limit. It prefers 20 sessions
and a 3 MiB budget, pruning cleared/completed history first. Unfinished work is never silently
discarded. When safe pruning cannot make room, the save returns a visible capacity failure.
One process owns a session writer lease, and a shared lock serializes store writes. Stale revisions
cannot overwrite a newer durable ledger. Beside the buckets it holds an index and one flag:
set when you close the pane by hand, cleared when `/track` shows it again. Explicit pane choices
use the same owned, verified save queue. A refused preference remains unsaved in reload-persistent
state and is retried by the next acknowledged save. The mod makes no network calls of its own; what it tells the model, such as tool
results and the open-question reminder, goes with the rest of the conversation.

Use one canonical loading path on a machine: the plugin's loading identity selects its store.
For a path change, retain both legacy stores and export each with `/track export <absolute-path>`.
Load the destination alone and use `/track import <absolute-path>`. Import checks the bundle
checksum, rejects conflicting session records before writing, and reads back every copied record.
Export and import join the save queue, require writer ownership, and reconcile pending save
recovery under the shared store lock before reading records. Repeated imports are safe.
Do not retire a legacy store until its exact records have been verified.

### Local checkpoint/restore contract v1

`mcp__track__checkpoint({ expected_session })` saves and reads back the current ledger. It returns
JSON **as tool-result text**, with `v`, `ok`, `source_session`, `revision`, `checksum`, and
`counts: { questions, answers, steps }`; failures include `reason`.

`mcp__track__restore_tracker({ from_session, replace?, expected_checkpoint? })` validates an
expected checkpoint before restoring. Its receipt also names `destination_session` and
`applied_checksum`, calculated from the actual destination questions, answer text, notes, and
steps in source order, including explicit delegated ownership. The optional true field participates
in the checksum; absent fields preserve prior v1 checksums. A successful attempted call alone does not prove complete restoration.
Source links and display ids are not authority. Track works independently of handoff.

Run `claude plugin test track` for engine **FIXTURE** checks and, from the Track root,
`python3 -m unittest discover -s tests/helpers -p 'test_*.py'` for real helper locks and Stop parsing.
Fresh-process acceptance remains separate. The test-only `tests/fixtures/performance-probe` plugin
offers `/trackbench <absolute-private-output-path>` for 500 runtime-selected native tool updates;
its receipts do not measure physical terminal paint. Use matching pane geometry for render comparisons.

Remove it: delete the symlink (`rm ~/.claude/skills/track`), or take the folder out of
`CLAUDE_CODE_PLUGIN_DIRS`. The saved register stays behind in Claude Code's plugin store.

## statusline

A two-line status line: model and effort, folder and branch, prompt-cache state, context use, and live 5-hour and weekly quota. `usage-live.py` reads Claude Code's OAuth credential from the macOS Keychain to fetch the quota; it never prints or stores the token.

Install it, which copies the scripts into `~/.claude` and points `statusLine` in `~/.claude/settings.json` at them after a backup:

```sh
./statusline/install.sh
```

[statusline/README.md](statusline/README.md) has the details. This folder was `ohade/claude-statusline-setup`, merged here with its history on 2026-10-04.
