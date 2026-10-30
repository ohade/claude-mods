// FIXTURE: shared cases run unchanged against the original snapshot and owner.
import assert from 'node:assert/strict'
import type { SessionHead } from '../../hooks/reconcile'
import type { Checkpoint } from '../../hooks/checkpoint'

type RecordRules = {
  sameRecord: (left: unknown, right: unknown) => boolean
  sessionHead: (raw: unknown, id: string) => SessionHead | undefined
  bodyMatchesHead: (body: { generation?: string; checkpoint?: Checkpoint }, head: SessionHead) => boolean
}

export const checkDurableRecord = ({ sameRecord, sessionHead, bodyMatchesHead }: RecordRules): void => {
  assert.equal(sameRecord(undefined, undefined), true)
  assert.equal(sameRecord(undefined, null), false)
  assert.equal(sameRecord({ a: 1, b: 2 }, { a: 1, b: 2 }), true)
  assert.equal(sameRecord({ a: 1, b: 2 }, { b: 2, a: 1 }), false, 'record comparison preserves insertion order; it must not canonicalize')
  assert.equal(sameRecord([1, 2], [2, 1]), false)
  const checkpoint: Checkpoint = { v: 1, ok: true, source_session: 's', revision: 3, checksum: 'hash', counts: { questions: 1, answers: 1, steps: 1 } }
  const head: SessionHead = { v: 1, session_id: 's', generation: 'g', checkpoint }
  assert.equal(sessionHead(undefined, 's'), undefined)
  assert.equal(sessionHead({ v: 1, session_id: 's', retentionOnly: true, closedAt: 123 }, 's'), undefined)
  assert.equal(sessionHead({ v: 1, session_id: 's', retentionOnly: true, closedAt: 'legacy' }, 's'), undefined, 'retention marker decoding does not add clock validation')
  assert.equal(sessionHead(head, 's'), head, 'valid durable head retains object identity')
  const extended = { ...head, extra: true, retentionOnly: true }
  assert.equal(sessionHead(extended, 's'), extended, 'normal durable head permits its existing extra fields')
  const emptyStrings = { ...head, generation: '', checkpoint: { ...checkpoint, checksum: '' } }
  assert.equal(sessionHead(emptyStrings, 's'), emptyStrings, 'existing decoder accepts empty string fields')
  const invalid = [null, false, 0, [], {}, { ...head, v: 2 }, { ...head, session_id: 'foreign' }, { ...head, generation: undefined },
    ...[0, -1, 1.5, NaN, Infinity, '1'].map(revision => ({ ...head, checkpoint: { ...checkpoint, revision } })),
    { ...head, checkpoint: undefined }, { ...head, checkpoint: { ...checkpoint, checksum: 1 } },
    { v: 1, session_id: 's', retentionOnly: true, extra: 1 },
    { v: 1, session_id: 'foreign', retentionOnly: true, closedAt: 1 }]
  for (const raw of invalid) assert.throws(() => sessionHead(raw, 's'), /durable session head is invalid; history was kept/, 'invalid heads retain the original refusal')
  assert.equal(bodyMatchesHead({ checkpoint }, head), true, 'validated generation-less legacy body remains compatible')
  assert.equal(bodyMatchesHead({ generation: 'g', checkpoint }, head), true)
  assert.equal(bodyMatchesHead({ generation: 'other', checkpoint }, head), false, 'explicit foreign generation must be refused')
  assert.equal(bodyMatchesHead({ generation: 'g' }, head), false)
  assert.equal(bodyMatchesHead({ generation: 'g', checkpoint: { ...checkpoint, revision: 4 } }, head), false)
  const reordered: Checkpoint = { counts: checkpoint.counts, checksum: 'hash', revision: 3, source_session: 's', ok: true, v: 1 }
  assert.equal(bodyMatchesHead({ generation: 'g', checkpoint: reordered }, head), false, 'checkpoint comparison retains exact serialization order')
}
