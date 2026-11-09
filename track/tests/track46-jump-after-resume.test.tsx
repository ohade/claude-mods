// FIXTURE: TRACK-46 A4. A classic resume from session A to session B runs no
// session.start, so the drawn-row cache and its session binding still name A.
// B's answer jump must reach B's own drawn instance, and must never borrow a
// row A drew under the same row key.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const B = 'bbbbbbbb-4646-4000-8000-000000000004'
const A_ROW = '48484848-2222-4333-8444'
const A_DRAWN = A_ROW + '-000000000000'
const B_ROW = '46464646-4444-4333-8444'
const B_DRAWN = B_ROW + '-000000000000'
const ANSWER = 'Marked answer.'
const marked = (key: string, extra: object = {}) => ({ id: 1, head: 'Which source?', at: 1, turnId: 't1', status: 'answered', answerText: ANSWER, answerRequestId: '48484848-2222-4333-8444-555555555555', answerKey: key, ...extra })
const moves = (lines: string[]) => lines.filter(line => line.startsWith('track: jump'))

const prepare = (on: On, bQuestion: object) => {
  const clock = mock.clock(on)
  const session = { id: SESSION }
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  const a = { ...EMPTY, session_id: SESSION, nextQuestionId: 2, questions: [marked(`${A_ROW}:A1`)] }
  const b = { ...EMPTY, session_id: B, nextQuestionId: 2, questions: [bQuestion] }
  atomStore(on, 'ledger', a)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  pluginStore(on, { [`s:${SESSION}`]: { v: 1, ledger: a }, [`s:${B}`]: { v: 1, ledger: b } })
  blobPool(on)
  on('session.id', () => ({ value: session.id }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  return { clock, session, lines: logs(on) }
}
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const drawA = ($: Engine) => $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: A_DRAWN, props: { text: `<!-- A1:start -->\n${ANSWER}\n<!-- A1:end -->`, isFirstOfReply: true, onScreen: null } } as never)

// A draws its answer; then the host resumes B in the same process, with no session.start.
const resumeB = async ($: Engine, f: ReturnType<typeof prepare>) => {
  await start($)
  await drawA($)
  await f.clock.settle()
  f.session.id = B
  await $.prompt.submit({ text: 'Continue.', turnId: 'b1', origin: { kind: 'composer' } } as never)
  await f.clock.settle()
  expect(f.lines.filter(line => line.includes('resume failed')), 'B really resumed').toEqual([])
}

test('A4 after a classic resume, B jumps to its own persisted answer instance', async ($, on) => {
  const f = prepare(on, marked(`${B_ROW}:A1`, { answerInstance: B_DRAWN, answerInstanceSession: B }))
  await resumeB($, f)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(f.lines)).toEqual([`track: jump {"to":{"requestId":"${B_DRAWN}"},"block":"start"}`])
})

test('A4 control: B with no binding refuses and never borrows the row A drew under the same key', async ($, on) => {
  const f = prepare(on, marked(`${A_ROW}:A1`))
  await resumeB($, f)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(f.lines), 'no jump into a row drawn for session A').toEqual([])
  expect(f.lines.some(line => line.startsWith('track: cannot jump —'))).toBe(true)
})
