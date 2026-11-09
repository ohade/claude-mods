// A typed prompt row, recorded by the harness before the model runs. `rowKey` is the
// stored row's uuid with its last group dropped; `requestId` is the id the transcript
// drew the row under, written once the row renders (the authoritative jump target).
export type Prompt = {
  session_id?: string
  rowKey: string
  requestId?: string
  turnId: string | null
  head: string
  at: number
}

// A question the model sent to the panel with `track_question`. `askedRequestId` is
// its verified source or tracking call; `answerRequestId` identifies the native answer
// or the call that first displayed explicitly supplied completed text.
// Legacy ledgers may still have the acknowledgement there; jumps use answerKey.
export type Question = {
  session_id?: string
  id: number
  head: string
  at: number
  rowKey?: string
  askedRequestId?: string
  turnId: string | null
  status: 'open' | 'answered' | 'deferred'
  answerRequestId?: string
  // The status call is kept separately when a later response is the visible answer.
  answeredBy?: string
  // Explicit completed words can reanchor to matching later text in this same turn.
  answerTurnId?: string
  answerOrder?: number
  // The verified native text row key, or the call displaying explicit answer text.
  answerKey?: string
  // The render instance that answerKey was drawn under, as the host reported it. Kept in the
  // ledger because $.state lasts one process, so a cold resume can still jump to its reply.
  answerInstance?: string
  // The session that drew answerInstance; another session never jumps to it.
  answerInstanceSession?: string
  note?: string
  cleared?: true
  // The tool_use_id of the track_question call that minted it, and when it was answered:
  // a /rewind is detected by these ids leaving the transcript.
  trackedBy?: string
  // Monotonic order of the tracking event, compared with text in the same turn.
  trackedOrder?: number
  answeredAt?: number
  // The model-identified completed answer, cut to ANSWER_CHARS: a later session shows it
  // in its restore row, since the row itself is in this session's transcript.
  answerText?: string
  // SHA-256 of the full completed words, for source matching beyond the saved cap.
  answerTextHash?: string
  // Native A-marker provenance and order, kept with its text/source in one row update.
  answerMarker?: { turnId: string; order: number }
  // Brought back after a handoff: the session it came from, and the user-row receipt
  // that confirmed it. [ Q ] and [ A ] show the saved text in the pane.
  restoredFrom?: string
  restoredBy?: string
  // Stable identity across restores and handoffs, independent of the display id.
  sourceId?: string
}

// What one restore_tracker call brought back, fixed at that call: its transcript row is drawn from
// this, so clearing the pane later leaves the row as it was.
export type Restore = {
  session_id?: string
  by: string
  from: string
  steps: number
  // CC-181: current rows at restoration. Absent on legacy records whose total
  // included cleared history; those notices retain their original bytes.
  visibleSteps?: number
  questions: Question[]
  // Acknowledged plugin user note; absent for older system notices or model tool rows.
  display?: 'user'
}

// A step the model set itself: a Task, a todo line, or an explicit track_steps row.
export type Step = {
  session_id?: string
  id: string
  source: 'task' | 'todo' | 'plan'
  subject: string
  // paused: started, then parked; waiting: needs the person's answer.
  status: 'pending' | 'in_progress' | 'completed' | 'paused' | 'waiting'
  taskId?: string
  createdRequestId?: string
  sourceId?: string
  note?: string
  // Explicit work ownership, independent of whether agents run through Agent or a shell.
  delegated?: true
  // Unknown unless explicitly false: all owners are recorded local background tasks.
  external_owner?: boolean
  // Background work finished while this row was still open. The status stays until the lead updates it.
  followUp?: true
  // The main turn that last started this work. Kept for reload, removed on cross-session restore.
  activeTurnId?: string
  cleared?: true
  // The step's wall clock: when it first went in progress, and when it was done.
  startedAt?: number
  endedAt?: number
  // Explicit completed words and their acknowledged native mark_step source.
  resultText?: string
  resultTextHash?: string
  resultRequestId?: string
  resultAt?: number
  resultTurnId?: string
}

export type Ledger = {
  session_id?: string
  v: 1
  nextQuestionId: number
  prompts: Prompt[]
  questions: Question[]
  steps: Step[]
  // Questions the user withdrew with ✕, told to the model once on the next prompt.
  withdrawn?: Array<{ id: number; head: string; session_id?: string }>
  // Unfinished steps the user removed with a confirmed "clear all", told to the model once on the
  // next prompt.
  clearedSteps?: Array<{ id: string; head: string; session_id?: string }>
  // When the transcript was last compacted. Questions older than that are never dropped by the
  // rewind check, because compaction removes their tool calls too. Saved with the register, so a
  // resumed session keeps it.
  compactedAt?: number
  // The newest restore_tracker calls, by tool_use_id, for drawing their rows.
  restores?: Restore[]
  restoredIds?: Record<string, number>
}

// Native validation failed on 2026-10-19 because the public contract imported
// Baseline from hooks. Keep its dependency types here, without external imports.
export type Checkpoint = {
  v: 1
  ok: boolean
  source_session: string
  destination_session?: string
  applied_checksum?: string
  revision: number
  checksum: string
  counts: { questions: number; answers: number; steps: number }
  reason?: string
}

// TRACK-21 (2026-10-11): the verified row version used by three-way saving.
export type Baseline = { session_id: string; ledger: Ledger; checkpoint?: Checkpoint; generation?: string }

// `lastText`: the main loop's last text row, its text, and the turn it was written in.
// Only the exact composedRule proves that the current instruction reached the model.
export type FreshnessKind = 'premature_completion' | 'stale_in_progress' | 'finished_delegation' | 'missing_waiting_request' | 'untracked_edit'
export type FreshnessCandidate = { kind: FreshnessKind; id?: string; owner_task_ids?: string[]; external_owner?: boolean; subject?: string }
export type StepFreshness = {
  turnId: string
  edits: string[]
  bash: string[]
  steps: string[]
  completed: Array<{ id: string; owner_task_ids?: string[] }>
  waiting: string[]
  response?: { turn_id: string; request_id: string; arrow_ids: string[] }
  held: FreshnessKind[]
  nudged: string[]
}
export type Turn = {
  currentId: string | null
  gatedTurnId: string | null
  eventOrder?: number
  lastText?: { row: string; requestId?: string; turnId: string | null; order?: number; text?: string; textHash?: string }
  composeSeen?: true
  composedRule?: string
  // TRACK-27: current-turn facts only, never persisted in ledger rows.
  freshness?: StepFreshness
  stepReminder?: string
  resultReminder?: { turnId: string; ids: string[] }
  resultNudgedTurnId?: string
  // Nudge codes already shown while the turn identity was unknown, once per session.
  turnlessNudged?: string[]
}

// A question-like main prompt waiting for a Track row (CC-179). `head` is its first line, which a
// named source must match; `excerpt` its first 80 characters, quoted by Stop. `turnId` is null
// until its turn is known. `held`: Stop already asked for it once. `wording: false`: the wording
// check saw no question, kept only for Haiku to judge. `label`: Haiku's, once it answered.
// `textHash`: SHA-256 of the full text, its identity for redelivery. `rowKey`: its transcript row,
// what a source_request_id must name. `covered`: the kind of accepted row that covered it, and
// `questionId` the question row, which covers no other input.
export type PendingInput = { id: number; head: string; excerpt: string; textHash: string; rowKey?: string; turnId: string | null; covered?: 'question' | 'steps'; questionId?: number; held?: true; wording?: false; label?: 'question' | 'not_question' | 'unknown'; legacy?: true }
// legacy: admitted before its queue had an epoch, so its helper claim keeps the input:<id> name.
// epoch: one runtime's input numbering (TRACK-46 S2); a new process restarts nextId at 1.
export type Pending = { inputs: PendingInput[]; nextId: number; epoch?: string }

// The first shown row of each pane region, or null to follow the news.
export type ScrollAt = { questions: number | null; steps: number | null }

// What the session is doing, for the banner: the main turn running, Agent and AskUserQuestion
// calls in flight (tool_use ids), background agents still running, and other background work
// still running, such as shell tasks (their ids). An activity saved before tasks existed has none.
export type Activity = { isWorking: boolean; mainTurnId?: string; agentCalls: string[]; askCalls: string[]; background: string[]; tasks?: string[]; owners?: Record<string, string[]>; ownerOrder?: string[]; launchOwners?: Array<{ task: string; steps: Array<{ id: string; subject: string }> }>; launchSeq?: number; launchNumbers?: Array<{ task: string; seq: number }> }

// `hidden` is this session's `/track` toggle; `closedByPerson` is the persistent off
// (ctrl+x x), mirrored to `$.store`.
// `autoOpenDone`: this session already judged the auto-open rule, so prompt redraws stop asking.
export type Pane = { isOpen: boolean; hidden: boolean; closedByPerson: boolean; autoOpenDone?: true }

declare module 'claude-code' {
  // 2026-11-03: any connected MCP server closes the SDK's tool-name union.
  // Declare our registered tools through its authored merge seam, not generated types.
  interface McpToolInputs {
    mcp__track__track_question: {
      summary: string; source_request_id?: string; source_text?: string
    }
    mcp__track__mark_answered: {
      id: number; status: 'answered' | 'deferred'; note?: string
      answer_text?: string; answer_request_id?: string
    }
    mcp__track__track_steps: {
      steps: string[]; after?: string; replace?: boolean; source_text?: string
    }
    mcp__track__restore_tracker: {
      from_session: string; replace?: boolean; expected_checkpoint?: Record<string, unknown>
    }
    mcp__track__checkpoint: { expected_session: string }
    mcp__track__lookup_rows: { references?: string[] }
    mcp__track__diagnose: {}
    mcp__track__reorder_steps: { ids: string[] }
    mcp__track__mark_step: {
      id: string; status: Step['status']
      result_text?: string; source_text?: string; source_request_id?: string
      note?: string; delegated?: boolean; external_owner?: boolean
    }
  }

  interface PluginState {
    track: {
      ledger: Ledger
      turn: Turn
      pane: Pane
      // A jump's highlight on a transcript row, 0 when unlit; keyed by the row's requestId, or
      // by an answer's text key. `lit` lists the rows lit now, so a reload can put them out.
      flash: StateFamily<number>
      lit: string[]
      // The render instances drawn in one session, by row key, so a reload can still jump to a
      // row it does not draw again (TRACK-48). Another session's copy is never read.
      renders: { session: string | null; rows: [string, string][] }
      activity: Activity
      pending: Pending
      // The phase of the in-progress step's pulse, advanced by a timer while work runs.
      pulse: number
      // Each pane region's first shown row; null follows the newest question or the step at work.
      scroll: ScrollAt
      // The time the step clocks were last moved on, by a timer while a step is under way.
      tick: number
      durability: { isUnsaved: boolean; reason: string; memorySession?: string | null; rewindSession?: string; closedByPerson?: boolean; baseline?: Baseline; rewindBaseline?: Pick<Baseline, 'session_id' | 'ledger'>; unverifiedQuestions?: Pick<Question, 'id' | 'at' | 'head'>[] }
      // TRACK-39 V3: a history save whose outcome is unknown, resolved before the next save.
      historyPending: { session_id: string; request_id: string; expect: { absent: true } | { seq: number; root_sha256: string } } | null
      // A restored row's saved text drawn in the pane, by question id: its question or answer side.
      reveal: Record<string, 'q' | 'a' | 'r' | undefined>
      // Pane rows unfolded to their whole text, keyed q:<id> and s:<id>; rows start folded to one
      // line. Never saved.
      expanded: Record<string, true | undefined>
      // When the steps' "clear all" was pressed with unfinished steps, waiting for a second press;
      // null when not armed. Never saved.
      clearArm: number | null
    }
  }
}
