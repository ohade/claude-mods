// FIXTURE: structural extraction and stored-record compatibility; no native/LIVE claim.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { Question, Restore, Step } from '../../types'

const modules = {
  'ledger-policy': ['STEP_STATUSES', 'QUESTION_STATUSES', 'MAX_PROMPTS', 'MAX_QUESTIONS', 'MAX_RESTORES', 'isDefined', 'distinctIds', 'keepRestores'],
  'ledger-text': ['HEAD_CHARS', 'ANSWER_CHARS', 'RESULT_CHARS', 'truncate', 'headOf', 'norm'],
  'stored-codecs': ['textField', 'savedPrompt', 'savedMarker', 'savedQuestion', 'savedRestore', 'savedStep', 'savedLedger'],
}
const composition = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
for (const name of Object.keys(modules)) {
  assert.ok(existsSync(new URL(`../../hooks/${name}.ts`, import.meta.url)), `missing storage boundary: ${name}.ts`)
}
for (const [name, symbols] of Object.entries(modules)) {
  const file = new URL(`../../hooks/${name}.ts`, import.meta.url)
  assert.ok(existsSync(file), `missing storage boundary: ${name}.ts`)
  const source = readFileSync(file, 'utf8')
  for (const symbol of symbols) {
    assert.match(source, new RegExp(`(?:export )?const ${symbol}\\b`), `${name} owns ${symbol}`)
    assert.doesNotMatch(composition, new RegExp(`^(?:const|function) ${symbol}\\b`, 'm'), `composition must import ${symbol}`)
  }
  assert.match(composition, new RegExp(`from './${name}'`))
  const imports = [...source.matchAll(/^import .*$/gm)].map(match => match[0])
  for (const line of imports) {
    if (name === 'ledger-text') assert.fail('ledger-text must have no imports')
    if (name === 'ledger-policy') assert.match(line, /^import type .* from '\.\.\/types'$/)
    if (name === 'stored-codecs') assert.match(line, /from '(?:\.\/ledger-policy|\.\/ledger-text|\.\/reconcile|\.\.\/types)'$/)
  }
  if (name === 'stored-codecs') {
    assert.deepEqual([...source.matchAll(/^export const (\w+)/gm)].map(match => match[1]).sort(), ['savedLedger', 'savedQuestion', 'savedStep'])
    assert.ok(source.split('\n').length <= 201, 'stored-codecs stays within 200 lines')
  }
  if (name === 'ledger-text') assert.ok(source.split('\n').length <= 101)
}

// Imports follow existence assertions so the baseline fails on the named boundary.
const policy = await import('../../hooks/ledger-policy')
const text = await import('../../hooks/ledger-text')
const { savedLedger, savedQuestion, savedStep } = await import('../../hooks/stored-codecs')
assert.deepEqual(policy.STEP_STATUSES, ['pending', 'in_progress', 'completed', 'paused', 'waiting'])
assert.deepEqual(policy.QUESTION_STATUSES, ['open', 'answered', 'deferred'])
assert.deepEqual([policy.MAX_STEPS, policy.MAX_PROMPTS, policy.MAX_QUESTIONS, policy.MAX_RESTORES], [300, 200, 200, 3])
assert.deepEqual([text.HEAD_CHARS, text.ANSWER_CHARS, text.RESULT_CHARS], [200, 1000, 1000])
assert.equal(text.headOf(' [Image #2] Hello\nSecond'), 'Hello')
assert.equal(text.truncate('😀abc', 3), '😀a…')
assert.equal(text.headOf('x'.repeat(201)), 'x'.repeat(199) + '…')
assert.equal(text.norm(' 12. Build,   THIS! '), 'build this')
assert.equal(text.norm('- [x] Build this'), 'build this')
assert.deepEqual([undefined, null, 0, false, ''].filter(policy.isDefined), [null, 0, false, ''])
assert.deepEqual(policy.distinctIds(['a', 'b', 'a']), ['a', 'b'])
assert.deepEqual(policy.distinctIds(Array.from({ length: 302 }, (_, i) => `${i}`)), Array.from({ length: 300 }, (_, i) => `${i + 2}`))
const question = (id: number, extra: Partial<Question> = {}): Question => ({ id, head: `Q${id}`, at: id, turnId: null, status: 'open', ...extra })
const step = (id: string, status: Step['status'] = 'pending'): Step => ({ id, subject: id, source: 'plan', status })
const hash = 'a'.repeat(64)
const marked = question(9, { status: 'answered', answerText: 'Answer', answerTextHash: hash, answerMarker: { turnId: 'turn', order: 4 }, answerKey: 'native', answerTurnId: 'turn', answerOrder: 4, answeredBy: 'call', answerRequestId: 'request', trackedBy: 'track', trackedOrder: 2, sourceId: 'origin', cleared: true })
assert.deepEqual(savedQuestion(marked), marked, 'answerMarker and full answer provenance survive reload (reject missing-marker implementation)')
for (const invalid of [null, undefined, false, 1, '', {}, [], { ...marked, status: 'unknown' }, { ...marked, head: 2 }]) assert.equal(savedQuestion(invalid), undefined)
for (const marker of [{ turnId: '', order: 1 }, { turnId: 't', order: -1 }, { turnId: 't', order: 0.5 }, { turnId: 't', order: Infinity }]) assert.equal(savedQuestion({ ...marked, answerMarker: marker })?.answerMarker, undefined)
assert.equal(savedQuestion({ ...marked, answerTextHash: hash.toUpperCase(), answerOrder: -1 })?.answerTextHash, undefined)
assert.equal(savedQuestion({ ...marked, answerText: 'x'.repeat(1001), note: 'n'.repeat(201) })?.answerText, 'x'.repeat(999) + '…')
assert.equal(savedQuestion({ ...marked, note: 'n'.repeat(201) })?.note?.length, 200)
const completed = { ...step('done', 'completed'), resultText: 'Verified', resultTextHash: hash, resultRequestId: 'req', resultTurnId: 'turn', resultAt: 12 }
assert.deepEqual(savedStep(completed), completed)
for (const invalid of [undefined, null, {}, [], { ...completed, status: 'bad' }, { ...completed, source: 'bad' }, { ...completed, id: 4 }]) assert.equal(savedStep(invalid), undefined)
for (const status of policy.STEP_STATUSES) {
  const parsed = savedStep({ ...completed, status, delegated: true, activeTurnId: 'active' })!
  assert.equal(parsed.resultText, status === 'completed' ? 'Verified' : undefined)
  assert.equal(parsed.resultTextHash, status === 'completed' ? hash : undefined)
  assert.equal(parsed.activeTurnId, status === 'in_progress' ? 'active' : undefined)
  assert.equal(parsed.delegated, status === 'completed' || status === 'waiting' ? undefined : true)
}
assert.equal(savedStep({ ...completed, resultText: ' ' })?.resultText, undefined)
assert.equal(savedStep({ ...completed, resultAt: Infinity, resultTextHash: 'invalid' })?.resultAt, undefined)
assert.equal(savedStep({ ...completed, resultText: 'x'.repeat(1001) })?.resultText, 'x'.repeat(1000))
const restores: Restore[] = Array.from({ length: 6 }, (_, i) => ({ by: `r${i}`, from: 'source', steps: 2, questions: [] }))
assert.deepEqual(policy.keepRestores(restores, [question(1, { restoredBy: 'r0' })]).map(row => row.by), ['r0', 'r3', 'r4', 'r5'])
assert.deepEqual(policy.keepRestores(restores, [question(1, { restoredBy: 'r0', cleared: true })]).map(row => row.by), ['r3', 'r4', 'r5'])
const bucket = { v: 1, ledger: { nextQuestionId: 1, prompts: [{ rowKey: 'p', head: '[Image #1] Prompt\nextra', at: 3, requestId: 'req' }, null], questions: [marked, question(3), null], steps: [step('z'), completed, step('a')], withdrawn: [{ id: 42, head: 'withdrawn' }], restores, restoredIds: { good: 4, bad: -1, fractional: 1.5 } } }
const parsed = savedLedger(bucket)!
assert.deepEqual(parsed.questions.map(row => row.id), [9, 3])
assert.deepEqual(parsed.steps.map(row => row.id), ['z', 'done', 'a'])
assert.equal(parsed.nextQuestionId, 43)
assert.deepEqual(parsed.prompts, [{ rowKey: 'p', head: 'Prompt', at: 3, requestId: 'req', turnId: null }])
assert.deepEqual(parsed.restoredIds, { good: 4 })
for (const invalid of [undefined, null, {}, { v: 2, ledger: {} }, { v: 1, ledger: null }]) assert.equal(savedLedger(invalid), undefined)
assert.deepEqual(savedLedger({ v: 1, ledger: {} }), { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] })
for (const field of ['questions', 'steps', 'prompts', 'withdrawn', 'restores']) {
  assert.throws(() => savedLedger({ v: 1, ledger: { [field]: [{ session_id: 'other' }] } }, 'owner'), /ledger identity is ambiguous/)
}
assert.throws(() => savedLedger({ v: 1, ledger: { session_id: 'other' } }, 'owner'), /ledger identity is ambiguous/)
assert.throws(() => savedLedger({ v: 1, ledger: { restores: [{ questions: [{ session_id: 'other' }] }] } }, 'owner'), /ledger identity is ambiguous/)
const oversized = savedLedger({ v: 1, ledger: {
  prompts: Array.from({ length: 202 }, (_, i) => ({ rowKey: `${i}`, head: 'p', at: i })),
  questions: [marked, ...Array.from({ length: 201 }, (_, i) => question(i + 20))],
  steps: [completed, ...Array.from({ length: 301 }, (_, i) => step(`${i}`))],
} })!
assert.equal(oversized.prompts.length, 200)
assert.equal(oversized.prompts[0]?.rowKey, '2')
assert.deepEqual(oversized.questions.map(row => row.id), Array.from({ length: 201 }, (_, i) => i + 20))
assert.deepEqual(oversized.steps.map(row => row.id), Array.from({ length: 301 }, (_, i) => `${i}`))
assert.equal(oversized.nextQuestionId, 221)
const restored = savedLedger({ v: 1, ledger: { restores: [{ by: 'r', from: 's', steps: 2, visibleSteps: 1, display: 'user', questions: [marked, null] }] } })!
assert.deepEqual(restored.restores, [{ by: 'r', from: 's', steps: 2, visibleSteps: 1, display: 'user', questions: [marked] }])
console.log('phase1-codecs: codec invariants satisfied (FIXTURE)')
