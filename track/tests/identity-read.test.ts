// [I4b] GREEN control (ruling Q65): the validator register.tsx applies to its static BUILD_IDENTITY import.
// RED-exempt: before the product commit its only red is the missing module; its mutant (accept invalid
// metadata, or report the placeholder as loaded) proves it at GREEN. No disk value is ever an input.
import { expect, test } from 'claude-code/testing'
import { identityOf } from '../hooks/identity-read'

const VALID = { v: 1, source_fingerprint: 'a'.repeat(64), source_base: 'b'.repeat(40), generated_at: '2026-10-27T00:00:00Z' }

test('[I4b] a valid v1 module reports its source_fingerprint as loaded', () => {
  expect(identityOf(VALID)).toEqual({ loaded: 'a'.repeat(64) })
})

for (const [name, value] of [
  ['the placeholder', { ...VALID, source_fingerprint: 'unknown' }],
  ['a wrong v', { ...VALID, v: 2 }],
  ['a fingerprint of the wrong type', { ...VALID, source_fingerprint: 7 }],
  ['a fingerprint that is not 64 lowercase hex', { ...VALID, source_fingerprint: 'A'.repeat(64) }],
  ['a source_base of the wrong type', { ...VALID, source_base: null }],
  ['a generated_at of the wrong type', { ...VALID, generated_at: 0 }],
  ['no object at all', undefined],
] as const) {
  test(`[I4b] ${name} reports loaded 'unknown' with a reason, never a fallback value`, () => {
    const read = identityOf(value) as { loaded: string; reason?: unknown }
    expect(read.loaded).toBe('unknown')
    expect(typeof read.reason).toBe('string')
    expect(String(read.reason).length).toBeGreaterThan(0)
    expect(Object.keys(read).sort()).toEqual(['loaded', 'reason'])
  })
}
