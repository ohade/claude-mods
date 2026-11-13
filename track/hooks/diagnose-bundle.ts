// Failure-intake diagnose answer: its shapes and its byte cap. Pure: no engine value is ever an input.
import { utf8Bytes } from './ledger-text'

// A D5/D6 event ring entry: ids, counts, enums and booleans, never text. register.tsx keeps the ring.
export type RingValue = string | number | boolean | null | ReadonlyArray<string | number>
export type RingEntry = { at: number; code: string; turn_id?: string; meta: Record<string, RingValue>; truncated?: true }
// The D10 projection of the last published gate snapshot. register.tsx keeps the cached one.
export type GateProjection = { session_id: string; gate: { open_count: number; input_count: number; inputs_complete: boolean; candidate_kinds: string[]; held: string[]; truncated: boolean } }

export const DIAGNOSE_BYTES = 32 * 1024

export type Bundle = Record<string, any>
// D8: the whole serialized answer is at most 32 KiB UTF-8. The ring is trimmed oldest first, then each
// id array in a fixed order keeps its longest fitting prefix; every trimmed array is flagged beside it.
export const fitBundle = (bundle: Bundle): string => {
  const fits = () => utf8Bytes(bundle) <= DIAGNOSE_BYTES
  while (!fits() && bundle.ring.length > 0) {
    bundle.ring.shift()
    bundle.ring_truncated = true
    bundle.truncated = true
  }
  const arrays: Array<[Bundle, string]> = [[bundle.activity, 'background_ids'], [bundle.activity, 'task_ids'],
    [bundle.turn.freshness ?? {}, 'completed_ids'], [bundle.turn.freshness ?? {}, 'waiting_ids'], [bundle, 'claims']]
  for (const [holder, field] of arrays) {
    if (fits()) break
    const full = holder[field]
    if (!Array.isArray(full) || full.length === 0) continue
    holder[`${field}_truncated`] = true
    bundle.truncated = true
    let low = 0
    let high = full.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      holder[field] = full.slice(0, middle)
      if (fits()) low = middle
      else high = middle - 1
    }
    holder[field] = full.slice(0, low)
  }
  if (fits()) return JSON.stringify(bundle)
  return JSON.stringify({ v: 1, identity: bundle.identity, session_id: bundle.session_id, truncated: true })
}

// Failure-intake D2/I4: what the statically imported build identity says about the executing module.
// Pure: no disk, git or engine value is ever an input, so a bad module reads as unknown, never as a fallback.
export type LoadedIdentity = { loaded: string } | { loaded: 'unknown'; reason: string }

export const identityOf = (module: unknown): LoadedIdentity => {
  if (module === null || typeof module !== 'object') return { loaded: 'unknown', reason: 'identity module exports no object' }
  const { v, source_fingerprint: fingerprint, source_base: base, generated_at: generatedAt } = module as Record<string, unknown>
  if (v !== 1) return { loaded: 'unknown', reason: 'identity metadata version is not 1' }
  if (typeof fingerprint !== 'string') return { loaded: 'unknown', reason: 'source_fingerprint is not a string' }
  if (fingerprint === 'unknown') return { loaded: 'unknown', reason: 'identity module is the placeholder' }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) return { loaded: 'unknown', reason: 'source_fingerprint is not 64 lowercase hex' }
  if (typeof base !== 'string') return { loaded: 'unknown', reason: 'source_base is not a string' }
  if (typeof generatedAt !== 'string') return { loaded: 'unknown', reason: 'generated_at is not a string' }
  return { loaded: fingerprint }
}
