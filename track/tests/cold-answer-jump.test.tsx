// FIXTURE: native cold resume, 2026-11-07 (Codex, session 861da665). Q1 was answered by reply
// markers and its [ A ] jumped while that process lived. After a cold resume of the same session,
// the first [ A ] toasted "the source row has not been drawn on this load". The drawn instance was
// kept only in module memory and $.state, which the host holds for one process: it survives a hot
// reload, not a restart (d.ts `state`: "Persist through $.store"). The prompt's drawn id is kept in
// the ledger, so [ Q ] still jumped. The answer's drawn instance must be kept the same way, saved
// without waiting for another turn.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const UUID = '7c7c7c7c-2222-4333-8444-555555555555'
const ROW = '7c7c7c7c-2222-4333-8444'
const DRAWN = ROW + '-000000000000'
const ANSWER = 'Marked answer before a restart.'
const marked = { id: 1, head: 'Which source?', at: 1, turnId: 't1', status: 'answered', answerText: ANSWER, answerRequestId: UUID, answerKey: `${ROW}:A1`, session_id: SESSION }
const moves = (lines: string[]) => lines.filter(line => line.startsWith('track: jump'))
const notDrawn = (lines: string[]) => lines.filter(line => line.includes('has not been drawn on this load'))
type Held = { value: unknown; version: number }

const prepare = (on: On, held: object) => {
  const clock = mock.clock(on)
  const pool = blobPool(on)
  // Host-held values ($.state): a restart empties both.
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
const drawMarkedAnswer = ($: Engine) => $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text: `<!-- A1:start -->\n${ANSWER}\n<!-- A1:end -->`, isFirstOfReply: true, onScreen: null } } as never)
// A cold resume of the same session: every host-held value is gone, only $.store remains, and
// session.start runs again.
const restart = ($: Engine, ...atoms: Held[]) => {
  for (const atom of atoms) {
    atom.value = atom === atoms[0] ? EMPTY : { session: null, rows: [] }
    atom.version += 1
  }
  return start($)
}
const savedQuestion = async (fixture: ReturnType<typeof prepare>) =>
  ((await fixture.pool.logical(fixture.store, `s:${SESSION}`)) as { ledger: { questions: Array<Record<string, unknown>> } }).ledger.questions[0]!

test('a marker answer drawn before a cold resume of the same session still jumps to the reply it was drawn in', async ($, on) => {
  const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked], session_id: SESSION })
  await start($)
  await drawMarkedAnswer($)
  await fixture.clock.settle()
  await restart($, fixture.ledgerAtom, fixture.rendersAtom)
  await fixture.clock.settle()
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(notDrawn(fixture.lines)).toEqual([])
  expect(moves(fixture.lines)).toEqual([`track: jump {"to":{"requestId":"${DRAWN}"},"block":"start"}`])
})

test('the drawn instance reaches the saved ledger with no further turn, and the transcript uuid is not used for it', async ($, on) => {
  const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked], session_id: SESSION })
  await start($)
  await drawMarkedAnswer($)
  await fixture.clock.settle()
  const q = await savedQuestion(fixture)
  expect(q.answerInstance).toBe(DRAWN)
  expect(q.answerRequestId).toBe(UUID)
})

test('an answer never drawn before the restart still refuses visibly and does not scroll', async ($, on) => {
  const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked], session_id: SESSION })
  await start($)
  await restart($, fixture.ledgerAtom, fixture.rendersAtom)
  await fixture.clock.settle()
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(fixture.lines)).toEqual([])
  expect(notDrawn(fixture.lines).length).toBeGreaterThan(0)
})

test('a drawn instance is not written onto an answer that changed before the save ran', async ($, on) => {
  const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [marked], session_id: SESSION })
  await start($)
  await drawMarkedAnswer($)
  // Before the timer runs, the answer is replaced by a different reply's block.
  fixture.ledgerAtom.value = { ...EMPTY, nextQuestionId: 2, session_id: SESSION, questions: [{ ...marked, answerKey: 'aaaaaaaa-2222-4333-8444:A1', answerRequestId: 'aaaaaaaa-2222-4333-8444-555555555555' }] }
  fixture.ledgerAtom.version += 1
  await fixture.clock.settle()
  const q = (fixture.ledgerAtom.value as { questions: Array<Record<string, unknown>> }).questions[0]!
  expect(q.answerInstance).toBeUndefined()
})
