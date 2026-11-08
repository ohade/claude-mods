import { expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

// Codex review F1, 2026-11-08: a plain answer (no markers) stores answerKey = the drawn row key,
// and Prismantis reads a plain reply's tint under the full native request id, so [ A ] must tint
// that id and never answer:<row>.
const DRAWN = '5e5e5e5e-1111-4222-8333-444444444444'
const ROW = '5e5e5e5e-1111-4222-8333'
const ACK = '7a7a7a7a-2222-4333-8444-555555555555'
const plain = { id: 1, head: 'Which source?', at: 1, turnId: 't1', status: 'answered', answerText: 'Completed answer.', answeredBy: 'ack-call', answerKey: ROW, answerRequestId: ACK, session_id: SESSION }

const stubRegister: Plugin['register'] = on => {
  on('engine.create', async (_$, e, next) => ({ ...(await next(e)), prismantis: { markdown: async () => undefined, reply: async () => undefined, tint: async () => undefined } }))
  on('prismantis.tint', async ($, e) => {
    $.ui.log(`stub-tint ${e.key} ${e.color ?? 'null'}`, { to: 'debug' })
    return { value: undefined }
  })
}

const outer: Plugin = { name: 'prismantis', tier: 'prepend', register: stubRegister }
const inner: Plugin = { name: 'prismantis', tier: 'append', register: stubRegister }

const prepare = (on: On, held: object) => {
  const clock = mock.clock(on)
  blobPool(on)
  atomStore(on, 'ledger', held)
  atomStore(on, 'renders', { session: null, rows: [] } as { session: string | null; rows: [string, string][] })
  pluginStore(on, { [`s:${SESSION}`]: { v: 1, savedAt: 1, ledger: held } })
  on('session.id', () => ({ value: SESSION }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  return { clock, lines: logs(on) }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const tints = (lines: string[]) => lines.filter(line => line.startsWith('stub-tint ')).map(line => line.slice('stub-tint '.length).split(' ') as [string, string])

for (const stub of [outer, inner]) {
  const order = stub.tier === 'prepend' ? 'outer' : 'inner'

  test(`[ A ] on a plain answer tints the drawn reply's full request id, never answer:<row> (${order} Prismantis)`, { plugins: [stub] }, async ($, on) => {
    const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [plain], session_id: SESSION })
    await start($)
    await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, viewport: { columns: 100, rows: 40 }, props: { text: 'Completed answer.', isFirstOfReply: true, onScreen: null } } as never)
    await fixture.clock.settle()
    const ui = await $.ui.mount(pane('dock'))
    await ui.press({ key: 'a-1' })
    await fixture.clock.advance(5000)
    await fixture.clock.settle()
    const calls = tints(fixture.lines)
    expect(calls.some(([key]) => key === `answer:${ROW}`)).toBe(false)
    expect(calls.some(([key, color]) => key === DRAWN && color !== 'null')).toBe(true)
    expect(calls.every(([key]) => key === DRAWN)).toBe(true)
    expect(calls.at(-1)).toEqual([DRAWN, 'null'])
  })
}
