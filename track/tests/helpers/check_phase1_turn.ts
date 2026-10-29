// FIXTURE: pure turn-policy ownership and decisions; no native/LIVE claim.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { Activity, Ledger, PendingInput, Step, StepFreshness, Turn } from '../../types'

const boundary = new URL('../../hooks/turn-policy.ts', import.meta.url)
assert.ok(existsSync(boundary), 'missing turn-policy boundary: turn-policy.ts')
const source = readFileSync(boundary, 'utf8')
const composition = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
const symbols = ['QUESTION_FIRST', 'gateable', 'looksLikeQuestion', 'needsQuestion', 'ofTurn', 'ownerTasksForStep', 'waitingArrowIds', 'freshnessCandidates']
for (const symbol of symbols) {
  assert.match(source, new RegExp(`^(?:export )?const ${symbol}\\b`, 'm'), `turn-policy owns ${symbol}`)
  assert.doesNotMatch(composition, new RegExp(`^(?:const|function) ${symbol}\\b`, 'm'), `composition must import ${symbol}`)
}
assert.match(composition, /from '\.\/turn-policy'/)
assert.ok(source.trimEnd().split('\n').length <= 100, 'turn-policy stays within 100 lines')
for (const line of source.match(/^import .*$/gm) ?? []) {
  assert.match(line, line.startsWith('import type ') ? /from '\.\.\/types'$/ : /^import \{ (?:distinctIds|norm|visibleSteps) \} from '\.\/(?:ledger-policy|ledger-text|steps)'$/)
}
for (const symbol of ['minimalInputReason', 'uncoveredBlock']) {
  assert.match(composition, new RegExp(`^const ${symbol}\\b`, 'm'), `${symbol} stays native`)
  assert.doesNotMatch(source, new RegExp(`^(?:export )?const ${symbol}\\b`, 'm'))
}

// Dynamic import follows the named boundary assertion for structural assertion-red.
const { gateable, looksLikeQuestion, needsQuestion, ofTurn, ownerTasksForStep, waitingArrowIds, freshnessCandidates } = await import('../../hooks/turn-policy')
assert.equal(gateable('  hello  ', undefined), 'hello')
for (const text of ['', '  ', '/track', ': AMQ doorbell: arrived', '<task-notification>done</task-notification>', '<bash-input>pwd', '<local-command>help']) {
  assert.equal(gateable(text, undefined), undefined, `exclude non-user content: ${text}`)
}
for (const origin of ['peer', 'task-notification']) assert.equal(gateable('Why now?', origin), undefined, `exclude ${origin} origin`)
assert.equal(looksLikeQuestion('Why now'), true)
assert.equal(looksLikeQuestion('Ship now'), false)
assert.equal(looksLikeQuestion('Ship now?'), true)
const input = (id: number, extra: Partial<PendingInput> = {}): PendingInput => ({ id, head: 'Prompt', excerpt: 'Prompt', textHash: `hash-${id}`, turnId: 'current', ...extra })
assert.equal(needsQuestion(input(1, { label: 'question', wording: false })), true, 'question label overrides action wording')
assert.equal(needsQuestion(input(2, { label: 'not_question' })), false, 'not_question label overrides question wording (omitted wording)')
assert.equal(needsQuestion(input(3, { label: 'unknown', wording: false })), false)
assert.equal(needsQuestion(input(4)), true)
const inputs = [input(1), input(2, { turnId: null }), input(3, { turnId: 'old' }), input(4)]
assert.deepEqual(ofTurn(inputs, 'current'), [inputs[0], inputs[1], inputs[3]], 'bound and unbound inputs keep input order')
const activity: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [] }
const step = (id: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({ id, source: 'plan', subject: 'New title', status, ...extra })
const owned = step('plan:1', 'in_progress')
const owners = { task: ['plan:1'] }
assert.deepEqual(ownerTasksForStep({ ...activity, owners, launchOwners: [{ task: 'task', steps: [{ id: 'plan:1', subject: 'old title' }] }] }, owned), [], 'stale launch identity cannot own reused step')
assert.deepEqual(ownerTasksForStep({ ...activity, owners, launchOwners: [{ task: 'task', steps: [{ id: 'plan:1', subject: 'new title' }] }] }, owned), ['task'], 'matching normalized launch identity owns step')
assert.deepEqual(ownerTasksForStep({ ...activity, owners }, owned), ['task'], 'legacy map applies without launch row')
const arrows = ['👉 plan:1: Please answer', '```text', '👉 plan:2: hidden', '```', '~~~', '👉 plan:2: hidden again', '~~~', '👉 plan:1: Duplicate', '👉 unknown: No', '👉 todo:ship it: Confirm'].join('\n')
assert.deepEqual(waitingArrowIds(arrows, new Set(['plan:1', 'plan:2', 'todo:ship it'])), ['plan:1', 'todo:ship it'], 'fences excluded; known colon-bearing ids retained and deduplicated')
const freshness: StepFreshness = { turnId: 'current', edits: ['file'], bash: [], steps: [], completed: [{ id: 'done' }], waiting: ['wait'], held: ['untracked_edit'], nudged: [] }
const turn: Turn = { currentId: 'current', gatedTurnId: null, freshness }
const ledger: Ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [step('done', 'completed'), step('live', 'in_progress', { activeTurnId: 'current' }), step('wait', 'waiting'), step('delegated', 'in_progress', { activeTurnId: 'current', delegated: true }), step('cleared', 'in_progress', { activeTurnId: 'current', cleared: true }), step('old', 'in_progress', { activeTurnId: 'old' })] }
const candidates = [{ kind: 'premature_completion', id: 'done' }, { kind: 'stale_in_progress', id: 'live', owner_task_ids: [] }, { kind: 'missing_waiting_request', id: 'wait' }, { kind: 'untracked_edit' }]
assert.deepEqual(freshnessCandidates(turn, ledger, activity), candidates, 'candidate order, stale exclusions and held kind retention')
assert.deepEqual(freshnessCandidates({ ...turn, freshness: { ...freshness, response: { turn_id: 'current', request_id: 'response', arrow_ids: ['wait'] } } }, ledger, activity), [candidates[0], candidates[1], candidates[3]], 'answered arrow removes only waiting candidate')
assert.deepEqual(freshnessCandidates({ ...turn, freshness: { ...freshness, completed: [{ id: 'done', owner_task_ids: [] }] } }, ledger, activity), candidates.slice(1), 'explicit empty completion owners suppress completed candidate')
assert.deepEqual(freshnessCandidates({ ...turn, freshness: { ...freshness, turnId: 'old' } }, ledger, activity), [candidates[1]], 'old freshness contributes no current-turn candidates')
console.log('phase1-turn: ownership and pure turn-policy invariants satisfied (FIXTURE)')
