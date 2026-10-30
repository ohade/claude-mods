import type { PendingInput } from '../types'
import { truncate, utf8Bytes } from './ledger-text'

const MINIMAL_INPUT_BYTES = 100

export const minimalInputReason = (input: PendingInput, questionTool: string): string => {
  // 2026-10-26: internal input ids are not shown to the model. Keep an excerpt,
  // bounded by serialized bytes as well as points so Unicode stays in the reserve.
  for (let width = 20; width >= 1; width--) {
    const reason = `track: "${truncate(input.excerpt, width)}" needs ${questionTool}.`
    if (utf8Bytes({ id: input.id, reason }) < MINIMAL_INPUT_BYTES) return reason
  }
  throw new Error('bounded Stop input reason exceeded')
}

// The Stop message for the inputs no row covered, quoting each one's first 80 characters. It names
// only repairs that cover, preserving existing work when the request reuses it. Steps never cover
// an input Haiku labelled a question (CC-185, 2026-10-11: the message offered track_steps for those).
export const uncoveredBlock = (inputs: PendingInput[], answerInstruction: string): string => {
  const quoted = (some: PendingInput[]) => some.map(i => `"${i.excerpt}"`).join('; ')
  const labelled = inputs.filter(i => i.label === 'question')
  const worded = inputs.filter(i => i.label !== 'question')
  const parts: string[] = []
  if (worded.length > 0) {
    const tail = `${answerInstruction}; for a request instead, reuse a matching open step with mcp__track__mark_step, keeping its current status and the same source_text. For new work, call mcp__track__track_steps with the same source_text; use after when steps already exist so their rows and statuses are kept. Then finish.`
    parts.push(worded.length === 1
      ? `track: a prompt looks like a question (${quoted(worded)}) but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, ${tail}`
      : `track: these prompts look like questions (${quoted(worded)}) but no Track row was written for them. Call mcp__track__track_question for each with source_text = its first line, ${tail}`)
  }
  if (labelled.length > 0) {
    const tail = `${answerInstruction}. If it is a request already tracked as steps, mark that question deferred with a note naming the step. Then finish.`
    parts.push(labelled.length === 1
      ? `track: the classifier labelled a prompt a question (${quoted(labelled)}) and no question row covers it; steps never cover a labelled question. Call mcp__track__track_question with source_text = its first line, ${tail}`
      : `track: the classifier labelled these prompts questions (${quoted(labelled)}) and no question row covers them; steps never cover a labelled question. Call mcp__track__track_question for each with source_text = its first line, ${tail}`)
  }
  return parts.join(' ')
}
