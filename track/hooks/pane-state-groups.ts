import type { Step } from '../types'

// Display order never changes the saved ledger or its S<n> numbering.
const GROUPS = [
  { status: 'in_progress', label: 'ACTIVE' },
  { status: 'waiting', label: 'WAITING ON YOU' },
  { status: 'pending', label: 'NEXT' },
  { status: 'paused', label: 'PAUSED' },
  { status: 'completed', label: 'DONE' },
] as const

export const groupedSteps = (steps: Step[]) => {
  const numbered = steps.map((step, index) => ({ step, number: index + 1 }))
  return GROUPS.flatMap(group => numbered.filter(row => row.step.status === group.status)
    .map((row, index) => ({ ...row, heading: index === 0 ? group.label : undefined })))
}

// Choose whole labels using the actual counts, rather than cutting off a count.
export const stepSummary = (steps: Step[], width: number): string => {
  const counts = ['in_progress', 'waiting', 'paused', 'pending'].map(status => steps.filter(step => step.status === status).length)
  const labels = [['active', 'waiting', 'paused', 'queued'], ['act', 'wait', 'pause', 'q']]
  const choices = labels.map(words => counts.map((count, index) => `${count} ${words[index]}`).join(' · '))
  const compact = counts.map((count, index) => `${['A', 'W', 'P', 'Q'][index]}${count}`)
  const full = choices.find(text => text.length <= width)
  if (full !== undefined) return full
  while (compact.length > 0 && compact.join(' ').length > width) compact.pop()
  return compact.join(' ')
}
