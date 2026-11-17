// Prompt admission uses the current pending rows and the caller's prompt snapshot.
import type { Pending, PendingInput, Prompt } from '../types'
import { norm } from './ledger-text'

export const MAX_INPUTS = 50
// labelling: ids whose classifier is still running; their label may still change coverage.
// needsRow: the caller's question-row rule (turn-policy needsQuestion); absent, no uncovered row is a victim.
type InputValues = Pick<PendingInput, 'head' | 'excerpt' | 'textHash' | 'turnId' | 'fragment'> & { wording: boolean; prompts: readonly Prompt[]; labelling?: ReadonlySet<number>; needsRow?: (input: PendingInput) => boolean }

export const admitInput = (p: Pending, values: InputValues): { next: Pending; added?: number; full: boolean } => {
  const { head, excerpt, textHash, turnId, fragment, wording, prompts, labelling = new Set<number>(), needsRow = () => true } = values
  // A same-turn redelivery includes an unbound input arriving inside a turn.
  if (p.inputs.some(i => i.textHash === textHash && (i.turnId === turnId || (i.turnId === null && turnId !== null)))) return { next: p, full: false }
  let inputs = p.inputs
  if (inputs.length >= MAX_INPUTS) {
    // TRACK-46 S3/C2: a victim is settled. Steps coverage whose label is still coming can be
    // revoked by a question label, so it stays; a row that needs no question row and has no
    // label coming frees its slot; a question still waiting for a row is never a victim.
    const done = inputs.find(i => i.covered !== undefined && !(i.covered === 'steps' && i.label === undefined && labelling.has(i.id)))
      ?? inputs.find(i => i.label === 'not_question')
      ?? inputs.find(i => i.covered === undefined && !needsRow(i) && !labelling.has(i.id))
    if (done === undefined) return { next: p, full: true }
    inputs = inputs.filter(i => i.id !== done.id)
  }
  const taken = new Set(inputs.map(i => i.rowKey))
  const row = [...prompts].reverse().find(r => r.turnId === null && norm(r.head) === norm(head) && !taken.has(r.rowKey))?.rowKey
  return { next: { inputs: [...inputs, { id: p.nextId, head, excerpt, textHash, turnId, ...(fragment !== undefined && { fragment }), ...(row !== undefined && { rowKey: row }), ...(!wording && { wording: false as const }) }], nextId: p.nextId + 1 }, added: p.nextId, full: false }
}

// A prompt cut off by an injected doorbell and then re-sent whole: the user's own words in the
// earlier fragment are the start of the later prompt, so the fragment needs no row. Both sides
// are compared as lowercase words with image tags dropped, but sentence punctuation kept.
const FRAGMENT_CHARS = 2000
const compact = (text: string): string => text.replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
// What the user typed before a doorbell, when it can be a cut-off start of a later prompt: a
// sentence ending in ?, . or ! is complete, and a very long one is not recorded (it keeps its row).
export const fragmentKey = (asked: string): string | undefined => {
  const key = compact(asked)
  return key === '' || key.length > FRAGMENT_CHARS || /[?.!]$/.test(key) ? undefined : key
}
export const askedKey = compact
// The prompt being admitted (matched by hash, as on redelivery) never supersedes itself.
export const isResentFragment = (i: PendingInput, later: string, textHash: string): boolean =>
  i.fragment !== undefined && i.superseded !== true && i.covered === undefined && i.textHash !== textHash && later.startsWith(i.fragment)

export const supersedeFragments = (p: Pending, later: string, textHash: string): Pending =>
  p.inputs.some(i => isResentFragment(i, later, textHash))
    ? { ...p, inputs: p.inputs.map(i => (isResentFragment(i, later, textHash) ? { ...i, superseded: true as const } : i)) }
    : p
