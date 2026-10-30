// FIXTURE: shared domain-rule cases for original snapshot and component owner.
import assert from 'node:assert/strict'
import type { Step } from '../../types'
type OpenRow = Pick<Step, 'id' | 'status' | 'subject' | 'note'>
type StepRules = {
  visibleSteps: (steps: Step[]) => Step[]
  openStepsOf: (steps: Step[]) => OpenRow[]
  openPlanSteps: (steps: Step[]) => OpenRow[]
  sameResultOwner: (current: Step, saved: Step) => boolean
}
const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, subject: `Row ${id}`, source: 'plan', status: 'pending', ...extra })

export const checkStepInventory = ({ visibleSteps, openStepsOf, openPlanSteps, sameResultOwner }: StepRules): void => {
  const pending = step('p'), running = step('i', { status: 'in_progress', note: '', sourceId: 'logical-i' })
  const paused = step('a', { status: 'paused', note: 'peer work' }), waiting = step('w', { status: 'waiting', note: 'owner action' })
  const task = step('t', { source: 'task', taskId: 'worker' }), todo = step('todo', { source: 'todo' })
  const done = step('done', { status: 'completed' }), cleared = step('clear', { cleared: true })
  const input = [cleared, pending, done, running, paused, waiting, task, todo]
  const before = JSON.stringify(input)
  assert.deepEqual(visibleSteps(input), [pending, done, running, paused, waiting, task, todo], 'visible inventory excludes only cleared rows')
  const expected = [
    { id: 'p', status: 'pending', subject: 'Row p' },
    { id: 'i', status: 'in_progress', subject: 'Row i', note: '' },
    { id: 'a', status: 'paused', subject: 'Row a', note: 'peer work' },
    { id: 'w', status: 'waiting', subject: 'Row w', note: 'owner action' },
    { id: 't', status: 'pending', subject: 'Row t' },
    { id: 'todo', status: 'pending', subject: 'Row todo' },
  ]
  assert.deepEqual(openStepsOf(input), expected, 'open inventory keeps every unfinished status, source, note and original order')
  assert.deepEqual(openPlanSteps(input), expected.slice(0, 4), 'open plan inventory excludes task and todo rows')
  assert.equal(Object.hasOwn(openStepsOf(input)[0]!, 'note'), false, 'undefined note stays omitted')
  assert.equal(Object.hasOwn(openStepsOf(input)[1]!, 'note'), true, 'empty note stays present')
  assert.equal(JSON.stringify(input), before, 'projections leave input rows unchanged')
  assert.deepEqual(openStepsOf([]), [])
  assert.deepEqual(openPlanSteps([done, cleared]), [])
  const current = step('same', { sourceId: 'generation-1', taskId: 'worker' })
  assert.equal(sameResultOwner(current, { ...current }), true)
  const changes: Array<[string, Partial<Step>]> = [['id', { id: 'other' }], ['source', { source: 'task' }],
    ['sourceId', { sourceId: 'generation-2' }], ['subject', { subject: 'Other row' }], ['taskId', { taskId: 'other' }]]
  for (const [field, change] of changes) assert.equal(sameResultOwner(current, { ...current, ...change }), false, `result ownership must compare ${field}`)
  assert.equal(sameResultOwner(current, { ...current, status: 'completed', note: 'new note', resultText: 'new result', cleared: true }), true, 'state and content do not change logical owner')
  const legacy = step('legacy')
  assert.equal(sameResultOwner(legacy, { ...legacy }), true, 'matching legacy rows with absent sourceId remain compatible')
}
