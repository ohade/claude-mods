// Static pin, plan16c fix A (2026-10-30): every ledger write goes through updateLedger,
// which ends the clear-all arm in the same call when no unfinished step is left.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// TRACK-46 slices 1-7 (2026-11-09, Ohad's standing approval): updateLedger and updateOwnedLedger moved
// to track-state.ts. The native files are scanned together with a per-file line prefix, so a count
// cannot merge or hide a declaration in either file.
const NATIVE = ['register.tsx', 'track-state.ts', 'writer-lock.ts', 'ledger-store.ts', 'session-owner.ts', 'turn-guidance.ts', 'prompt-flow.ts', 'pane-actions.tsx', 'track-tools.ts', 'task-mirror.ts']
// TRACK-46 slice 9 (2026-11-09, Ohad's standing approval): the host task mirror handlers moved to
// task-mirror.ts, a native adapter file; it is read here with the other native files.
// TRACK-46 slice 8 (2026-11-09, Ohad's standing approval): the Track tool handler bodies moved to
// track-tools.ts, a native adapter file; it is read here next to register.tsx.
const lines = NATIVE.flatMap(file => readFileSync(join(import.meta.dir, '../../hooks', file), 'utf8').split('\n').map(line => line))
const fileOf = (line: number): string => { let n = line; for (const file of NATIVE) { const len = readFileSync(join(import.meta.dir, '../../hooks', file), 'utf8').split('\n').length; if (n <= len) return file; n -= len } return '?' }
const RESET = "if (written.steps.filter(s => s.status !== 'completed').length === 0) await update($, clearArm, () => null)"

// Line numbers (1-based) of every match of `pattern` in lines [from, to).
const hits = (pattern: RegExp, from = 0, to = lines.length): number[] =>
  lines.slice(from, to).flatMap((line, i) => Array(line.match(pattern)?.length ?? 0).fill(from + i + 1))

// A top-level declaration's body: from its line through the line that ends it; empty when absent.
const body = (start: RegExp, end: (line: string) => boolean): [number, number] => {
  const from = lines.findIndex(line => start.test(line))
  if (from < 0) return [0, 0]
  const close = lines.findIndex((line, i) => i > from && end(line))
  return [from, close < 0 ? lines.length : close + 1]
}

const raw = /\bupdate(?:<\w+>)?\(\$, ledger,/g
const [helperFrom, helperTo] = body(/^export async function updateLedger\(/, line => line === '}')
assert.equal(fileOf(helperFrom + 1), 'track-state.ts', 'updateLedger is declared in track-state.ts')
assert.equal(hits(/^(export )?(async )?(function|const) updateLedger\b/g).length, 1, 'one updateLedger declaration')
const inside = (line: number) => line > helperFrom && line <= helperTo
const allRaw = hits(raw)
const outside = allRaw.filter(line => !inside(line))
assert.equal(outside.length, 0, `raw ledger writes outside updateLedger: ${outside.length} (expected 0) at lines ${outside.join(', ')}`)

const insideRaw = allRaw.filter(inside)
assert.ok(allRaw.length === 1 && insideRaw.length === 1, `raw ledger writes: ${allRaw.length} in all, ${insideRaw.length} inside updateLedger (expected 1 and 1)`)

const resets = lines.slice(helperFrom, helperTo).filter(line => line.trim() === RESET).length
assert.equal(resets, 1, `updateLedger reset lines: ${resets} (expected 1)`)

const calls = hits(/(?<!function )\bupdateLedger\(/g)
const voidCalls = hits(/\bvoid updateLedger\(/g)
assert.ok(calls.length === 24 && voidCalls.length === 1, `updateLedger call sites: ${calls.length}, void ones: ${voidCalls.length} (expected 24 and 1)`)

const ownedCalls = hits(/(?<!function )\bupdateOwnedLedger\(/g)
assert.equal(ownedCalls.length, 12, `updateOwnedLedger call sites: ${ownedCalls.length} (expected 12)`)
const [ownedFrom, ownedTo] = body(/^export function updateOwnedLedger\(/, line => line === '}')
assert.equal(fileOf(ownedFrom + 1), 'track-state.ts', 'updateOwnedLedger is declared in track-state.ts')
const ownedHelperCalls = hits(/\bupdateLedger\(\$, /g, ownedFrom, ownedTo).length
assert.equal(ownedHelperCalls, 1, `updateLedger calls in updateOwnedLedger's body: ${ownedHelperCalls} (expected 1)`)

console.log('PASS every ledger write goes through updateLedger, which ends the clear-all arm')
