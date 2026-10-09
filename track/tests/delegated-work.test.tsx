// FIXTURE: 2026-10-08 two external-agent shell launches showed Working and
// a grey spinner. Explicit delegated work must be brown without an AMQ parser.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'

const MAIN = { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: ['external-1', 'external-2'] }
const STEP = { id: 'plan:1', source: 'plan', subject: 'Consult peers', status: 'in_progress' }

test('an explicitly delegated step is brown with an hourglass and an agents banner', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'activity', MAIN)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ ...STEP, delegated: true }] })
  const ui = await $.ui.mount(pane('dock'))
  const texts = await ui.findAll({ type: 'Text' })
  const glyph = texts.find(text => text.text === '⧗')
  expect(glyph?.props.color).toBe('#7a5410')
  // The main turn runs too (isWorking), so it has its own grey row below the brown agents row.
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-'))
  expect(rows.map(row => row.key)).toEqual(['banner-agents', 'banner-working'])
  expect(String(rows[0]?.text ?? '')).toContain('Agents')
  expect(String(rows[0]?.text ?? '')).toContain('S1')
  expect(rows[0]?.props.backgroundColor).toBe('#7a5410')
  expect(String(rows[1]?.text ?? '')).not.toContain('S1')
})

test('delegated state participates in checkpoint validation and survives restoration', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{ ...STEP, delegated: true }] } as any)
  pluginStore(on)
  let session = SESSION
  on('session.id', () => ({ value: session }))
  const checkpoint = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: session } as never)).result))
  const first = await checkpoint()
  ledger.value.steps[0].delegated = false
  const second = await checkpoint()
  expect(first.checksum).not.toBe(second.checksum)
  ledger.value.steps[0].delegated = true
  const expected = await checkpoint()
  session = '11111111-2222-4333-8444-555555555555'
  ledger.value = { ...EMPTY }
  const result = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: SESSION, expected_checkpoint: expected, tool_use_id: 'toolu_restore' } as never)).result))
  expect(result.ok).toBe(true)
  expect(result.applied_checksum).toBe(expected.checksum)
  expect(ledger.value.steps[0].delegated).toBe(true)
})

test('invalid delegation metadata is refused without changing the ledger', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [STEP] })
  const before = JSON.stringify(ledger.value)
  const result = await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress', delegated: 'yes' } as never)
  expect(result.deny).toContain('delegated')
  expect(JSON.stringify(ledger.value)).toBe(before)
})

test('main work remains grey while unrelated shell tasks run', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'activity', MAIN)
  atomStore(on, 'ledger', { ...EMPTY, steps: [STEP] })
  const ui = await $.ui.mount(pane('dock'))
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.at(-1)?.text).toContain('Working')
  const at = texts.findIndex(text => text.text === 'S1. Consult peers')
  expect(texts[at - 1]?.text).toBe('◐')
  expect(texts[at - 1]?.props.color).toBe('#5f6670')
  expect(texts.filter(text => text.text === '⧗')).toHaveLength(1)
})

test('delegated ownership never invents an agent count from step counts', async ($, on) => {
  mock.clock(on)
  const activity = atomStore(on, 'activity', MAIN as any)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{ ...STEP, delegated: true }] } as any)
  const banner = async () => {
    const ui = await $.ui.mount(pane('dock'))
    const text = (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-')).map(el => String(el.text ?? '')).join(' ')
    await ui.unmount()
    return text
  }
  expect(await banner()).toContain('Agents')
  expect(await banner()).toContain('tasks 2')
  expect(await banner()).not.toContain('agents (')
  ledger.value.steps.push({ ...STEP, id: 'plan:2', delegated: false })
  expect(await banner()).toContain('Working')
  expect(await banner()).toContain('Agents')
  expect(await banner()).not.toContain('agents (1)')
  activity.value = { ...MAIN, isWorking: false, tasks: [], background: ['native-a', 'native-b'] }
  ledger.value.steps = [{ ...STEP, status: 'pending' }]
  expect(await banner()).toContain('Agents 2')
})

test('mark_step saves delegation and clears it when the main session resumes', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [STEP] } as any)
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress', delegated: true, note: 'Peer work is running' } as never)
  expect(ledger.value.steps[0].delegated).toBe(true)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.steps[0].delegated).toBe(true)
  await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress', delegated: false } as never)
  expect(ledger.value.steps[0].delegated).not.toBe(true)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.steps[0].delegated).not.toBe(true)
})
