import type { Checkpoint } from './checkpoint'

export type SessionHead = { v: 1; session_id: string; generation: string; checkpoint: Checkpoint; closedAt?: number }
export const sameRecord = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export const sessionHead = (raw: unknown, id: string): SessionHead | undefined => {
  if (raw === undefined) return undefined
  const clock = raw as { v?: number; session_id?: string; retentionOnly?: boolean }
  if (clock?.v === 1 && clock.session_id === id && clock.retentionOnly === true &&
      Object.keys(clock).every(key => ['v', 'session_id', 'retentionOnly', 'closedAt'].includes(key))) return undefined
  const head = raw as SessionHead
  if (head?.v !== 1 || head.session_id !== id || typeof head.generation !== 'string' ||
      !Number.isSafeInteger(head.checkpoint?.revision) || head.checkpoint.revision < 1 ||
      typeof head.checkpoint.checksum !== 'string') throw new Error('durable session head is invalid; history was kept')
  return head
}

// Called after repairHead has validated any generation-less legacy body.
export const bodyMatchesHead = (body: { generation?: string; checkpoint?: Checkpoint }, head: SessionHead): boolean =>
  (body.generation === undefined || body.generation === head.generation) && sameRecord(body.checkpoint, head.checkpoint)
