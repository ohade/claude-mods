// FIXTURE: ownership persistence and selector contracts, without native sessions.
import assert from 'node:assert/strict'
import * as commands from '../../hooks/step-commands'
import { markStep } from '../../hooks/step-commands'
import { withStatus } from '../../hooks/ledger-policy'
import { savedStep } from '../../hooks/stored-codecs'
import { checkpointValues } from '../../hooks/checkpoint'
import { freshnessCandidates } from '../../hooks/turn-policy'
import { toolContracts } from '../../hooks/tool-contracts'
import type { Activity, Ledger, Step, StepFreshness, Turn } from '../../types'

const original: Step = { id: 'plan:1', source: 'plan', subject: 'Work', status: 'in_progress', followUp: true }
const ledger = (step: Step): Ledger => ({ v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [step] })
const payload = { id: 'plan:1', status: 'in_progress' as const, now: 1, currentId: 'current', delegated: true, external_owner: false }
const marked = markStep(ledger(original), payload).ledger.steps[0]!
assert.equal(Reflect.get(marked, 'external_owner'), false, 'markStep retains an explicit local-only declaration')

const delegationError = Reflect.get(commands, 'delegationError')
assert.equal(typeof delegationError, 'function')
assert.equal(delegationError({ delegated: 'yes' }), 'track: delegated must be a boolean.')
for (const values of [{ external_owner: false }, { delegated: false, external_owner: true }, { delegated: true, external_owner: 'false' }]) {
  assert.equal(delegationError(values), 'track: external_owner must be a boolean and requires delegated:true.')
}
for (const values of [{}, { delegated: false }, { delegated: true }, { delegated: true, external_owner: false }, { delegated: true, external_owner: true }]) assert.equal(delegationError(values), undefined)

const update = (step: Step, extra: { status?: Step['status']; delegated?: boolean; external_owner?: boolean } = {}): Step =>
  markStep(ledger(step), { id: step.id, status: 'in_progress', now: 2, currentId: 'current', ...extra }).ledger.steps[0]!
const field = (value: object) => Reflect.get(value, 'external_owner')
assert.equal(field(update(original, { delegated: true, external_owner: true })), true)
assert.equal(field(update(original, { delegated: true })), undefined)
assert.equal(field(update(marked)), false)
assert.equal(field(update(marked, { delegated: true, external_owner: true })), true)
assert.equal(field(update(marked, { delegated: false })), undefined)
assert.equal(update(marked, { delegated: false }).delegated, undefined)
for (const status of ['completed', 'waiting'] as const) {
  assert.equal(field(update(marked, { status })), undefined)
  assert.equal(update(marked, { status }).delegated, undefined)
  assert.equal(field(withStatus(marked, status, 2)), undefined)
}
const completed = update(marked, { status: 'completed' })
assert.equal(field(update(completed, { delegated: true })), undefined, 'completed ownership cannot return when re-delegated without a declaration')
assert.equal(field(update(marked, { status: 'paused' })), false)
assert.equal(field(withStatus(marked, 'paused', 2)), false)
const unowned = { ...original, external_owner: false }
assert.equal(field(withStatus(unowned, 'pending', 2)), undefined)
assert.equal(update({ ...marked, followUp: true }, { delegated: true }).followUp, undefined)

for (const value of [false, true]) assert.equal(field(savedStep({ ...original, delegated: true, external_owner: value })!), value)
for (const row of [original, { ...original, delegated: true, external_owner: 'false' }, { ...original, external_owner: false }, { ...original, status: 'completed', delegated: true, external_owner: false }, { ...original, status: 'waiting', delegated: true, external_owner: false }]) assert.equal(field(savedStep(row)!), undefined)
const legacy = checkpointValues(ledger(original), 's')
assert.equal(JSON.stringify(legacy), '{"questions":[],"steps":[{"sourceId":"s:plan:1","subject":"Work","status":"in_progress","note":null,"startedAt":null,"endedAt":null}]}')
const checkpointFalse = checkpointValues(ledger(marked), 's')
const checkpointTrue = checkpointValues(ledger(update(marked, { delegated: true, external_owner: true })), 's')
assert.equal(field(checkpointFalse.steps[0]!), false)
assert.equal(field(checkpointTrue.steps[0]!), true)
assert.notDeepEqual(checkpointFalse, checkpointTrue)

const freshness: StepFreshness = { turnId: 'current', edits: [], bash: [], steps: [], completed: [], waiting: [], held: [], nudged: [] }
const turn: Turn = { currentId: 'current', gatedTurnId: null, freshness }
const activity: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [], owners: {}, launchOwners: [
  { task: 'done-1', steps: [{ id: 'plan:1', subject: 'work' }] },
  { task: 'done-2', steps: [{ id: 'plan:1', subject: 'work' }] },
] }
const candidateStep = { ...marked, activeTurnId: 'old', followUp: true as const }
assert.deepEqual(freshnessCandidates(turn, ledger(candidateStep), activity), [{ kind: 'finished_delegation', id: 'plan:1', owner_task_ids: ['done-1', 'done-2'], external_owner: false }])
assert.deepEqual(freshnessCandidates(turn, ledger({ ...original, delegated: true }), activity), [{ kind: 'finished_delegation', id: 'plan:1', owner_task_ids: ['done-1', 'done-2'] }])
for (const step of [{ ...candidateStep, cleared: true as const }, { ...candidateStep, followUp: undefined }]) assert.deepEqual(freshnessCandidates(turn, ledger(step), activity), [])

const contract = toolContracts('', '', [], 300).mark_step
const ownerProperty = Reflect.get(contract.inputSchema.properties, 'external_owner')
assert.equal(ownerProperty.type, 'boolean')
assert.match(ownerProperty.description, /delegated:true/)
assert.match(ownerProperty.description, /(?:unknown|external)/i)
assert.match(contract.description, /external_owner/)
