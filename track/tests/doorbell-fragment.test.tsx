// FIXTURE: an AMQ doorbell injected into the input box is not the user's words. A prompt cut off by
// it and then re-sent whole needs no row of its own; a complete question still does. The two
// sequences are the real prompts of session 635dbccb (2026-11-16); stub model replies only.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine } from './kit'

const DOORBELL = ': AMQ doorbell run amq drain --include-body then act on it'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const labelledFor = (excerpt: string) =>
  `track: the classifier labelled a prompt a question ("${excerpt}") and no question row covers it; steps never cover a labelled question. Call mcp__track__track_question with source_text = its first line, Write the formatted answer once between standalone <!-- A{id}:start --> and <!-- A{id}:end --> lines, using its stable numeric id; Track captures it automatically. Do not also send answer_text. For a tool/file-only answer, call mcp__track__mark_answered with the completed answer_text. If it is a request already tracked as steps, mark that question deferred with a note naming the step. Then finish.`
const worded = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, Write the formatted answer once between standalone <!-- A{id}:start --> and <!-- A{id}:end --> lines, using its stable numeric id; Track captures it automatically. Do not also send answer_text. For a tool/file-only answer, call mcp__track__mark_answered with the completed answer_text; for a request instead, reuse a matching open step with mcp__track__mark_step, keeping its current status and the same source_text. For new work, call mcp__track__track_steps with the same source_text; use after when steps already exist so their rows and statuses are kept. Then finish.`

const SEQUENCES = [
  { cut: `the real question is wha ${DOORBELL.slice(0, -1)}`, whole: 'the real question is what should i be doing in cases where I see alert like this? what is expected [Image #1]' },
  { cut: `side note we need to ${DOORBELL}`, whole: 'side note we need to reduce this noise from this hooks? [Image #2] read the amq' },
]

const prepare = (on: Parameters<typeof atomStore>[0], options: { isOn: boolean; label?: string }) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on, { classifier: { isOn: options.isOn } })
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
    return { value: { isAnswered: true, text: options.label ?? 'question', usage: USAGE } } as never
  })
  return { clock, prompts }
}

const ask = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never) as Promise<{ deny?: string; result?: unknown }>
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false } as never) as Promise<{ block?: string }>

for (const { cut, whole } of SEQUENCES) {
  test(`a prompt cut by the doorbell and re-sent whole demands no row of its own: ${whole.slice(0, 24)}`, async ($, on) => {
    const { clock } = prepare(on, { isOn: true })
    await ask($, cut)
    await clock.advance(1)
    await ask($, whole)
    await clock.advance(1)
    // The re-sent prompt keeps its normal handling: it still waits for its row.
    expect((await stop($)).block).toBe(labelledFor(whole.slice(0, 80)))
    await call($, { tool: 'mcp__track__track_question', summary: 'Re-sent question', source_text: whole, tool_use_id: 'toolu_q' })
    expect((await stop($)).block).toBeUndefined()
  })
}

test('the classifier sees the user\'s words without the doorbell', async ($, on) => {
  const { clock, prompts } = prepare(on, { isOn: true })
  await ask($, SEQUENCES[0]!.cut)
  await clock.advance(1)
  expect(prompts).toEqual(['the real question is wha'])
})

test('a complete question with the doorbell attached still demands its row', async ($, on) => {
  const { clock } = prepare(on, { isOn: false })
  const complete = `what is the status of the gate? ${DOORBELL}`
  await ask($, complete)
  await clock.advance(1)
  expect((await stop($)).block).toBe(worded(complete.slice(0, 80)))
})

test('a later prompt that does not continue the cut question does not supersede it', async ($, on) => {
  const { clock } = prepare(on, { isOn: false })
  const complete = `what is the status of the gate? ${DOORBELL}`
  await ask($, complete)
  await ask($, 'Thanks, continue.')
  await clock.advance(1)
  expect((await stop($)).block).toBe(worded(complete.slice(0, 80)))
})

for (const [name, text] of [['whole', DOORBELL], ['truncated', DOORBELL.slice(0, -4)]] as const) {
  test(`a ${name} doorbell alone demands no row`, async ($, on) => {
    const { clock } = prepare(on, { isOn: true })
    await ask($, text)
    await clock.advance(1)
    expect((await stop($)).block).toBeUndefined()
  })
}

// A fragment is only superseded when it is cut off: a complete sentence is the user's finished
// question, and only a prompt starting with all of its words is a re-send.
const ESCAPES = [
  { name: 'a complete short question', cut: `why? ${DOORBELL}`, later: 'why does the deploy keep failing?' },
  { name: 'a complete question that is a letter-prefix of the next', cut: `is it up? ${DOORBELL}`, later: 'is it updated in prod?' },
  { name: 'a complete second line', cut: `can you check the logs\nwhy did the deploy fail? ${DOORBELL}`, later: 'can you check the logs again' },
]

for (const { name, cut, later } of ESCAPES) {
  test(`${name} cut by the doorbell is not superseded by a different prompt`, async ($, on) => {
    const { clock } = prepare(on, { isOn: false })
    await ask($, cut)
    await ask($, later)
    await clock.advance(1)
    const block = (await stop($)).block
    expect(block).toContain(`"${cut.slice(0, 80)}"`)
  })
}

test('a re-sent prompt carrying the same image tag as its cut fragment supersedes it', async ($, on) => {
  const { clock } = prepare(on, { isOn: true })
  await ask($, `please look at this [Image #1] and tell me wha ${DOORBELL}`)
  await clock.advance(1)
  await ask($, 'please look at this [Image #1] and tell me what is wrong with it')
  await clock.advance(1)
  expect((await stop($)).block).toBe(labelledFor('please look at this [Image #1] and tell me what is wrong with it'))
})

test('a fragment longer than the bound is not recorded, so its row is still demanded', async ($, on) => {
  const { clock } = prepare(on, { isOn: true })
  const long = `${'word '.repeat(500)}cut`
  const whole = `alpha ${long} and then the rest of the question`
  await ask($, `alpha\n${long} ${DOORBELL}`)
  await ask($, whole)
  await clock.advance(1)
  await call($, { tool: 'mcp__track__track_question', summary: 'Re-sent question', source_text: whole, tool_use_id: 'toolu_q' })
  // The re-sent prompt has its row; the unrecorded fragment still waits for its own.
  expect((await stop($)).block).toContain('classifier labelled a prompt a question')
})

test('user text that merely ends like the start of a doorbell is not stripped', async ($, on) => {
  const { clock, prompts } = prepare(on, { isOn: true })
  await ask($, 'what is in the header: AMQ')
  await clock.advance(1)
  expect(prompts).toEqual(['what is in the header: AMQ'])
})
