// FIXTURE: approved TRACK-26 plan. Saved result text must follow its permanent
// step and acknowledged native source, never its current S display position.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step, Turn } from '../types'
import { checksumOf } from '../hooks/checkpoint'

const MARK = 'mcp__track__mark_step'
const RESULT = 'Verified the requested native result.'
const OLD = '11111111-2222-4333-8444-555555555555'
const step = (id = 'plan:1'): Step => ({ id, source: 'plan', subject: id === 'plan:1' ? 'First work' : 'Second work', status: 'pending' })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const complete = ($: Engine, id = 'plan:1', text = RESULT, call = 'result-call') => invoke($, MARK, { id, status: 'completed', result_text: text, tool_use_id: call })
const toolRow = (id = 'plan:1', text = RESULT, call = 'result-call', instance = 'result-instance') => ({ plugin: 'track', surface: 'terminal' as const, component: 'ToolUse' as const, requestId: instance, props: { tool_use_id: call, tool: MARK, input: { id, status: 'completed', result_text: text }, isRunning: false, isErrored: false, isInterrupted: false } })
const prepare = (on: On, steps = [step(), step('plan:2')], seed: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const turn = atomStore<Turn>(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on, seed)
  const lines = logs(on)
  const contexts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_, e) => { contexts.push(...(e.context ?? [])); return { text: e.text } })
  return { clock, ledger, turn, store, lines, contexts }
}

test('TRACK-26 completed result is saved and drawn once at its acknowledged ToolUse', async ($, on) => {
  const f = prepare(on)
  await complete($)
  const row = f.ledger.value.steps[0] as any
  expect(row.resultText).toBe(RESULT)
  expect(row.resultTextHash).toBe(await checksumOf(RESULT))
  expect(row.resultRequestId).toBe('result-call')
  expect(row.resultTurnId).toBe('turn-1')
  expect(typeof row.resultAt).toBe('number')
  expect((f.store.held.get(`s:${SESSION}`) as { ledger: Ledger }).ledger.steps[0]).toEqual(row)
  const source = await $.ui.mount(toolRow())
  expect((await source.findAll({ type: 'Text' })).filter(text => text.text === RESULT)).toHaveLength(1)
})

test('TRACK-26 full source result stays visible while saved text is bounded at 1000 characters', async ($, on) => {
  const f = prepare(on)
  const full = `${'x'.repeat(1000)} distinct full-text ending`
  await complete($, 'plan:1', full)
  expect((f.ledger.value.steps[0] as any).resultText).toBe(full.slice(0, 1000))
  expect((f.ledger.value.steps[0] as any).resultTextHash).toBe(await checksumOf(full))
  const source = await $.ui.mount(toolRow('plan:1', full))
  expect((await source.findAll({ type: 'Text' })).some(text => text.text === full)).toBe(true)
})

test('TRACK-26 R follows the stable step id after an insertion moves its display position', async ($, on) => {
  const f = prepare(on)
  await complete($, 'plan:2', RESULT, 'second-result')
  await $.ui.mount(toolRow('plan:2', RESULT, 'second-result', 'second-instance'))
  await invoke($, 'mcp__track__track_steps', { steps: ['Inserted before second'], after: 'plan:1' })
  const ui = await $.ui.mount(pane('dock', 80, 30))
  expect(await ui.find({ key: 'r-plan:2' })).toBeDefined()
  await ui.press({ key: 'r-plan:2' })
  expect(f.lines.filter(line => line.startsWith('track: jump'))).toEqual(['track: jump {"to":{"requestId":"second-instance"},"block":"start"}'])
})

test('TRACK-26 an undrawn result refuses the jump instead of guessing its tool id', async ($, on) => {
  const f = prepare(on)
  await complete($)
  const ui = await $.ui.mount(pane('dock', 80, 30))
  expect(await ui.find({ key: 'r-plan:1' })).toBeDefined()
  await ui.press({ key: 'r-plan:1' })
  expect(f.lines).toContain('track: cannot jump — the source row has not been drawn on this load')
  expect(f.lines.some(line => line.startsWith('track: jump'))).toBe(false)
})

test('TRACK-26 a refused save never draws an accepted result from the proposed input', async ($, on) => {
  const f = prepare(on)
  f.store.faults.write = 'disk unavailable'
  const marked = await complete($)
  expect(String(marked.result)).toContain('unsaved')
  const source = await $.ui.mount(toolRow())
  expect((await source.findAll({ type: 'Text' })).some(text => text.text === RESULT)).toBe(false)
})

test('TRACK-26 a turnless replacement cannot inherit the previous result turn', async ($, on) => {
  const f = prepare(on)
  await complete($)
  expect((f.ledger.value.steps[0] as any).resultTurnId).toBe('turn-1')
  f.turn.value = { ...f.turn.value, currentId: null }
  f.turn.version += 1
  await complete($, 'plan:1', 'A later verified result.', 'later-result')
  const saved = (f.store.held.get(`s:${SESSION}`) as { ledger: Ledger }).ledger.steps[0]
  expect(saved?.resultText).toBe('A later verified result.')
  expect(saved?.resultRequestId).toBe('later-result')
  expect(saved?.resultTurnId).toBeUndefined()
})

test('TRACK-26 a failed replacement cannot draw unacknowledged words', async ($, on) => {
  const f = prepare(on)
  await complete($)
  await $.ui.mount(toolRow())
  f.store.faults.write = 'disk unavailable'
  const proposed = 'Unsaved replacement.'
  expect(String((await complete($, 'plan:1', proposed, 'replacement-call')).result)).toContain('unsaved')
  const source = await $.ui.mount(toolRow('plan:1', proposed, 'replacement-call', 'replacement-instance'))
  expect((await source.findAll({ type: 'Text' })).some(text => text.text === proposed)).toBe(false)
})

test('TRACK-26 R retains the acknowledged source after a failed replacement', async ($, on) => {
  const f = prepare(on)
  await complete($)
  const source = await $.ui.mount(toolRow())
  f.store.faults.write = 'disk unavailable'
  expect(String((await complete($, 'plan:1', 'Unsaved replacement.', 'replacement-call')).result)).toContain('unsaved')
  expect((await source.findAll({ type: 'Text' })).some(text => text.text === RESULT)).toBe(true)
  const ui = await $.ui.mount(pane('dock', 80, 30))
  await ui.press({ key: 'r-plan:1' })
  expect(f.lines.filter(line => line.startsWith('track: jump'))).toEqual(['track: jump {"to":{"requestId":"result-instance"},"block":"start"}'])
})

test('TRACK-26 a new plan reusing an id cannot borrow the old acknowledged R', async ($, on) => {
  const f = prepare(on)
  await complete($)
  await $.ui.mount(toolRow())
  f.store.faults.write = 'disk unavailable'
  await invoke($, 'mcp__track__track_steps', { steps: ['Brand new work'], tool_use_id: 'new-plan-call' })
  await invoke($, MARK, { id: 'plan:1', status: 'completed' })
  const ui = await $.ui.mount(pane('dock', 80, 30))
  expect(await ui.find({ key: 'r-plan:1' })).toBeUndefined()
})

test('TRACK-26 an old result source cannot adopt a new plan title after a failed save', async ($, on) => {
  const f = prepare(on)
  await complete($)
  const source = await $.ui.mount(toolRow())
  f.store.faults.write = 'disk unavailable'
  await invoke($, 'mcp__track__track_steps', { steps: ['Brand new work'], tool_use_id: 'new-plan-call' })
  await invoke($, MARK, { id: 'plan:1', status: 'completed' })
  const text = (await source.findAll({ type: 'Text' })).map(row => row.text ?? '').join('\n')
  expect(text).toContain('First work')
  expect(text).not.toContain('Brand new work')
  expect(text).toContain(RESULT)
})

test('TRACK-26 identical plan titles still cannot retarget an old accepted result', async ($, on) => {
  const f = prepare(on)
  await invoke($, 'mcp__track__track_steps', { steps: ['First work'], tool_use_id: 'original-plan-call' })
  await complete($)
  await $.ui.mount(toolRow())
  f.store.faults.write = 'disk unavailable'
  await invoke($, 'mcp__track__track_steps', { steps: ['First work'], tool_use_id: 'new-plan-call' })
  await complete($, 'plan:1', 'New work not yet saved.', 'new-work-call')
  const ui = await $.ui.mount(pane('dock', 80, 30))
  expect(await ui.find({ key: 'r-plan:1' })).toBeUndefined()
  f.store.faults.write = ''
  await complete($, 'plan:1', 'New work verified.', 'new-work-saved-call')
  await $.ui.mount(toolRow('plan:1', 'New work verified.', 'new-work-saved-call', 'new-work-instance'))
  await ui.press({ key: 'r-plan:1' })
  expect(f.lines.filter(line => line.startsWith('track: jump'))).toEqual(['track: jump {"to":{"requestId":"new-work-instance"},"block":"start"}'])
})

test('TRACK-26 a new plan cannot reveal a restored result under a reused id', async ($, on) => {
  const saved = { ...step(), status: 'completed', resultText: RESULT, resultTextHash: await checksumOf(RESULT), resultRequestId: 'old-call', resultAt: 10 }
  const f = prepare(on, [], { [`s:${OLD}`]: { v: 1, savedAt: 10, ledger: { ...EMPTY, steps: [saved] } } })
  await invoke($, 'mcp__track__restore_tracker', { from_session: OLD, tool_use_id: 'restore-call' })
  const ui = await $.ui.mount(pane('dock', 80, 30))
  await ui.press({ key: 'r-plan:1' })
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text === RESULT)).toBe(true)
  f.store.faults.write = 'disk unavailable'
  await invoke($, 'mcp__track__track_steps', { steps: ['Brand new work'], tool_use_id: 'new-plan-call' })
  await invoke($, MARK, { id: 'plan:1', status: 'completed' })
  expect(await ui.find({ key: 'r-plan:1' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text === RESULT)).toBe(false)
})

for (const width of [24, 39, 41, 80]) {
  test(`TRACK-26 acknowledged R remains usable at ${width} columns`, async ($, on) => {
    const f = prepare(on)
    await complete($)
    await $.ui.mount(toolRow())
    const ui = await $.ui.mount(pane('dock', width, 30))
    expect(await ui.find({ key: 'r-plan:1' })).toBeDefined()
    await ui.press({ key: 'r-plan:1' })
    expect(f.lines.filter(line => line.startsWith('track: jump'))).toEqual(['track: jump {"to":{"requestId":"result-instance"},"block":"start"}'])
  })
}

test('TRACK-26 restored R reveals saved text and drops the old native jump target', async ($, on) => {
  const saved = { ...step(), status: 'completed', resultText: RESULT, resultTextHash: await checksumOf(RESULT), resultRequestId: 'old-result-call', resultTurnId: 'old-turn', resultAt: 10 }
  const f = prepare(on, [], { [`s:${OLD}`]: { v: 1, savedAt: 10, ledger: { ...EMPTY, steps: [saved] } } })
  await invoke($, 'mcp__track__restore_tracker', { from_session: OLD, tool_use_id: 'restore-call' })
  const row = f.ledger.value.steps[0] as any
  expect(row.resultText).toBe(RESULT)
  expect(row.resultRequestId).toBeUndefined()
  expect(row.resultTurnId).toBeUndefined()
  const ui = await $.ui.mount(pane('dock', 80, 30))
  expect(await ui.find({ key: 'r-plan:1' })).toBeDefined()
  await ui.press({ key: 'r-plan:1' })
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text === RESULT)).toBe(true)
  expect(f.lines.some(line => line.startsWith('track: jump'))).toBe(false)
})

test('TRACK-26 a rewind removes a vanished result source without completing different work', async ($, on) => {
  on('session.messages', () => ({ value: [] }))
  const f = prepare(on)
  await f.clock.advance(1)
  await complete($)
  expect((f.ledger.value.steps[0] as any).resultText).toBe(RESULT)
  await $.prompt.submit({ text: 'Continue after rewind', origin: { kind: 'composer' } } as never)
  expect(f.ledger.value.steps[0]?.status).toBe('completed')
  expect((f.ledger.value.steps[0] as any).resultText).toBeUndefined()
  expect((f.ledger.value.steps[0] as any).resultRequestId).toBeUndefined()
})

for (const input of [{ status: 'completed', result_text: ' \n ' }, { status: 'paused', result_text: RESULT }, { status: 'waiting', result_text: RESULT }]) {
  test(`TRACK-26 blank or non-completed result is denied: ${input.status}`, async ($, on) => {
    const f = prepare(on)
    const before = JSON.stringify(f.ledger.value)
    expect((await invoke($, MARK, { id: 'plan:1', ...input })).deny).toBeDefined()
    expect(JSON.stringify(f.ledger.value)).toBe(before)
  })
}

test('TRACK-26 reopening a completed step clears all result metadata', async ($, on) => {
  const f = prepare(on)
  await complete($)
  expect((f.ledger.value.steps[0] as any).resultText).toBe(RESULT)
  await invoke($, MARK, { id: 'plan:1', status: 'in_progress' })
  for (const key of ['resultText', 'resultTextHash', 'resultRequestId', 'resultAt', 'resultTurnId']) expect((f.ledger.value.steps[0] as any)[key]).toBeUndefined()
})

test('TRACK-26 missing completion result nudges once without blocking Stop', async ($, on) => {
  const f = prepare(on)
  await invoke($, MARK, { id: 'plan:1', status: 'completed' })
  expect((await $.classic.Stop({ session_id: SESSION, background_tasks: [], stop_hook_active: false } as never)).block).toBeUndefined()
  expect(f.lines.filter(line => line.includes('missing completion result'))).toHaveLength(1)
  await $.classic.Stop({ session_id: SESSION, background_tasks: [], stop_hook_active: false } as never)
  expect(f.lines.filter(line => line.includes('missing completion result'))).toHaveLength(1)
  await $.prompt.submit({ text: 'Continue', origin: { kind: 'composer' } } as never)
  expect(f.contexts.filter(line => line.includes('missing completion result'))).toHaveLength(1)
  f.contexts.length = 0
  await $.prompt.submit({ text: 'Continue again', origin: { kind: 'composer' } } as never)
  expect(f.contexts.filter(line => line.includes('missing completion result'))).toHaveLength(0)
})

test('TRACK-26 an old completed row remains readable without a fabricated result', async ($, on) => {
  const f = prepare(on, [{ ...step(), status: 'completed' }])
  const ui = await $.ui.mount(pane('dock', 80, 30))
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text?.includes('First work'))).toBe(true)
  expect((f.ledger.value.steps[0] as any).resultText).toBeUndefined()
})

test('TRACK-26 only a later result replaces saved words and advances the checkpoint', async ($, on) => {
  const f = prepare(on)
  await complete($)
  const before = JSON.parse(String((await invoke($, 'mcp__track__checkpoint', { expected_session: SESSION })).result))
  expect(before.ok).toBe(true)
  await invoke($, MARK, { id: 'plan:1', status: 'completed', tool_use_id: 'legacy-repeat' })
  expect((f.ledger.value.steps[0] as any).resultText).toBe(RESULT)
  await complete($, 'plan:1', 'A later verified result.', 'later-result')
  const after = JSON.parse(String((await invoke($, 'mcp__track__checkpoint', { expected_session: SESSION })).result))
  expect(after.ok).toBe(true)
  expect((f.ledger.value.steps[0] as any).resultRequestId).toBe('later-result')
  expect(after.checksum).not.toBe(before.checksum)
  expect(after.revision).toBeGreaterThan(before.revision)
})

test('TRACK-26 a different proposed result cannot borrow an acknowledged source', async ($, on) => {
  prepare(on)
  await complete($)
  const source = await $.ui.mount(toolRow('plan:1', 'Different unacknowledged words.'))
  expect((await source.findAll({ type: 'Text' })).some(text => text.text === 'Different unacknowledged words.')).toBe(false)
})

for (const boundary of ['compacted', 'capped']) {
  test(`TRACK-26 a ${boundary} transcript cannot erase result provenance`, async ($, on) => {
    on('session.messages', () => ({ value: boundary === 'capped' ? Array.from({ length: 4096 }, () => ({ role: 'assistant', text: '', toolUses: [] })) : [] } as never))
    const f = prepare(on)
    await f.clock.advance(1)
    await complete($)
    expect((f.ledger.value.steps[0] as any).resultText).toBe(RESULT)
    if (boundary === 'compacted') {
      f.ledger.value = { ...f.ledger.value, compactedAt: 2 }
      f.ledger.version += 1
    }
    await $.prompt.submit({ text: 'Continue with retained history', origin: { kind: 'composer' } } as never)
    expect((f.ledger.value.steps[0] as any).resultText).toBe(RESULT)
    expect((f.ledger.value.steps[0] as any).resultRequestId).toBe('result-call')
  })
}
