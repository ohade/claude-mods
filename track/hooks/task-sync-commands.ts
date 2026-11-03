import type { Ledger, Step } from '../types'
import { capSteps, withStatus } from './ledger-policy'
import { headOf, norm } from './ledger-text'

export const createTask = (ledger: Ledger, values: { taskId: string; subject: string; toolUseId?: string; session?: string }): Ledger => {
  const { taskId, subject, toolUseId, session } = values
  const plan = ledger.steps.find(s => s.source === 'plan' && s.taskId === undefined && norm(s.subject) === norm(subject))
  if (plan !== undefined) return { ...ledger, steps: ledger.steps.map(s => (s.id === plan.id ? { ...s, taskId } : s)) }
  const step: Step = {
    id: `task:${taskId}`,
    source: 'task',
    subject,
    status: 'pending',
    taskId,
    ...(toolUseId !== undefined && { createdRequestId: toolUseId }),
  }
  return { ...ledger, session_id: ledger.session_id ?? session, steps: capSteps([...ledger.steps, step]) }
}

export const updateTask = (ledger: Ledger, values: { taskId: string; status: Step['status'] | 'deleted'; now: number; currentId: string | null }): Ledger => {
  const { taskId, status, now, currentId } = values
  return {
    ...ledger,
    steps: status === 'deleted'
      ? ledger.steps.filter(s => !(s.source === 'task' && s.taskId === taskId)).map(s => {
          if (s.taskId !== taskId) return s
          const { taskId: _unlinked, ...plan } = s
          return plan
        })
      : ledger.steps.map(s => (s.taskId === taskId ? withStatus(s, status, now, currentId) : s)),
  }
}

export const replaceTodos = (ledger: Ledger, values: { todos: Array<{ content: string; status: Step['status'] }>; now: number; currentId: string | null; session?: string }): Ledger => {
  const { todos, now, currentId, session } = values
  const before = new Map(ledger.steps.filter(s => s.source === 'todo').map(s => [s.id, s]))
  const seen = new Map<string, number>()
  const rows: Step[] = todos.map(t => {
    const base = `todo:${norm(t.content)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const id = n === 1 ? base : `${base}#${n}`
    const was = before.get(id)
    const row: Step = { ...(was ?? { id, source: 'todo' as const, status: 'pending' as const }), subject: headOf(t.content) }
    return withStatus(row, t.status, now, currentId)
  })
  return { ...ledger, session_id: ledger.session_id ?? session, steps: capSteps([...ledger.steps.filter(s => s.source !== 'todo'), ...rows]) }
}
