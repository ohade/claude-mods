// FIXTURE: a doorbell-cut fragment that the user re-sent whole is superseded, and the row for the
// re-send must cover the re-send, never the superseded fragment that shares its first line.
// Stub model replies only; the sequences mirror session 635dbccb (2026-11-16).
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine } from './kit'

const DOORBELL = ': AMQ doorbell run amq drain --include-body then act on it'
const FLOOR = DOORBELL.slice(0, ': AMQ doorbell'.length)
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const prepare = (on: Parameters<typeof atomStore>[0], options: { isOn: boolean }) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  const store = pluginStore(on, { classifier: { isOn: options.isOn } })
  on('session.id', () => ({ value: SESSION }))
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1 })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  const prompts: string[] = []
  on('model.complete', async (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: 'question', usage: USAGE } } as never
  })
  return { clock, prompts, store }
}

const ask = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never) as Promise<{ deny?: string; result?: unknown }>
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false } as never) as Promise<{ block?: string }>
const registerResend = ($: Engine, source_text: string) =>
  call($, { tool: 'mcp__track__track_question', summary: 'Re-sent question', source_text, tool_use_id: 'toolu_q' })

// Whether Stop still says an input has no question row. The re-send's own row stays open until it
// is answered, so the open-question reminder is not this test's concern.
const uncovered = async ($: Engine) => ((await stop($)).block ?? '').includes('no question row covers it')

// Red tests: both fail before the fix, because the row for the re-send binds to the superseded
// fragment that has the same first line.
test('a multi-line prompt cut after its first line and re-sent: the row for the re-send covers the re-send', async ($, on) => {
  const { clock } = prepare(on, { isOn: true })
  await ask($, `can you check the logs\nwhy did the deploy fai ${DOORBELL}`)
  await clock.advance(1)
  const whole = 'can you check the logs\nwhy did the deploy fail on staging?'
  await ask($, whole)
  await clock.advance(1)
  await registerResend($, whole)
  expect(await uncovered($)).toBe(false)
})

test('a single line over 200 characters cut and re-sent: the row for the re-send covers the re-send', async ($, on) => {
  const { clock } = prepare(on, { isOn: true })
  const lead = 'please explain why the deploy pipeline for the serving cluster keeps failing at the canary stage every time we push a config change, and what the alert in the channel means for the on-call engineer who has to look at it at night when it'
  expect(lead.length).toBeGreaterThan(200)
  await ask($, `${lead} fi ${DOORBELL}`)
  await clock.advance(1)
  const whole = `${lead} fires twice?`
  await ask($, whole)
  await clock.advance(1)
  await registerResend($, whole)
  expect(await uncovered($)).toBe(false)
})

// Pins: these pass before the change and hold after it.
test('pin: the classifier turned off after a fragment was recorded, a later plain prompt that continues it supersedes it', async ($, on) => {
  const { clock, store } = prepare(on, { isOn: true })
  await ask($, `side note we need to ${DOORBELL}`)
  await clock.advance(1)
  store.held.set('classifier', { isOn: false })
  // Not admitted (no question mark, no question word first), so only the pre-read write supersedes.
  await ask($, 'side note we need to reduce this noise')
  await clock.advance(1)
  expect((await stop($)).block).toBeUndefined()
})

test(`pin: user text followed by exactly the ${FLOOR.length}-character doorbell floor is stripped`, async ($, on) => {
  const { clock, prompts } = prepare(on, { isOn: true })
  await ask($, `what is in the header${FLOOR}`)
  await clock.advance(1)
  expect(prompts).toEqual(['what is in the header'])
})

test('pin: user text followed by one character less than the doorbell floor is not stripped', async ($, on) => {
  const { clock, prompts } = prepare(on, { isOn: true })
  await ask($, `what is in the header${FLOOR.slice(0, -1)}`)
  await clock.advance(1)
  expect(prompts).toEqual([`what is in the header${FLOOR.slice(0, -1)}`])
})

// The cut and the re-send start with different lines, so track_question binds to the re-send only.
const sized = (keyLength: number) => {
  const filler = 'x'.repeat(keyLength - 'alpha '.length)
  return { cut: `alpha\n${filler} ${DOORBELL}`, whole: `alpha ${filler} and the rest of it?` }
}

test('pin: a fragment of exactly 2,000 characters is recorded and superseded by the re-send', async ($, on) => {
  const { clock } = prepare(on, { isOn: true })
  const { cut, whole } = sized(2000)
  await ask($, cut)
  await clock.advance(1)
  await ask($, whole)
  await clock.advance(1)
  await registerResend($, whole)
  expect(await uncovered($)).toBe(false)
})

test('pin: a fragment of 2,001 characters is not recorded, so its own row is still demanded', async ($, on) => {
  const { clock } = prepare(on, { isOn: true })
  const { cut, whole } = sized(2001)
  await ask($, cut)
  await clock.advance(1)
  await ask($, whole)
  await clock.advance(1)
  await registerResend($, whole)
  expect((await stop($)).block).toContain('classifier labelled a prompt a question ("alpha\n')
})
