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
  note?: string
  interrupted?: true
  cleared?: true
  // The tool_use_id of the track_question call that minted it, and when it was answered:
  // a /rewind is detected by these ids leaving the transcript.
  trackedBy?: string
  answeredAt?: number
}

// A step the model set itself: a Task, a todo line, or a line of an approved plan.
export type Step = {
  id: string
  source: 'task' | 'todo' | 'plan'
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  taskId?: string
  createdRequestId?: string
  cleared?: true
}

export type Ledger = {
  v: 1
  nextQuestionId: number
  prompts: Prompt[]
  questions: Question[]
  steps: Step[]
  // Questions the user withdrew with ✕, told to the model once on the next prompt.
  withdrawn?: Array<{ id: number; head: string }>
}

// `compactedAt`: when the transcript was last compacted. Questions older than that are
// never dropped by the rewind check, because compaction removes their tool calls too.
export type Turn = { currentId: string | null; gatedTurnId: string | null; compactedAt?: number }

// `hidden` is this session's `/track` toggle; `closedByPerson` is the persistent off
// (ctrl+x x), mirrored to `$.store`.
export type Pane = { isOpen: boolean; hidden: boolean; closedByPerson: boolean }

declare module 'claude-code' {
  interface PluginState {
    track: {
      ledger: Ledger
      turn: Turn
      pane: Pane
    }
  }
}
