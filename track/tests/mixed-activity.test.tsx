// FIXTURE: CC #149, reported 2026-10-08. A user wait must not hide concurrent work
// or stop its pulse. Delegated step ownership never supplies an agent count.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }
const WAIT = { id: 'plan:1', source: 'plan', subject: 'Need user decision', status: 'waiting' }
const WORK = { id: 'plan:2', source: 'plan', subject: 'Running work', status: 'in_progress' }

test('user waiting and delegated work both remain visible and pulse without a guessed count', async ($, on) => {
  const clock = mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [WAIT, { ...WORK, delegated: true }, { ...WORK, id: 'plan:3', delegated: true }] })
  atomStore(on, 'activity', IDLE)
  const phase = atomStore(on, 'pulse', 0)
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', 80))
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.at(-1)?.text?.trim()).toBe('Waiting on you · agents working')
  expect(texts.at(-1)?.text).not.toContain('agents (2)')
  expect((await ui.find({ key: 'banner' }))?.props.backgroundColor).toBe('#7a5410')
  expect(texts.filter(t => t.text === '⧗')).toHaveLength(2)
  await clock.advance(1300)
  expect(phase.writes.length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(ledger.value)).toBe(before)
})

test('user waiting preserves authoritative native agent and task activity with a running pulse', async ($, on) => {
  const clock = mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [WAIT] })
  atomStore(on, 'activity', { ...IDLE, background: ['native-a', 'native-b'], tasks: ['shell-a'] })
  const phase = atomStore(on, 'pulse', 0)
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', 100))
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.at(-1)?.text?.trim()).toBe('Waiting on you · agents (2) working · tasks (1) working')
  await clock.advance(1300)
  expect(phase.writes.length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(ledger.value)).toBe(before)
})

test('a user wait does not replace a working main step with a waiting diamond', async ($, on) => {
  const clock = mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [WAIT, WORK] })
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const phase = atomStore(on, 'pulse', 0)
  const ui = await $.ui.mount(pane('dock', 80))
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.at(-1)?.text?.trim()).toBe('Waiting on you · Working')
  const at = texts.findIndex(t => t.text === 'S2. Running work')
  expect(texts[at - 1]?.text).toBe('◐')
  expect(texts[at - 1]?.props.color).toBe('#5f6670')
  expect(texts.filter(t => t.text === '◆')).toHaveLength(1)
  await clock.advance(1300)
  expect(phase.writes.length).toBeGreaterThanOrEqual(2)
})

test('a narrow mixed banner keeps both user waiting and delegated work on one row', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [WAIT, { ...WORK, delegated: true }] })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 17, 30))
  const text = (await ui.findAll({ type: 'Text' })).at(-1)?.text ?? ''
  expect(text).toBe('You · agents work')
  expect(text.length).toBeLessThanOrEqual(17)
})

test('finishing delegated work stops the pulse while the user wait remains', async ($, on) => {
  const clock = mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [WAIT, { ...WORK, delegated: true }] })
  atomStore(on, 'activity', IDLE)
  const phase = atomStore(on, 'pulse', 0)
  const ui = await $.ui.mount(pane('dock', 80))
  await clock.advance(1300)
  expect(phase.writes.length).toBeGreaterThanOrEqual(2)
  ledger.value.steps[1]!.status = 'completed'
  await clock.advance(1300)
  const stopped = phase.writes.length
  await clock.advance(1300)
  expect(phase.writes.length).toBe(stopped)
  await ui.unmount()
  const finished = await $.ui.mount(pane('dock', 80))
  expect((await finished.findAll({ type: 'Text' })).at(-1)?.text?.trim()).toBe('Waiting on you')
})

test('waiting alone remains still and never claims agents or main work', async ($, on) => {
  const clock = mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [WAIT] })
  atomStore(on, 'activity', IDLE)
  const phase = atomStore(on, 'pulse', 0)
  let saves = 0
  on('store.set', () => { saves++; return { value: undefined } })
  const ui = await $.ui.mount(pane('dock', 80))
  expect((await ui.findAll({ type: 'Text' })).at(-1)?.text?.trim()).toBe('Waiting on you')
  await clock.advance(1300)
  expect(phase.writes).toHaveLength(0)
  expect(saves).toBe(0)
})
