// FIXTURE: step appearance and source ownership; native interaction is checked separately.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { Activity, Ledger, Step } from '../../types'

const hook = (name: string) => new URL(`../../hooks/${name}`, import.meta.url)
for (const name of ['work-appearance.ts', 'pane-elements.ts', 'pane-step-view.tsx']) {
  assert.ok(existsSync(hook(name)), `missing step-view boundary: ${name}`)
}
const appearance = readFileSync(hook('work-appearance.ts'), 'utf8')
const elements = readFileSync(hook('pane-elements.ts'), 'utf8')
const view = readFileSync(hook('pane-step-view.tsx'), 'utf8')
const native = readFileSync(hook('register.tsx'), 'utf8')
for (const [name, source] of [['work-appearance', appearance], ['pane-elements', elements], ['pane-step-view', view]] as const) {
  assert.ok(source.trimEnd().split('\n').length <= 100, `${name} stays within 100 lines`)
  assert.doesNotMatch(source, /from ['"]\.\/register['"]/, `${name} cannot import register`)
}
assert.match(elements.trim(), /^import type \{ ElementTable \} from 'claude-code'\s+export type PaneElements = Pick<ElementTable, 'Box' \| 'Button' \| 'Text'>$/)
for (const source of [appearance, view]) {
  assert.doesNotMatch(source, /from ['"]claude-code['"]|\b(?:EngineInterface|Runtime|atom|memberOf|read|update)\b|\$(?!\{)/, 'pure modules cannot access native runtime')
}
for (const symbol of ['SPINNER', 'GREY_SHADES', 'AMBER_SHADES', 'WAITING_BLUE', 'isDelegatedWork', 'workState', 'stepLook']) {
  assert.match(appearance, new RegExp(`^export const ${symbol}\\b`, 'm'), `appearance owns ${symbol}`)
  assert.doesNotMatch(native, new RegExp(`^(?:const|function) ${symbol}\\b`, 'm'), `native imports ${symbol}`)
}
assert.doesNotMatch(native, /^type WorkState\b/m)
assert.match(appearance, /^export type WorkState\b/m)
assert.match(view, /^export const stepView\b/m)
assert.match(native, /from '\.\/work-appearance'/)
assert.match(native, /from '\.\/pane-step-view'/)
assert.match(native, /steps\.slice\(sStart, sEnd\)\.map\(\(s, shownAt\) => \{\s*const index = sStart \+ shownAt/)
assert.match(native, /onJumpResult:\s*(?:\(\w+\)|\w+)\s*=>\s*jump\(\$,\s*\[(\w+)\],\s*'start',\s*\1,\s*renderInstances\.get\(\1\)\)/, 'jump resolves instance on press')
assert.doesNotMatch(view, /renderInstances|\b(?:ledger|activity|stepResults|resultReveals)\b/, 'view cannot access native state')

// Import only after the missing-boundary assertion, to make structural red explicit.
const { SPINNER, GREY_SHADES, AMBER_SHADES, WAITING_BLUE, isDelegatedWork, workState, stepLook } = await import('../../hooks/work-appearance')
assert.deepEqual([...SPINNER], ['◐', '◓', '◑', '◒'])
assert.deepEqual([...GREY_SHADES], ['#5f6670', '#7a828c', '#979fa9', '#b4bcc6', '#979fa9', '#7a828c'])
assert.deepEqual([...AMBER_SHADES], ['#7a5410', '#9a6c16', '#bb861d', '#dba126', '#bb861d', '#9a6c16'])
assert.equal(WAITING_BLUE, '#1a73e8')
const step = (status: Step['status'], extra: Partial<Step> = {}): Step => ({ id: 's', source: 'plan', subject: 'Step', status, ...extra })
const activity: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [] }
const ledger = (steps: Step[] = []): Ledger => ({ v: 1, nextQuestionId: 1, prompts: [], questions: [], steps })
const delegated = step('in_progress', { delegated: true })
assert.equal(isDelegatedWork(delegated), true)
assert.equal(isDelegatedWork({ ...delegated, cleared: true }), false)
assert.equal(isDelegatedWork(step('waiting', { delegated: true })), false)
assert.equal(workState(ledger(), { ...activity, agentCalls: ['a'], isWorking: true }), 'agents')
assert.equal(workState(ledger([delegated]), { ...activity, isWorking: true }), 'agents')
assert.equal(workState(ledger([delegated, step('in_progress')]), { ...activity, isWorking: true }), 'working')
assert.equal(workState(ledger([delegated]), { ...activity, isWorking: true, askCalls: ['q'] }), 'agents')
assert.equal(workState(ledger(), { ...activity, isWorking: true, background: ['a'], tasks: ['t'] }), 'working')
assert.equal(workState(ledger(), { ...activity, background: ['a'], tasks: ['t'] }), 'agents')
assert.equal(workState(ledger(), { ...activity, tasks: ['t'] }), 'tasks')
assert.equal(workState(ledger([step('in_progress')]), activity), 'unknown')
assert.equal(workState(ledger([step('pending')]), activity), 'paused')
assert.equal(workState(ledger([step('in_progress', { cleared: true })]), activity), 'done')
assert.equal(workState(ledger([step('completed')]), activity), 'done')
for (const lifecycle of ['cancelled by you', 'refused']) {
  assert.deepEqual(stepLook(delegated, lifecycle, 'working', 0), { glyph: '⊘', glyphColor: 'subtle', textColor: 'subtle' })
}
for (let phase = 0; phase < 12; phase++) {
  assert.deepEqual(stepLook(delegated, undefined, 'working', phase), { glyph: '⧗', glyphColor: AMBER_SHADES[phase % 6], textColor: AMBER_SHADES[phase % 6] })
  assert.deepEqual(stepLook(step('in_progress'), undefined, 'working', phase), { glyph: SPINNER[phase % 4], glyphColor: GREY_SHADES[phase % 6], textColor: GREY_SHADES[phase % 6] })
}
assert.deepEqual(stepLook(step('waiting', { delegated: true }), undefined, 'working', 0), { glyph: '◆', glyphColor: WAITING_BLUE, textColor: undefined })
assert.deepEqual(stepLook(step('paused'), undefined, 'paused', 0), { glyph: '⏸', glyphColor: 'subtle', textColor: 'subtle' })
assert.deepEqual(stepLook(step('completed'), undefined, 'done', 0), { glyph: '●', glyphColor: 'success', textColor: 'success' })
assert.deepEqual(stepLook(step('pending'), undefined, 'paused', 0), { glyph: '○', glyphColor: undefined, textColor: undefined })
assert.deepEqual(stepLook(step('in_progress', { cleared: true, delegated: true }), undefined, 'agents', 0), { glyph: '◐', glyphColor: undefined, textColor: undefined })
console.log('pane-step-boundary: appearance and ownership invariants satisfied (FIXTURE)')
