import type { Step } from '../types'

// CC-181, 2026-10-10: reminder/restore totals counted cleared history, while
// the pane and checkpoint counted only these current rows. Keep one predicate.
export const visibleSteps = (steps: Step[]): Step[] => steps.filter(s => s.cleared !== true)
