// FIXTURE: native defect, 2026-11-08 (Codex host 55d1c672, debug lines 1160-1341). The engine refuses
// $.state.set made through a drawing's own `$` while that ui.render dispatch is still in flight
// (scope.drawing.isInFlight). Track drew a marker answer, queued its saves on a 0 ms timer, and the
// timer fired while the drawing (Prismantis around it) was still in flight: "answer instance not
// kept" and "render instances not saved", every time. A cold resume then had no saved instance.
// Here an outer plugin holds the drawing open while the timer fires; the saves must still land.
import { expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

const UUID = '7c7c7c7c-2222-4333-8444-555555555555'
const ROW = '7c7c7c7c-2222-4333-8444'
const DRAWN = ROW + '-000000000000'
const ANSWER = 'Marked answer drawn inside a slow outer drawing.'
const marked = { id: 1, head: 'Which source?', at: 1, turnId: 't1', status: 'answered', answerText: ANSWER, answerRequestId: UUID, answerKey: `${ROW}:A1`, session_id: SESSION }

// The outer drawing: it lets Track draw, then stays in flight on the mock clock until the test
// moves it past HOLD_MS. A test plugin runs in its own environment, so it signals through the log.
const HOLD_MS = 5000
const holder: Plugin = {
  name: 'holder',
  tier: 'prepend',
  register: on => {
    on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
      const tree = await next(e)
      $.ui.log('holder: drawing held', { to: 'debug' })
      await $.clock.sleep(5000)
      return tree
    })
  },
}

const prepare = (on: On, held: object) => {
  const clock = mock.clock(on)
  const pool = blobPool(on)
  const ledgerAtom = atomStore(on, 'ledger', held)
  const rendersAtom = atomStore(on, 'renders', { session: null, rows: [] } as { session: string | null; rows: [string, string][] })
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, savedAt: 1, ledger: held } })
  on('session.id', () => ({ value: SESSION }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  return { clock, pool, store, ledgerAtom, rendersAtom, lines: logs(on) }
}
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const savedQuestion = async (fixture: ReturnType<typeof prepare>) =>
  ((await fixture.pool.logical(fixture.store, `s:${SESSION}`)) as { ledger: { questions: Array<Record<string, unknown>> } }).ledger.questions[0]!
// Real time, bounded: wait until Track has logged a save attempt made while the drawing was held.
const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise<void>(resolve => { timers.setTimeout(resolve, 10) })
  return check()
}

test('saves queued by a drawing still land when their timer fires while that drawing is in flight', { plugins: [holder] }, async ($, on) => {
  const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked], session_id: SESSION })
  await start($)
  await fixture.clock.settle()
  const drawing = $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text: `<!-- A1:start -->\n${ANSWER}\n<!-- A1:end -->`, isFirstOfReply: true, onScreen: null } } as never)
  expect(await until(() => fixture.lines.includes('holder: drawing held'))).toBe(true)
  // Track's 0 ms timer fires now, while the drawing is still in flight.
  await fixture.clock.advance(0)
  expect(await until(() => fixture.lines.some(line => line.includes('is being dispatched')))).toBe(true)
  await fixture.clock.advance(HOLD_MS)
  await drawing
  await fixture.clock.advance(10_000)
  await fixture.clock.settle()
  expect((await savedQuestion(fixture)).answerInstance).toBe(DRAWN)
  expect(fixture.rendersAtom.value.rows).toContainEqual([`${ROW}:A1`, DRAWN])
})
