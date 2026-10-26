// FIXTURE: deferred phase-1 baseline races and the SDK's missing-observation limit.
import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, PluginState, SessionMessage } from 'claude-code'
import type { Ledger } from '../types'
import type { Engine, On } from './kit'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore, trackPrompt } from './kit'

const QUESTION = { id: 1, head: 'Keep the acknowledged question', at: 1000, turnId: 'before',
  status: 'open' as const, trackedBy: 'baseline-question-call' }
const callMessage = (id = 'baseline-question-call'): SessionMessage => ({ role: 'assistant', text: '',
  toolUses: [{ tool_use_id: id, tool: 'mcp__track__track_question', input: {} }] })
const header = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const OLD = [header('Earlier transcript header'), callMessage()]
const FRESH = [header('Current transcript header'), callMessage()]
const SUMMARY = header('A compacted summary of earlier work')
const latch = () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { enter, release, entered, released }
}
const fixtureWait = async <T,>(run: Promise<T>, label: string): Promise<T> => {
  const timers = globalThis as unknown as {
    setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void
  }
  let timer: unknown
  try {
    return await Promise.race([run, new Promise<never>((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`INVALID FIXTURE: timeout at ${label}`)), 3000)
    })])
  } finally { if (timer !== undefined) timers.clearTimeout(timer) }
}
const finish = ($: Engine) => $.turn.complete({ answer: 'Earlier work saved', reason: 'answer',
  turnId: 'before', durationMs: 1, isAborted: false } as never)

const prepare = (on: On) => {
  const clock = mock.clock(on, { now: 10000 })
  const initial: Ledger = { ...EMPTY, session_id: SESSION, nextQuestionId: 2, questions: [QUESTION] }
  const memory = atomStore<Ledger>(on, 'ledger', initial)
  const durability = atomStore<PluginState['track']['durability']>(on, 'durability', { isUnsaved: false, reason: '' })
  const pool = blobPool(on)
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, session_id: SESSION, savedAt: 1, ledger: initial } })
  const reads = { messages: OLD, reply: undefined as ((engine: EngineInterface) => Promise<SessionMessage[]>) | undefined }
  on('session.id', () => ({ value: SESSION }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 200000 }, rateLimits: [] } }))
  on('session.messages', async $ => ({ value: reads.reply === undefined ? reads.messages : await reads.reply($) }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.compact', () => ({ messages: [SUMMARY] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: ['hint'] }))
  logs(on)
  const saved = async () => (await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger
  return { clock, memory, durability, reads, saved }
}
const compact = ($: EngineInterface) => $.session.compact({ trigger: 'manual', messages: [SUMMARY] } as never)
const questionIds = async (fixture: ReturnType<typeof prepare>) =>
  [fixture.memory.value, await fixture.saved()].map(value => value.questions.map(row => row.id))

test('B5 TOCTOU: a slow turn-end read cannot replace the baseline established by a prompt', async ($, on) => {
  const fixture = prepare(on)
  const slow = latch()
  let first = true
  fixture.reads.reply = async () => {
    if (!first) return FRESH
    first = false
    slow.enter()
    await slow.released
    return OLD
  }
  const ending = finish($)
  try {
    await fixtureWait(slow.entered, 'turn-end transcript read')
    await trackPrompt($, 'Observe the current transcript')
    expect(fixture.memory.value.questions.map(row => row.id)).toEqual([1])
    slow.release()
    await fixtureWait(ending, 'slow turn end')
    fixture.reads.reply = undefined
    const text = 'Continue after the current transcript was rewound'
    fixture.reads.messages = [FRESH[0]!, header(text)]
    await trackPrompt($, text)
    expect(await questionIds(fixture)).toEqual([[], []])
  } finally {
    slow.release()
    await fixtureWait(ending, 'turn-end cleanup')
  }
})

test('B5 coalescing: a prompt still judges a rewind after waiting for a viewport read', async ($, on) => {
  const fixture = prepare(on)
  await finish($)
  const viewport = latch()
  const text = 'Continue after rewinding the tracked question'
  fixture.reads.messages = [OLD[0]!, header(text)]
  let first = true
  fixture.reads.reply = async () => {
    if (first) {
      first = false
      viewport.enter()
      await viewport.released
    }
    return fixture.reads.messages
  }
  await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'PromptHint', requestId: 'baseline-race-hint',
    props: { isDraft: true, isWorking: false, hint: '' } } as never)
  await fixture.clock.advance(1000)
  await fixtureWait(viewport.entered, 'viewport transcript read')
  const prompt = trackPrompt($, text)
  try {
    await fixture.clock.settle()
    viewport.release()
    await fixtureWait(prompt, 'prompt after viewport')
    await fixture.clock.settle()
    expect(await questionIds(fixture)).toEqual([[], []])
  } finally {
    viewport.release()
    await fixtureWait(prompt, 'viewport cleanup')
  }
})

test('B5 generation observe: a compact callback during a read prevents a stale rewind receipt', async ($, on) => {
  const fixture = prepare(on)
  await finish($)
  let fired = false
  fixture.reads.reply = async engine => {
    if (!fired) { fired = true; await compact(engine) }
    return []
  }
  await trackPrompt($, 'Continue after the compact callback')
  expect(fired).toBe(true)
  expect(fixture.durability.value.rewindBaseline).toBeUndefined()
  expect(fixture.memory.value.questions.map(row => row.id)).toEqual([1])
})

test('B5 generation turn end: a compact callback prevents a pre-compact baseline from masking the next rewind', async ($, on) => {
  const fixture = prepare(on)
  let fired = false
  fixture.reads.reply = async engine => {
    if (!fired) { fired = true; await compact(engine) }
    return OLD
  }
  await finish($)
  expect(fired).toBe(true)
  await fixture.clock.advance(1)
  fixture.memory.value = { ...fixture.memory.value, nextQuestionId: 3, questions: [...fixture.memory.value.questions,
    { id: 2, head: 'Question after compaction', at: Date.now(), turnId: 'after', status: 'open', trackedBy: 'after-question-call' }] }
  fixture.reads.reply = undefined
  fixture.reads.messages = [SUMMARY, callMessage('after-question-call')]
  await fixture.clock.advance(1)
  await trackPrompt($, 'Observe the question after compaction')
  const text = 'Continue after rewinding the post-compact question'
  fixture.reads.messages = [SUMMARY, header(text)]
  await trackPrompt($, text)
  expect(await questionIds(fixture)).toEqual([[1], [1]])
})

test('B4 SDK limitation: callback-free compaction before any baseline read is judged as rewind', async ($, on) => {
  const fixture = prepare(on)
  fixture.reads.messages = [SUMMARY]
  // No session.compact, prompt read or turn.complete has supplied an observation.
  await trackPrompt($, 'Continue without an earlier observation')
  expect(await questionIds(fixture)).toEqual([[], []])
  expect(fixture.memory.value.compactedAt).toBeUndefined()
})
