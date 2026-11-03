// Prompt admission uses the current pending rows and the caller's prompt snapshot.
import type { Pending, PendingInput, Prompt } from '../types'
import { norm } from './ledger-text'

export const MAX_INPUTS = 50
type InputValues = Pick<PendingInput, 'head' | 'excerpt' | 'textHash' | 'turnId'> & { wording: boolean; prompts: readonly Prompt[] }

export const admitInput = (p: Pending, values: InputValues): { next: Pending; added?: number; full: boolean } => {
  const { head, excerpt, textHash, turnId, wording, prompts } = values
  // A same-turn redelivery includes an unbound input arriving inside a turn.
  if (p.inputs.some(i => i.textHash === textHash && (i.turnId === turnId || (i.turnId === null && turnId !== null)))) return { next: p, full: false }
  let inputs = p.inputs
  if (inputs.length >= MAX_INPUTS) {
    const done = inputs.find(i => i.covered !== undefined) ?? inputs.find(i => i.label === 'not_question')
    if (done === undefined) return { next: p, full: true }
    inputs = inputs.filter(i => i.id !== done.id)
  }
  const taken = new Set(inputs.map(i => i.rowKey))
  const row = [...prompts].reverse().find(r => r.turnId === null && norm(r.head) === norm(head) && !taken.has(r.rowKey))?.rowKey
  return { next: { inputs: [...inputs, { id: p.nextId, head, excerpt, textHash, turnId, ...(row !== undefined && { rowKey: row }), ...(!wording && { wording: false as const }) }], nextId: p.nextId + 1 }, added: p.nextId, full: false }
}
