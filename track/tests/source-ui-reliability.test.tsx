// FIXTURE release gates: verified sources, reachable fallback, durable explicit UI actions.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'

const prepare = (on: any, prompts: any[] = [], options: Parameters<typeof pluginStore>[3] = {}) => {
  const l = atomStore(on, 'ledger', { ...EMPTY, prompts })
  atomStore(on, 'turn', { currentId: 'current', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, {}, undefined, options)
  on('session.id', () => ({ value: SESSION }))
  return { l, store }
}
const prompt = (id: string, turnId = 'current', head = 'Please explain this') => ({ rowKey: id, requestId: id, turnId, head, at: 1 })

test('exact unique source text links the current-turn prompt', async ($, on) => {
  const { l } = prepare(on, [prompt('source')])
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Explain', source_text: 'Please explain this', tool_use_id: 'tracking-call' } as never)
  expect((l.value as any).questions[0].askedRequestId).toBe('source')
})

for (const [name, prompts, text] of [
  ['mismatch', [prompt('source')], 'Something else'],
  ['ambiguous', [prompt('first'), prompt('second')], 'Please explain this'],
  ['older turn', [prompt('old', 'previous')], 'Please explain this'],
] as const) {
  test(`source text ${name} falls back to the tracking call`, async ($, on) => {
    const { l } = prepare(on, [...prompts])
    await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Explain', source_text: text, tool_use_id: 'tracking-call' } as never)
    expect((l.value as any).questions[0].askedRequestId).toBe('tracking-call')
    expect((l.value as any).questions[0].rowKey).toBeUndefined()
  })
}

test('unknown-source tracking call renders a visible jump destination', async ($, on) => {
  prepare(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Question from later content', tool_use_id: 'tracking-call' } as never)
  const ui = await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'ToolUse', requestId: 'tracking-call', props: { tool_use_id: 'tracking-call', tool: 'mcp__track__track_question', input: { summary: 'Question from later content' }, isRunning: false, isErrored: false, isInterrupted: false } } as never)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Q1 Question from later content')
})

test('explicit clearing saves immediately and refreshes the Stop snapshot without rendering writes', async ($, on) => {
  const { l, store } = prepare(on)
  const snapshots: string[] = []
  on('env.set', (_, e) => { if (e.name === 'TRACK_GATE_SNAPSHOT') snapshots.push(String(e.value)); return { value: undefined } })
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Clear me', tool_use_id: 'q1' } as never)
  const ui = await $.ui.mount(pane('dock'))
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions).toHaveLength(1)
  await ui.press({ key: 'clear-questions' })
  expect(l.value.questions).toHaveLength(0)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions).toHaveLength(0)
  expect(JSON.parse(snapshots.at(-1) ?? '{}').open).toEqual([])
})

test('restore refuses an oversized unfinished source instead of slicing off work', async ($, on) => {
  const { l, store } = prepare(on)
  const old = '11111111-2222-4333-8444-555555555555'
  const questions = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, head: `Open ${i}`, at: 1, turnId: 'old', status: 'open' }))
  store.held.set(`s:${old}`, { v: 1, ledger: { ...EMPTY, questions } })
  const result = await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: old, tool_use_id: 'restore' } as never)
  expect(result.deny).toContain('capacity')
  expect(l.value.questions).toHaveLength(0)
  expect((store.held.get(`s:${old}`) as any).ledger.questions).toHaveLength(201)
})

test('explicit reopening cannot write preferences without session ownership', async ($, on) => {
  const { store } = prepare(on, [], { leaseFailure: 'another loaded Track instance owns this session' })
  store.held.set('closedByPerson', true)
  const durable = atomStore(on, 'durability', { isUnsaved: false, reason: '' })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: true })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'track', args: '' })
  expect(store.held.get('closedByPerson')).toBe(true)
  expect(durable.value.isUnsaved).toBe(true)
  expect(durable.value.reason).toContain('another loaded Track instance')
})

test('a refused explicit preference save is visible and retried by the next acknowledged mutation', async ($, on) => {
  const { store } = prepare(on)
  store.held.set('closedByPerson', true)
  store.faults.write = 'preference storage unavailable'
  const durable = atomStore(on, 'durability', { isUnsaved: false, reason: '' })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: true })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let failure: unknown
  try { await $.command.run({ command: 'track', args: '' }) }
  catch (error) { failure = error }
  expect(failure).toBeUndefined()
  expect(durable.value.isUnsaved).toBe(true)
  expect(durable.value.reason).toContain('preference storage unavailable')
  store.faults.write = ''
  await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['Retry pending UI save'] } as never)
  expect(store.held.get('closedByPerson')).toBe(false)
  expect(durable.value.isUnsaved).toBe(false)
})

// FIXTURE: a refused preference survives reload in the atom. A stale store
// value must not reverse the person's latest choice during the next redraw.
for (const pending of [true, false]) {
  test(`auto-open uses the pending closed-by-person preference ${pending}`, async ($, on) => {
    const clock = mock.clock(on)
    const { store } = prepare(on)
    store.held.set('closedByPerson', !pending)
    atomStore(on, 'durability', { isUnsaved: true, reason: 'preference save refused', closedByPerson: pending })
    atomStore(on, 'pane', { isOpen: false, hidden: false })
    const opens: unknown[] = []
    on('ui.open', (_, e) => { opens.push(e); return { value: { isPlaced: true } } })
    on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: ['hint'] }))
    await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'PromptHint', requestId: 'hint', viewport: { columns: 160, rows: 40, isFullscreen: true }, props: { isDraft: true, isWorking: false, hint: '' } } as never)
    await clock.advance(500)
    expect(opens).toHaveLength(pending ? 0 : 1)
  })
}

for (const laterPreference of [true, false]) {
  test(`a save keeps a later rewind gate with preference ${laterPreference}`, async ($, on) => {
    let durable!: { value: { isUnsaved: boolean; reason: string; closedByPerson?: boolean; rewindSession?: string }; version: number }
    // The preference was captured before this durable bucket read. A later UI
    // choice and rewind arrive before the earlier save acknowledges its values.
    const { store } = prepare(on, [], { beforeGet: key => {
      if (key === `s:${SESSION}`) {
        durable.value = { isUnsaved: true, reason: 'later rewind and close pending', closedByPerson: laterPreference, rewindSession: SESSION }
        durable.version++
      }
    } })
    durable = atomStore(on, 'durability', { isUnsaved: true, reason: 'pane preference save pending', closedByPerson: false })
    await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['Save preceding UI choice'] } as never)
    expect(store.held.get('closedByPerson')).toBe(false)
    expect(durable.value.closedByPerson).toBe(laterPreference)
    expect(durable.value.isUnsaved).toBe(true)
    expect(durable.value.rewindSession).toBe(SESSION)
  })
}
