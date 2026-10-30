// SOURCE: the active Phase1 tool-contract ownership gate, 2026-10-30.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const path = new URL('../../hooks/tool-contracts.ts', import.meta.url)
assert.ok(existsSync(path), 'missing pure tool-contract owner: tool-contracts.ts')
const catalog = readFileSync(path, 'utf8')
const native = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
assert.ok(catalog.trimEnd().split('\n').length <= 100, 'catalog stays one small cohesive component')
assert.ok(catalog.includes('export const toolContracts = (steps: string, stepResult: string, statuses: readonly string[], maxSteps: number) => ({'), 'catalog takes only its existing plain dependencies and returns fresh literal values')
assert.doesNotMatch(catalog, /\bimport\b|claude-code|EngineInterface|Runtime|\$\./, 'pure catalog has no native capabilities or reverse dependencies')
assert.ok(native.includes("import { toolContracts } from './tool-contracts'"), 'native consumes the contract owner')
assert.ok(native.includes('const catalog = toolContracts(STEPS, STEP_RESULT, STEP_STATUSES, MAX_STEPS)'), 'native supplies its existing rule values')
const names = ['track_question', 'mark_answered', 'track_steps', 'restore_tracker', 'checkpoint', 'lookup_rows', 'diagnose', 'reorder_steps', 'mark_step']
const calls = [...native.matchAll(/await \$\.tool\.register\(catalog\.(\w+)\)/g)].map(match => match[1])
assert.deepEqual(calls, names, 'native keeps nine explicit awaited calls in original order')
assert.equal((native.match(/await \$\.tool\.register\(/g) ?? []).length, 9, 'no duplicated or discarded registration')
assert.doesNotMatch(catalog, /isDeferred\s*:/, 'catalog preserves the original omitted defer flag')
console.log('check_tool_contracts: pure discovery ownership and explicit native registration')
