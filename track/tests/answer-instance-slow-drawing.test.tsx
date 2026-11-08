// FIXTURE: Codex review of 00fc5ce, 2026-11-08 (retry-window-review.ts). The engine allows a drawing
// to stay in flight past 6.35 s (HookBudget: 10 s of a hook's own time, its next(e) and $ calls not
// counted), and a save refused only because that drawing is still in flight was dropped after its
// eighth try. Such a save must wait until the drawing ends. A 5 s drawing is the control.
import { expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

const UUID = '7c7c7c7c-2222-4333-8444-555555555555'
const ROW = '7c7c7c7c-2222-4333-8444'
const DRAWN = ROW + '-000000000000'
const ANSWER = 'Marked answer drawn inside a slow outer drawing.'
const marked = { id: 1, head: 'Which source?', at: 1, turnId: 't1', status: 'answered', answerText: ANSWER, answerRequestId: UUID, answerKey: `${ROW}:A1`, session_id: SESSION }

// Outer drawings that let Track draw, then stay in flight on the mock clock. A test plugin runs in
// its own environment, so each holds for its own literal time and signals through the log.
const holdFor5s: Plugin = {
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
const holdFor8s: Plugin = {
  name: 'holder',
  tier: 'prepend',
  register: on => {
    on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
      const tree = await next(e)
      $.ui.log('holder: drawing held', { to: 'debug' })
      await $.clock.sleep(8000)
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
const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise<void>(resolve => { timers.setTimeout(resolve, 10) })
  return check()
}

for (const [holder, heldMs] of [[holdFor5s, 5000], [holdFor8s, 8000]] as const) {
  test(`a save refused while a ${heldMs / 1000} s drawing is in flight lands once that drawing ends`, { plugins: [holder] }, async ($, on) => {
    const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked], session_id: SESSION })
    await start($)
    await fixture.clock.settle()
    const drawing = $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text: `<!-- A1:start -->\n${ANSWER}\n<!-- A1:end -->`, isFirstOfReply: true, onScreen: null } } as never)
    expect(await until(() => fixture.lines.includes('holder: drawing held'))).toBe(true)
    // Every save attempt due before the drawing ends runs, and is refused, while it is held.
    await fixture.clock.advance(heldMs)
    expect(fixture.lines.some(line => line.includes('is being dispatched'))).toBe(true)
    await drawing
    await fixture.clock.advance(20_000)
    await fixture.clock.settle()
    expect((await savedQuestion(fixture)).answerInstance).toBe(DRAWN)
    expect(fixture.rendersAtom.value.rows).toContainEqual([`${ROW}:A1`, DRAWN])
  })
}
