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
// the prompt row it was asked in; `answerRequestId` is the `mark_answered` tool row,
// which sits right under the answer text.
export type Question = {
  id: number
  head: string
  at: number
  rowKey?: string
  askedRequestId?: string
  turnId: string | null
  status: 'open' | 'answered' | 'deferred'
  answerRequestId?: string
  // The answer's last text row, by its row key (the row uuid's first four groups): lit with the
  // `mark_answered` row by a jump to the answer.
  answerKey?: string
  note?: string
  cleared?: true
  // The tool_use_id of the track_question call that minted it, and when it was answered:
  // a /rewind is detected by these ids leaving the transcript.
  trackedBy?: string
  answeredAt?: number
  // The answer's words, from that last text row, cut to ANSWER_CHARS: a later session shows them
  // in its restore row, since the row itself is in this session's transcript.
  answerText?: string
  // Brought back after a handoff: the session it came from, and the restore_tracker call whose
  // row shows it here (that row is where [ Q ] and [ A ] jump).
  restoredFrom?: string
  restoredBy?: string
}

// What one restore_tracker call brought back, fixed at that call: its transcript row is drawn from
// this, so clearing the pane later leaves the row as it was.
export type Restore = {
  by: string
  from: string
  steps: number
  questions: Question[]
}

// A step the model set itself: a Task, a todo line, or a line of an approved plan.
export type Step = {
  id: string
  source: 'task' | 'todo' | 'plan'
  subject: string
  // paused: started, then parked; waiting: needs the person's answer.
  status: 'pending' | 'in_progress' | 'completed' | 'paused' | 'waiting'
  taskId?: string
  createdRequestId?: string
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
}

// `lastText`: the main loop's last text row, its text, and the turn it was written in. `composeSeen`: the
// standing rule reached the model this session (prompt.compose ran), so prompts need no steps line.
export type Turn = {
  currentId: string | null
  gatedTurnId: string | null
  lastText?: { row: string; turnId: string | null; text?: string }
  composeSeen?: true
}

// The first shown row of each pane region, or null to follow the news.
export type ScrollAt = { questions: number | null; steps: number | null }

// What the session is doing, for the banner: the main turn running, Agent and AskUserQuestion
// calls in flight (tool_use ids), background agents still running, and other background work
// still running, such as shell tasks (their ids). An activity saved before tasks existed has none.
export type Activity = { isWorking: boolean; agentCalls: string[]; askCalls: string[]; background: string[]; tasks?: string[] }

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
    }
  }
}
