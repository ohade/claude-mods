// SOURCE/FIXTURE: existing step owner, exact domain moves and native effects retained.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { checkStepInventory } from './step_inventory_cases'

const source = readFileSync(new URL('../../hooks/steps.ts', import.meta.url), 'utf8')
const native = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
assert.match(source, /^export const openStepsOf\b/m, 'step component must own open inventory')
assert.match(source, /^export const openPlanSteps\b/m, 'step component must own plan inventory')
assert.match(source, /^export const sameResultOwner\b/m, 'step component must own result identity')
assert.ok(source.trimEnd().split('\n').length <= 100)
assert.deepEqual(source.match(/^import .*$/gm), ["import type { Step } from '../types'"])
assert.doesNotMatch(source, /claude-code|EngineInterface|Runtime|\$\.|crypto\.|randomUUID|Date\.now|atom\(/)
// TRACK-46 slice 8 (2026-11-09, Ohad's standing approval): the Track tool handler bodies moved to
// track-tools.ts, a native adapter file; it is read here next to register.tsx.
const tools = readFileSync(new URL('../../hooks/track-tools.ts', import.meta.url), 'utf8')
// TRACK-46 slice 11 (2026-11-09, Ohad's standing approval): the pane and transcript UI handler bodies
// moved to ui-render.tsx, a native adapter file; the pane drawing is checked there.
const ui = readFileSync(new URL('../../hooks/ui-render.tsx', import.meta.url), 'utf8')
assert.ok(ui.includes("import { visibleSteps, sameResultOwner } from './steps'"))
assert.ok(tools.includes("import { visibleSteps, openStepsOf, openPlanSteps } from './steps'"))
for (const file of [native, tools, ui]) assert.doesNotMatch(file, /^(?:export )?const (?:openStepsOf|openPlanSteps|sameResultOwner)\b/m)
for (const file of [native, tools, ui]) assert.doesNotMatch(file, /^(?:export )?const openStepsContext\b/m, 'prompt guidance has only its new production owner')
const bodies = (name: string, text: string): Record<string, string> => {
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hashes: Record<string, string> = {}
  for (const s of tree.statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
    if (d.initializer && ts.isArrowFunction(d.initializer)) hashes[d.name.getText(tree)] = createHash('sha256').update(d.initializer.body.getText(tree)).digest('hex')
  }
  return hashes
}
const domain = bodies('steps.ts', source), adapter = bodies('track-tools.ts', tools)
const contextOwner = bodies('prompt-context.ts', readFileSync(new URL('../../hooks/prompt-context.ts', import.meta.url), 'utf8'))
assert.equal(domain.visibleSteps, '50851a99aecb28dbef515735e19e1d4dd56a94e9d0abac631aacb268856b4623')
assert.equal(domain.openStepsOf, '4785e97ecbfee9a8a91dc2facdd4b26f1d14521a2f5dc7af457ddee660498387')
assert.equal(domain.openPlanSteps, '248e610fb29d367fb190d09e4bee004fa1f2f0e4b0816ccb270fff1386c4cd95')
assert.equal(domain.sameResultOwner, '7aea44a764b9dbc82c17b6ca905cbe85be82401f690169c22a6afb496de5512b')
assert.equal(adapter.newPlanStep, '0a033508289fe1e9e4b8a9e01afaee0e491d3a77013def6b2f3c33509e83b308', 'native logical identity generation unchanged')
assert.equal(contextOwner.openStepsContext, '27f86a350a4c1e82a32bba9ebfaad546fa5bcb491153f5f6c33bb082836ee81d', 'prompt guidance body unchanged in its production owner')
assert.equal(adapter.refusePlanReplacement, '1e3b44aa3e01ba2eb4978eeaba315d32606531131c61325d256c9532231b924e', 'native refusal wording unchanged')
const rules = await import('../../hooks/steps')
checkStepInventory(rules)
console.log('step inventory ownership, exact bodies and domain cases pass (FIXTURE)')
