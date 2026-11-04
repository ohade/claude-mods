// FIXTURE: a new native task must bind to current work, never hidden or completed history.
import assert from 'node:assert/strict'
import { createTask } from '../../hooks/task-sync-commands'
import { visibleSteps } from '../../hooks/steps'
import type { Ledger, Step } from '../../types'

const session = '11111111-2222-4333-8444-555555555555'
const plan = (id: string, status: Step['status'], cleared = false): Step => ({ id, source: 'plan', subject: 'Write tests', status, ...(cleared && { cleared: true }) })
const ledger = (steps: Step[]): Ledger => ({ v: 1, session_id: session, nextQuestionId: 1, prompts: [], questions: [], steps })
const history = [plan('plan:1', 'completed', true), plan('plan:2', 'completed')]
const linked = createTask(ledger([...history, plan('plan:3', 'in_progress')]), { taskId: '7', subject: ' write TESTS ', session })
assert.equal(linked.steps.find(row => row.taskId === '7')?.id, 'plan:3', 'only an unlinked, visible, unfinished plan can receive a new task')
assert.equal(visibleSteps(linked.steps).some(row => row.taskId === '7'), true, 'the newly created task must be visible')
assert.deepEqual(linked.steps.slice(0, 2), history, 'completed history stays unchanged')

const created = createTask(ledger(history), { taskId: '8', subject: 'Write tests', session })
assert.equal(created.steps.at(-1)?.id, 'task:8', 'completed-only history requires a fresh task row')
assert.equal(created.steps.at(-1)?.status, 'pending', 'new work must not inherit completed status')
assert.equal(visibleSteps(created.steps).some(row => row.taskId === '8'), true)
console.log('task reconciliation: visible unfinished plans reused; completed history retained (FIXTURE)')
