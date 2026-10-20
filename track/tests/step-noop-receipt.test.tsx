// FIXTURE: a repeated mark can acknowledge an already durable row, while an
// unchanged in-memory row alone cannot establish that the save succeeded.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'

const MARK = 'mcp__track__mark_step'
const prepare = (on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, steps: [
    { id: 'plan:1', source: 'plan', subject: 'Original work', status: 'pending' },
  ] })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const store = pluginStore(on)
  logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  return { ledger, store }
}
const pause = ($: Engine, call: string) => $.tool.call({
  tool: MARK, id: 'plan:1', status: 'paused', note: 'Waiting on a dependency', tool_use_id: call,
} as never)
const sourceRow = (output: unknown, call: string) => ({
  plugin: 'track', surface: 'terminal' as const, component: 'ToolUse' as const, requestId: `${call}-row`,
  props: { tool: MARK, tool_use_id: call, input: { id: 'plan:1', status: 'paused' }, output,
    isRunning: false, isErrored: false, isInterrupted: false },
})

test('UI-3 a repeated durable mark keeps a per-call acknowledged receipt without another write', async ($, on) => {
  const fixture = prepare(on)
  await pause($, 'first-call')
  const before = JSON.parse(JSON.stringify(fixture.ledger.value))
  fixture.store.faults.write = 'No further store writes allowed'
  const receipt = await pause($, 'repeat-call')
  expect(fixture.ledger.value).toEqual(before)
  expect(String(receipt.result)).toContain('Saved row: ')
  expect(String(receipt.result)).toContain('"markedBy":"repeat-call"')
  const source = await $.ui.mount(sourceRow(receipt.result, 'repeat-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).toContain('⏸')
  expect(text).toContain('Original work paused')
  expect(text).not.toContain('no saved update')
})

test('UI-3 repeating an unsaved mark cannot turn memory into an acknowledged receipt', async ($, on) => {
  const fixture = prepare(on)
  fixture.store.faults.write = 'disk unavailable'
  expect(String((await pause($, 'first-call')).result)).toContain('unsaved')
  const before = JSON.parse(JSON.stringify(fixture.ledger.value))
  const receipt = await pause($, 'repeat-call')
  expect(fixture.ledger.value).toEqual(before)
  expect(String(receipt.result)).toContain('unsaved')
  expect(String(receipt.result)).not.toContain('Saved row: ')
  const source = await $.ui.mount(sourceRow(receipt.result, 'repeat-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).not.toContain('⏸')
  expect(text).toContain('unsaved')
})
