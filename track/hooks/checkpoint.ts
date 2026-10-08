import type { Ledger } from '../types'

// v1 local checkpoint/restore contract. The handoff reliability release requires
// receipts for actual Q/A and step values; display-row ids are not authority.
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

export const checkpointValues = (l: Ledger, session: string) => ({
  questions: l.questions.filter(q => q.cleared !== true).map(q => ({
    sourceId: q.sourceId ?? `${session}:Q${q.id}`, head: q.head, status: q.status,
    note: q.note ?? null, answerText: q.answerText ?? null, answeredAt: q.answeredAt ?? null,
  })),
  steps: l.steps.filter(s => s.cleared !== true).map(s => ({
    sourceId: s.sourceId ?? `${session}:${s.id}`, subject: s.subject, status: s.status,
    note: s.note ?? null, startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null,
  })),
})

export const checksumOf = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}

export const appliedChecksum = async (source: Ledger, destination: Ledger, from: string, to: string): Promise<string> => {
  const wanted = checkpointValues(source, from)
  const actual = checkpointValues(destination, to)
  // Compare the actual destination rows in the source's order. Missing rows
  // participate as null, so an attempted or steps-only restore cannot match.
  return checksumOf({
    questions: wanted.questions.map(q => actual.questions.find(one => one.sourceId === q.sourceId) ?? null),
    steps: wanted.steps.map(s => actual.steps.find(one => one.sourceId === s.sourceId) ?? null),
  })
}

export const describeCheckpoint = async (l: Ledger, session: string, previous?: Checkpoint): Promise<Checkpoint> => {
  const values = checkpointValues(l, session)
  const checksum = await checksumOf(values)
  return {
    v: 1, ok: true, source_session: session,
    revision: previous?.checksum === checksum ? previous.revision : (previous?.revision ?? 0) + 1,
    checksum,
    counts: { questions: values.questions.length, answers: values.questions.filter(q => q.status === 'answered').length, steps: values.steps.length },
  }
}

export const checkpointFailure = (session: string, reason: string, destination?: string): Checkpoint => ({
  v: 1, ok: false, source_session: session, ...(destination !== undefined && { destination_session: destination }),
  revision: 0, checksum: '', counts: { questions: 0, answers: 0, steps: 0 }, reason,
})

export const matchesCheckpoint = (actual: Checkpoint, expected: unknown): boolean => {
  if (expected === null || typeof expected !== 'object') return false
  const e = expected as Checkpoint
  return e.v === 1 && e.ok === true && e.source_session === actual.source_session && e.revision === actual.revision && e.checksum === actual.checksum && e.counts?.questions === actual.counts.questions && e.counts?.answers === actual.counts.answers && e.counts?.steps === actual.counts.steps
}
