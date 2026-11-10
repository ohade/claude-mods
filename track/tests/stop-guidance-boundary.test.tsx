// FIXTURE: the pure Stop guidance function; no engine. The reason row must stay under 100 serialized bytes.
import { expect, test } from 'claude-code/testing'
import { minimalInputReason } from '../hooks/stop-guidance'
import type { PendingInput } from '../types'

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
const emptyInput: PendingInput = { id: 1, excerpt: '', head: '', textHash: 'fixture', turnId: null }
// A tool name that makes the whole serialized row exactly `total` bytes for an empty excerpt.
const toolFor = (total: number): string => {
  const base = bytes({ id: emptyInput.id, reason: 'track: "" needs .' })

  return 'x'.repeat(total - base)
}

test('a reason row of 99 bytes is accepted', () => {
  const tool = toolFor(99)
  const reason = minimalInputReason(emptyInput, tool)
  expect(reason).toBe(`track: "" needs ${tool}.`)
  expect(bytes({ id: emptyInput.id, reason })).toBe(99)
})

for (const total of [100, 101]) {
  test(`a reason row of ${total} bytes cannot be shortened, so it is refused`, () => {
    expect(bytes({ id: emptyInput.id, reason: `track: "" needs ${toolFor(total)}.` })).toBe(total)
    expect(() => minimalInputReason(emptyInput, toolFor(total))).toThrow('bounded Stop input reason exceeded')
  })
}

test('a long excerpt is cut until the row fits under 100 bytes', () => {
  const row: PendingInput = { ...emptyInput, excerpt: 'Why is the build slow on Monday mornings every single week?' }
  const reason = minimalInputReason(row, 'mcp__track__track_question')
  expect(bytes({ id: row.id, reason })).toBeLessThan(100)
  expect(reason.endsWith(' needs mcp__track__track_question.')).toBe(true)
})
