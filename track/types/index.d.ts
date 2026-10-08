// A typed prompt row, recorded by the harness before the model runs. `rowKey` is the
// stored row's uuid with its last group dropped; `requestId` is the id the transcript
// drew the row under, written once the row renders (the authoritative jump target).
export type Prompt = {
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
  // Brought back after a handoff: the session it came from, and the restore_tracker call whose
  // row shows it here (that row is where [ Q ] and [ A ] jump).
  restoredFrom?: string
  restoredBy?: string
  // Stable identity across restores and handoffs, independent of the display id.
  sourceId?: string
}

// What one restore_tracker call brought back, fixed at that call: its transcript row is drawn from
// this, so clearing the pane later leaves the row as it was.
export type Restore = {
  by: string
  from: string
  steps: number
  questions: Question[]
  // Acknowledged plugin user note; absent for older system notices or model tool rows.
  display?: 'user'
}

// A step the model set itself: a Task, a todo line, or an explicit track_steps row.
export type Step = {
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
  // The main turn that last started this work. Kept for reload, removed on cross-session restore.
  activeTurnId?: string
  cleared?: true
  // The step's wall clock: when it first went in progress, and when it was done.
  startedAt?: number
  endedAt?: number
}

export type Ledger = {
  v: 1
  nextQuestionId: number
  prompts: Prompt[]
  questions: Question[]
  steps: Step[]
  // Questions the user withdrew with ✕, told to the model once on the next prompt.
  withdrawn?: Array<{ id: number; head: string }>
  // When the transcript was last compacted. Questions older than that are never dropped by the
  // rewind check, because compaction removes their tool calls too. Saved with the register, so a
  // resumed session keeps it.
  compactedAt?: number
  // The newest restore_tracker calls, by tool_use_id, for drawing their rows.
  restores?: Restore[]
  restoredIds?: Record<string, number>
}

// `lastText`: the main loop's last text row, its text, and the turn it was written in.
// Only the exact composedRule proves that the current instruction reached the model.
export type Turn = {
  currentId: string | null
  gatedTurnId: string | null
  eventOrder?: number
  lastText?: { row: string; requestId?: string; turnId: string | null; order?: number; text?: string; textHash?: string }
  composeSeen?: true
  composedRule?: string
}

// The first shown row of each pane region, or null to follow the news.
export type ScrollAt = { questions: number | null; steps: number | null }

// What the session is doing, for the banner: the main turn running, Agent and AskUserQuestion
// calls in flight (tool_use ids), background agents still running, and other background work
// still running, such as shell tasks (their ids). An activity saved before tasks existed has none.
export type Activity = { isWorking: boolean; mainTurnId?: string; agentCalls: string[]; askCalls: string[]; background: string[]; tasks?: string[] }

// `hidden` is this session's `/track` toggle; `closedByPerson` is the persistent off
// (ctrl+x x), mirrored to `$.store`.
// `autoOpenDone`: this session already judged the auto-open rule, so prompt redraws stop asking.
export type Pane = { isOpen: boolean; hidden: boolean; closedByPerson: boolean; autoOpenDone?: true }

declare module 'claude-code' {
  interface PluginState {
    track: {
      ledger: Ledger
      turn: Turn
      pane: Pane
      // A jump's highlight on a transcript row, 0 when unlit; keyed by the row's requestId, or
      // by an answer's text key. `lit` lists the rows lit now, so a reload can put them out.
      flash: StateFamily<number>
      lit: string[]
      activity: Activity
      // The phase of the in-progress step's pulse, advanced by a timer while work runs.
      pulse: number
      // Each pane region's first shown row; null follows the newest question or the step at work.
      scroll: ScrollAt
      // The time the step clocks were last moved on, by a timer while a step is under way.
      tick: number
      durability: { isUnsaved: boolean; reason: string; rewindSession?: string; closedByPerson?: boolean }
    }
  }
}
