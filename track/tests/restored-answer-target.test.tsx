// FIXTURE: legacy InfoNotice rendering remembers its host and shades each
// restored subrow. A requestId reveals the whole host; native placement of a
// later Q/A within that host remains unverified by these fixtures.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'

const FROM = '11111111-2222-4333-8444-555555555555'
const BY = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const QUESTIONS = [1, 2].map(id => ({ id, head: `Question ${id}`, at: 1, turnId: 'restored', status: 'answered', answerText: `Answer ${id} 😀`, restoredFrom: FROM, restoredBy: BY, sourceId: `${FROM}:Q${id}` }))
const NOTICE = {
  plugin: 'track', surface: 'terminal', component: 'InfoNotice', requestId: 'engine-notice-instance',
  props: { text: `Track source snapshot from session ${FROM}: 0 steps, 2 questions\nRestore status is confirmed by the tool receipt.\nQ1 answered: Question 1\nAnswer 1 😀\nQ2 answered: Question 2\nAnswer 2 😀`, command: null },
}

test('restored A reveals the observed notice host and shades only its answer', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 3, questions: QUESTIONS, restores: [{ by: BY, from: FROM, steps: 0, questions: QUESTIONS }] })
  const flashes = new Map<string, number>()
  on('state.get', { plugin: 'track', key: 'flash' }, (_, e) => ({ value: { value: flashes.get(String(e.id)) ?? 0, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'flash' }, (_, e) => { flashes.set(String(e.id), Number(e.value)); return { value: { isSet: true as const, version: 2 } } })
  const logs: string[] = []
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.render', { component: 'InfoNotice' }, () => ({ type: 'Text', props: {}, children: ['default notice'] }))
  const before = await $.ui.mount(NOTICE as never)
  expect((await before.find({ key: `restored-a:${BY}:2` }))?.text).toBe('Answer 2 😀')
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-2' })
  expect(logs.filter(line => line.startsWith('track: jump'))).toEqual(['track: jump {"to":{"requestId":"engine-notice-instance"},"block":"start"}'])
  await before.unmount()
  const after = await $.ui.mount(NOTICE as never)
  expect((await after.find({ key: `restored-a:${BY}:2` }))?.props.backgroundColor).toBeDefined()
  expect((await after.find({ key: `restored-a:${BY}:1` }))?.props.backgroundColor).toBeUndefined()
  expect((await after.find({ key: `restored-q:${BY}:2` }))?.props.backgroundColor).toBeUndefined()
})

test('restored Q reveals its observed host rather than guessing from the notice UUID', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: QUESTIONS, restores: [{ by: BY, from: FROM, steps: 0, questions: QUESTIONS }] })
  const logs: string[] = []
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.render', { component: 'InfoNotice' }, () => ({ type: 'Text', props: {}, children: ['default notice'] }))
  await $.ui.mount(NOTICE as never)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'q-2' })
  expect(logs.filter(line => line.startsWith('track: jump'))).toEqual(['track: jump {"to":{"requestId":"engine-notice-instance"},"block":"start"}'])
})

test('resume retains a restore record still needed by an uncleared question', async ($, on) => {
  mock.clock(on)
  const live = { by: BY, from: FROM, steps: 0, questions: QUESTIONS }
  const history = [1, 2, 3, 4].map(n => ({ by: `older-${n}`, from: FROM, steps: 0, questions: [] }))
  const ledger = atomStore(on, 'ledger', EMPTY as any)
  pluginStore(on, { [`s:${SESSION}`]: { v: 1, ledger: { ...EMPTY, nextQuestionId: 3, questions: QUESTIONS, restores: [live, ...history] } } })
  on('session.id', () => ({ value: SESSION }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(ledger.value.restores.some((r: any) => r.by === BY)).toBe(true)
  expect(ledger.value.restores.filter((r: any) => r.by !== BY)).toHaveLength(3)
})
