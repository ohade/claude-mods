// FIXTURE: U3 preserves step/task commands using prepared row identities and values.
import assert from 'node:assert/strict'
import type { Ledger, Step } from '../../types'

type Result = { resultText: string; resultTextHash: string; resultAt: number; resultRequestId?: string; resultTurnId?: string }
export type StepCommands = {
  planInsertion: (ledger: Ledger, after: string, count: number) => { anchor?: string; ids: string[] }
  insertPlan: (ledger: Ledger, rows: Step[], anchor: string | undefined, session?: string) => Ledger
  replacePlan: (ledger: Ledger, rows: Step[], replace: boolean, session?: string) => { ledger: Ledger; unfinished: Array<Pick<Step, 'id' | 'status' | 'subject' | 'note'>> }
  markStep: (ledger: Ledger, values: { id: string; status: Step['status']; now: number; currentId: string | null; note?: string; delegated?: boolean; result?: Result }) => { ledger: Ledger; reusableStep?: Step }
}
export type TaskSyncCommands = {
  createTask: (ledger: Ledger, values: { taskId: string; subject: string; toolUseId?: string; session?: string }) => Ledger
  updateTask: (ledger: Ledger, values: { taskId: string; status: Step['status'] | 'deleted'; now: number; currentId: string | null }) => Ledger
  replaceTodos: (ledger: Ledger, values: { todos: Array<{ content: string; status: Step['status'] }>; now: number; currentId: string | null; session?: string }) => Ledger
}
const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, source: 'plan', sourceId: `identity:${id}`, subject: id, status: 'pending', ...extra })
const ledger = (steps: Step[] = []): Ledger => ({ v: 1, prompts: [], questions: [], nextQuestionId: 1, steps })
const fixed = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) fixed(child)
    Object.freeze(value)
  }
  return value
}

export const checkStepCommands = (commands: StepCommands, tasks: TaskSyncCommands): void => {
  const first = step('plan:1', { status: 'completed', cleared: true })
  const last = step('plan:8', { status: 'waiting', note: 'Need input' })
  const task = step('task:9', { source: 'task', taskId: '9' })
  const original = fixed(ledger([first, last, task]))
  const originalJson = JSON.stringify(original)
  assert.deepEqual(commands.planInsertion(original, 'last', 2), { anchor: 'plan:8', ids: ['plan:9', 'plan:10'] })
  assert.deepEqual(commands.planInsertion(original, 'plan:1', 1), { anchor: 'plan:1', ids: ['plan:9'] })
  const emptyPlan = commands.planInsertion(ledger([task]), 'last', 2)
  assert.equal(emptyPlan.anchor, undefined)
  assert.deepEqual(emptyPlan.ids, ['plan:1', 'plan:2'])
  const prepared = fixed([step('plan:9', { sourceId: 'prepared-uuid' })])
  const inserted = commands.insertPlan(original, prepared, 'plan:1', 'owner')
  assert.deepEqual(inserted, { ...original, session_id: 'owner', steps: [first, prepared[0], last, task] })
  assert.strictEqual(inserted.steps[1], prepared[0], 'native-prepared identity is used unchanged')
  assert.deepEqual(commands.insertPlan(original, prepared, 'vanished', 'owner').steps, [first, last, task, ...prepared], 'vanished anchor appends on current retry')
  assert.deepEqual(commands.insertPlan(original, prepared, undefined, 'owner').steps, [first, last, task, ...prepared])
  assert.equal(commands.insertPlan({ ...original, session_id: 'existing' }, prepared, undefined, 'other').session_id, 'existing')
  const refused = commands.replacePlan(original, prepared, false, 'owner')
  assert.strictEqual(refused.ledger, original, 'unfinished current work refuses without a write')
  assert.deepEqual(refused.unfinished, [{ id: 'plan:8', subject: 'plan:8', status: 'waiting', note: 'Need input' }])
  assert.deepEqual(commands.replacePlan(original, prepared, true, 'owner'), { ledger: { ...original, session_id: 'owner', steps: [task, ...prepared] }, unfinished: [] })
  assert.deepEqual(commands.replacePlan(ledger([first, task]), prepared, false).ledger.steps, [task, ...prepared])
  const unfinished = Array.from({ length: 300 }, (_, i) => step(`plan:${i + 1}`))
  assert.equal(commands.insertPlan(ledger(unfinished), [step('plan:301')], undefined).steps.length, 301, 'step cap never evicts unfinished work')
  const capped = commands.insertPlan(ledger([{ ...unfinished[0]!, status: 'completed' }, ...unfinished.slice(1)]), [step('plan:301')], undefined)
  assert.equal(capped.steps.length, 300)
  assert.equal(capped.steps.some(row => row.id === 'plan:1'), false)

  const active = fixed(step('plan:2', { status: 'paused', startedAt: 10, endedAt: 20, activeTurnId: 'old', note: 'interrupted', delegated: true, followUp: true }))
  const started = commands.markStep(fixed(ledger([active])), { id: active.id, status: 'in_progress', now: 500, currentId: 't2', delegated: false })
  assert.strictEqual(started.reusableStep, active, 'reuse returns the current pre-transition row')
  assert.deepEqual(started.ledger.steps, [step('plan:2', { status: 'in_progress', startedAt: 10, activeTurnId: 't2' })])
  const complete = fixed(step('plan:2', { status: 'completed', startedAt: 10, endedAt: 80, resultText: 'old', resultTextHash: 'old-hash', resultAt: 80, resultRequestId: 'old-call', resultTurnId: 'old-turn' }))
  assert.equal(commands.markStep(ledger([complete]), { id: complete.id, status: 'completed', now: 900, currentId: 't2' }).reusableStep, undefined)
  assert.equal(commands.markStep(ledger([{ ...active, cleared: true }]), { id: active.id, status: 'in_progress', now: 900, currentId: 't2' }).reusableStep, undefined)
  assert.equal(commands.markStep(ledger([]), { id: active.id, status: 'completed', now: 900, currentId: 't2' }).reusableStep, undefined, 'no old reuse eligibility leaks into a missing-row retry')
  assert.deepEqual(commands.markStep(ledger([complete]), { id: complete.id, status: 'completed', now: 900, currentId: 't2' }).ledger.steps, [complete], 'sourceless repeated completion keeps acknowledged result and end clock')
  const result: Result = { resultText: 'new', resultTextHash: 'full-new-hash', resultAt: 900, resultRequestId: 'new-call' }
  assert.deepEqual(commands.markStep(ledger([complete]), { id: complete.id, status: 'completed', now: 900, currentId: 't2', note: '', result }).ledger.steps, [step('plan:2', { status: 'completed', startedAt: 10, endedAt: 80, note: '', ...result })])
  const waiting = commands.markStep(ledger([active]), { id: active.id, status: 'waiting', now: 900, currentId: 't2', delegated: true }).ledger.steps[0]!
  assert.equal(waiting.delegated, undefined)
  assert.equal(waiting.resultText, undefined)
  assert.equal(waiting.followUp, undefined)

  const match = fixed(step('plan:3', { subject: '1. Fix the bug!', status: 'completed', cleared: true }))
  const secondMatch = step('plan:4', { subject: 'fix the bug' })
  const linked = tasks.createTask(fixed(ledger([match, secondMatch])), { taskId: '7', subject: 'fix the bug', toolUseId: 'create-call', session: 'owner' })
  assert.deepEqual(linked, { ...ledger(), steps: [{ ...match, taskId: '7' }, secondMatch] }, 'first unlinked normalized plan matches even when cleared/completed; link does not add session fields')
  assert.deepEqual(tasks.createTask(ledger(), { taskId: '7', subject: 'New task', toolUseId: 'create-call', session: 'owner' }), { ...ledger(), session_id: 'owner', steps: [{ id: 'task:7', source: 'task', subject: 'New task', status: 'pending', taskId: '7', createdRequestId: 'create-call' }] })
  const boundPlan = step('plan:7', { taskId: '7', status: 'in_progress', startedAt: 10 })
  const boundTask = step('task:7', { source: 'task', taskId: '7' })
  assert.deepEqual(tasks.updateTask(ledger([boundPlan, boundTask, task]), { taskId: '7', status: 'deleted', now: 600, currentId: 't2' }).steps, [step('plan:7', { status: 'in_progress', startedAt: 10 }), task])
  assert.deepEqual(tasks.updateTask(ledger([boundPlan]), { taskId: '7', status: 'completed', now: 600, currentId: 't2' }).steps, [{ ...boundPlan, status: 'completed', endedAt: 600 }])
  const todo = fixed({ id: 'todo:fix', source: 'todo' as const, subject: 'Fix!', status: 'in_progress' as const, startedAt: 25, activeTurnId: 'old', note: 'Keep me' })
  const duplicate = { ...todo, id: 'todo:fix#2', startedAt: 35 }
  const todos = tasks.replaceTodos(fixed(ledger([task, todo, duplicate])), { todos: [{ content: 'Fix!', status: 'in_progress' }, { content: 'fix', status: 'in_progress' }], now: 900, currentId: 't2', session: 'owner' })
  assert.deepEqual(todos, { ...ledger(), session_id: 'owner', steps: [task, { ...todo, activeTurnId: 't2' }, { ...duplicate, subject: 'fix', activeTurnId: 't2' }] }, 'current todo clocks and per-call duplicate numbering survive a retry')
  assert.deepEqual(tasks.replaceTodos(ledger([task, todo]), { todos: [], now: 900, currentId: null }).steps, [task])
  assert.equal(JSON.stringify(original), originalJson, 'commands never mutate frozen current inputs')
}
