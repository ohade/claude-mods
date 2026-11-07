// FIXTURE: TRACK-48, 2026-11-07. Q12 was answered by reply markers at 10:50, the mod hot-reloaded
// at 10:58, and [ A ] on Q12 then toasted "the source row has not been drawn on this load" three
// times. A reload restarts module memory and re-runs session.start, but rows already on screen
// are not drawn again, so the instance each row was drawn under must outlive the reload.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const UUID = '48484848-2222-4333-8444-555555555555'
const ROW = '48484848-2222-4333-8444'
const DRAWN = ROW + '-000000000000'
const OTHER = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
const FROM = '11111111-2222-4333-8444-555555555555'
const BY = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const ANSWER = 'Marked answer after reload.'
const marked = { id: 1, head: 'Which source?', at: 1, turnId: 't1', status: 'answered', answerText: ANSWER, answerRequestId: UUID, answerKey: `${ROW}:A1` }
const restored = { id: 1, head: 'Restored question', at: 1, turnId: 'restored', status: 'answered', answerText: 'Restored answer', restoredFrom: FROM, restoredBy: BY, sourceId: `${FROM}:Q1` }
const moves = (lines: string[]) => lines.filter(line => line.startsWith('track: jump'))

// A reload of the session `id` names: session.start runs again over the same saved ledger.
const prepare = (on: On, held: object) => {
  const clock = mock.clock(on)
  const session = { id: SESSION }
  atomStore(on, 'ledger', held)
  pluginStore(on, { [`s:${SESSION}`]: { v: 1, ledger: held }, [`s:${OTHER}`]: { v: 1, ledger: held } })
  on('session.id', () => ({ value: session.id }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  return { clock, session, lines: logs(on) }
}
const reload = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const drawMarkedAnswer = ($: Engine) => $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text: `<!-- A1:start -->\n${ANSWER}\n<!-- A1:end -->`, isFirstOfReply: true, onScreen: null } } as never)

test('a marker answer drawn before a reload of the same session still jumps to its row', async ($, on) => {
  const { clock, lines } = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked] })
  await reload($)
  await drawMarkedAnswer($)
  await clock.settle()
  await reload($)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(lines.filter(line => line.includes('has not been drawn on this load'))).toEqual([])
  expect(moves(lines)).toEqual([`track: jump {"to":{"requestId":"${DRAWN}"},"block":"start"}`])
})

test('a restore row drawn before a reload of the same session still takes the restored answer jump', async ($, on) => {
  const held = { ...EMPTY, nextQuestionId: 2, questions: [restored], restores: [{ by: BY, from: FROM, steps: 0, questions: [restored] }] }
  const { clock, lines } = prepare(on, held)
  await reload($)
  await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'ToolUse', requestId: 'restore-host', props: { tool_use_id: BY, tool: 'mcp__track__restore_tracker', input: { from_session: FROM }, isRunning: false, isErrored: false, isInterrupted: false } } as never)
  await clock.settle()
  await reload($)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(lines)).toEqual(['track: jump {"to":{"requestId":"restore-host"},"block":"start"}'])
})

test('a new session starts with no drawn rows and refuses the old instance visibly', async ($, on) => {
  const { clock, session, lines } = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked] })
  await reload($)
  await drawMarkedAnswer($)
  await clock.settle()
  session.id = OTHER
  await reload($)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(lines)).toEqual([])
  expect(lines.some(line => line.startsWith('track: cannot jump —'))).toBe(true)
})
