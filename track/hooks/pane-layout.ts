import type { Question } from '../types'
import { visibleQuestions } from './pane-order'

// A stored position never runs past the last one that shows anything (observed: 733 for 20 steps).
export const clampTo = (last: number, value: number): number => Math.min(last, Math.max(0, value))

// The rows from `start` whose lines fit `rows`: [start, end).
export const windowOf = (lines: number[], rows: number, start: number): [number, number] => {
  let end = start
  let used = 0
  while (rows > 0 && end < lines.length && used + (lines[end] ?? 1) <= rows) {
    used += lines[end] ?? 1
    end++
  }

  return [start, rows > 0 && end === start && start < lines.length ? start + 1 : end]
}

// The first row from which the list's last rows fill `rows`.
export const lastStart = (lines: number[], rows: number): number => {
  let start = lines.length
  let used = 0
  while (start > 0 && used + (lines[start - 1] ?? 1) <= rows) {
    used += lines[start - 1] ?? 1
    start--
  }

  return Math.min(start, Math.max(0, lines.length - 1))
}

// Rows a header or bar takes when its items wrap at `width`: each item stays whole, `gap` apart.
export const flowRows = (items: number[], width: number, gap: number): number => {
  let rows = 1
  let used = 0
  for (const item of items.filter(w => w > 0)) {
    if (used > 0 && used + gap + item > width) {
      rows++
      used = item
    } else {
      used = used === 0 ? item : used + gap + item
    }
  }

  return rows
}

// The columns a button takes: the engine draws a hotkey button as "q: label".
export const buttonWidth = (hotkey: string, label: string): number => hotkey.length + 2 + label.length

// Whole minutes below an hour, <1m below a minute; retain the hour/minute form.
export const clockText = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)

  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : total < 60 ? '<1m' : `${minutes}m`
}

// Human labels follow the full uncleared list, not the scroll window. Stored and
// model-facing ids stay permanent; an old transcript row falls back to that id.
export const questionLabels = (questions: readonly Question[]): ((id: number | string) => string) => {
  const labels = new Map(visibleQuestions(questions).map((q, index) => [q.id, `Q${index + 1}`]))
  return id => labels.get(Number(id)) ?? `Q${id}`
}
