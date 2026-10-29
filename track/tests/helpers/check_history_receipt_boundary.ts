// FIXTURE: checks ordinary-value receipt classification without native process execution.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

assert.ok(existsSync(new URL('../../hooks/history-receipts.ts', import.meta.url)), 'missing history receipt boundary: history-receipts.ts')
const { classifyHistoryReceipt, isPlainObject } = await import('../../hooks/history-receipts')

const hash = 'a'.repeat(64)
const request = { request_id: 'request-1' }
type Op = 'save' | 'resolve' | 'bind' | 'read' | 'collect'
type Result = { stdout: string; exitCode: number | null; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
const base = (op: Op): Record<string, unknown> => ({ protocol: 3, op, request_id: 'request-1', ok: true })
const resultFor = (response: unknown, overrides: Partial<Result> = {}): Result => ({
  stdout: JSON.stringify(response) + '\n', exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false, ...overrides,
})
const check = (op: Op, req: Record<string, unknown>, result: Result, expected: unknown): void => {
  const before = JSON.stringify({ req, result })
  assert.deepEqual(classifyHistoryReceipt(op, req, result), expected)
  assert.equal(JSON.stringify({ req, result }), before, 'classifier must not mutate inputs')
}
const success = (op: Op, response: Record<string, unknown>, req: Record<string, unknown> = request): void =>
  check(op, req, resultFor(response), { kind: 'ok', response })
const pending = (op: Op, response: unknown, cause: string, overrides: Partial<Result> = {}): void =>
  check(op, request, resultFor(response, overrides), { kind: 'pending', cause })
const save = { ...base('save'), seq: 1, root_sha256: hash }
const resolve = { ...base('resolve'), seq: 1, root_sha256: hash }
const saveIncompatible = 'history save receipt is incompatible (exit 0)'
const resolveIncompatible = 'history resolve receipt is incompatible (exit 0)'

success('save', save)
success('resolve', resolve)
success('resolve', { ...resolve, seq: null, root_sha256: null })
for (const op of ['bind', 'read', 'collect'] as const) success(op, base(op))
success('bind', { ...base('bind'), request_id: 'unrelated' }, {})

for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) pending('save', { ...save, seq }, saveIncompatible)
const { seq: _saveSeq, ...saveWithoutSeq } = save
pending('save', saveWithoutSeq, saveIncompatible)
const { root_sha256: _saveHash, ...saveWithoutHash } = save
pending('save', saveWithoutHash, saveIncompatible)
for (const root_sha256 of ['g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) pending('save', { ...save, root_sha256 }, saveIncompatible)

const { seq: _resolveSeq, ...resolveWithoutSeq } = resolve
const { root_sha256: _resolveHash, ...resolveWithoutHash } = resolve
pending('resolve', resolveWithoutSeq, resolveIncompatible)
pending('resolve', resolveWithoutHash, resolveIncompatible)
pending('resolve', { ...resolve, seq: null }, resolveIncompatible)
pending('resolve', { ...resolve, root_sha256: null }, resolveIncompatible)
pending('resolve', { ...resolve, seq: 0 }, resolveIncompatible)
pending('resolve', { ...resolve, root_sha256: 'bad' }, resolveIncompatible)

pending('save', save, 'history save receipt was truncated', { isStdoutTruncated: true })
pending('save', save, 'history save stderr was truncated', { isStderrTruncated: true })
pending('save', save, 'history save receipt was truncated', { isStdoutTruncated: true, isStderrTruncated: true })
pending('save', save, saveIncompatible, { stdout: '{\n' })
pending('save', save, saveIncompatible, { stdout: JSON.stringify(save) })
pending('save', save, saveIncompatible, { stdout: JSON.stringify(save) + '\n' + JSON.stringify(save) + '\n' })
pending('save', null, saveIncompatible)
pending('save', [], saveIncompatible)
pending('save', { ...save, protocol: 2 }, saveIncompatible)
pending('save', { ...save, op: 'read' }, saveIncompatible)
pending('save', { ...save, request_id: 'wrong' }, saveIncompatible)

const refusal = { ...save, ok: false, phase: 'precommit', reason: 'refused' }
check('save', request, resultFor(refusal, { exitCode: 1 }), { kind: 'refused', reason: 'refused' })
pending('save', { ...refusal, phase: 'postcommit' }, 'refused', { exitCode: 1 })
pending('save', refusal, 'refused', { exitCode: 2 })
pending('save', { ...base('save'), ok: false }, 'history save exit 2', { exitCode: 2 })
pending('save', { ...refusal, reason: 7 }, 'history save exit 1', { exitCode: 1 })

assert.equal(isPlainObject({}), true)
assert.equal(isPlainObject(null), false)
assert.equal(isPlainObject([]), false)
console.log('history-receipt-boundary: invariants satisfied (FIXTURE)')
