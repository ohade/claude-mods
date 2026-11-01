// History read routing and decoding. Native owns the process and store capabilities.
import type { Ledger } from '../types'
import type { Checkpoint } from './checkpoint'
import type { HistoryRun } from './history-receipts'
import { isPlainObject } from './history-receipts'
import { savedLedger } from './stored-codecs'
import { identifyLedger } from './reconcile'

export type HistoryRoot = { seq: number; generation: string | null; checkpoint: Checkpoint | null }
export type HistoryView = { root?: HistoryRoot; rootHash?: string; durable?: Ledger }
export type HistoryReads = { read: (store: string, id: string) => Promise<HistoryRun>; legacy: (key: string) => Promise<unknown> }

// A valid or damaged root decides the route; only an absent root defers to an
// existing legacy record, so a v3 session never falls back to legacy content.
export const readHistoryView = async (reads: HistoryReads, store: string, id: string): Promise<HistoryView | 'legacy'> => {
  const readRun = await reads.read(store, id)
  if (readRun.kind !== 'ok') throw new Error(readRun.kind === 'refused' ? readRun.reason : `v3 history read failed: ${readRun.cause}`)
  const { response } = readRun
  if (response.state === 'absent') {
    return await reads.legacy(`s:${id}`) !== undefined || await reads.legacy(`h:${id}`) !== undefined ? 'legacy' : {}
  }
  const root = response.root as HistoryRoot | undefined
  if (response.state !== 'valid' || !isPlainObject(root) || !Number.isSafeInteger(root.seq) || typeof response.root_sha256 !== 'string' ||
      (response.ledger_text !== null && typeof response.ledger_text !== 'string')) throw new Error('v3 history read receipt is incompatible')
  if (response.ledger_text === null) return { root, rootHash: response.root_sha256 }
  let parsed: unknown
  try { parsed = JSON.parse(response.ledger_text) }
  catch (error) { throw new Error('v3 history damaged: saved ledger is not JSON', { cause: error }) }
  const durable = savedLedger({ v: 1, ledger: parsed }, id)
  if (durable === undefined) throw new Error('v3 history damaged: saved ledger is incompatible')
  return { root, rootHash: response.root_sha256, durable: identifyLedger(durable, id) }
}
