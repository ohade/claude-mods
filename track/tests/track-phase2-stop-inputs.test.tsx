// FIXTURE: B2 connects the native module to B1's independently tested command-Stop claims.
// The helper below models receipts only; Python tests exercise the real filesystem protocol.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, PendingInput, Step, StepFreshness, Turn } from '../types'

const FIRST = 'Why is the task waiting?'
const SECOND = 'How does the retry work?'
const HELPER_REASON = 'track: shared input repair receipt'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ANSWER = 'Write the formatted answer once between standalone <!-- A{id}:start --> and <!-- A{id}:end --> lines, using its stable numeric id; Track captures it automatically. Do not also send answer_text. For a tool/file-only answer, call mcp__track__mark_answered with the completed answer_text'
const worded = (text: string) => `track: a prompt looks like a question ("${text.slice(0, 80)}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, ${ANSWER}; for a request instead, reuse a matching open step with mcp__track__mark_step, keeping its current status and the same source_text. For new work, call mcp__track__track_steps with the same source_text; use after when steps already exist so their rows and statuses are kept. Then finish.`
const labelled = (text: string) => `track: the classifier labelled a prompt a question ("${text.slice(0, 80)}") and no question row covers it; steps never cover a labelled question. Call mcp__track__track_question with source_text = its first line, ${ANSWER}. If it is a request already tracked as steps, mark that question deferred with a note naming the step. Then finish.`
type Snapshot = { inputs?: Array<{ id: number; reason: string }>; candidates?: Array<{ kind: string }>; truncated?: true }
type Mode = 'block' | 'spent' | 'unknown' | 'exit' | 'truncated' | 'throw'
const input = (id: number, extra: Partial<PendingInput> = {}): PendingInput => ({
  id, head: FIRST, excerpt: FIRST, textHash: `fixture-${id}`, turnId: 'turn-1', ...extra,
})

const prepare = (on: On, options: { inputs?: PendingInput[]; classifier?: boolean; freshness?: StepFreshness; steps?: Step[]; below?: string; root?: false } = {}) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, steps: options.steps ?? [] })
  const pending = atomStore<Pending>(on, 'pending', { inputs: options.inputs ?? [], nextId: 1 })
  const turn = atomStore<Turn>(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0, freshness: options.freshness })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on, { classifier: { isOn: options.classifier === true } })
  const lines = logs(on)
  const env = new Map<string, string>([['CLAUDE_CONFIG_DIR', '/fixture/config']])
  if (options.root !== false) env.set('CLAUDE_PLUGIN_ROOT', '/fixture/track')
  const helper = { mode: 'block' as Mode }
  const calls: Array<{ snapshot: Snapshot; argv: readonly string[]; timeout?: number }> = []
  const publications: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => {
    env.set(e.name, String(e.value))
    if (e.name === 'TRACK_GATE_SNAPSHOT') publications.push(String(e.value))
    return { value: {} }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => options.below === undefined ? {} : { block: options.below })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'fixture command finished' }))
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'not_question', usage: USAGE } }) as never)
  on('process.run', { argv: /^\/fixture\/track\/hooks\/stop-gate\.py$/ }, (_, e) => {
    calls.push({ snapshot: JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}'), argv: e.argv, timeout: e.init?.timeoutMs })
    if (helper.mode === 'throw') throw new Error('fixture helper unavailable')
    const receipt = helper.mode === 'block' ? { decision: 'block', reason: HELPER_REASON } : {}
    return { value: { exitCode: helper.mode === 'exit' ? 1 : 0, stdout: JSON.stringify(receipt),
      stderr: helper.mode === 'unknown' ? 'track: pending input repair receipt unavailable' : '',
      isStdoutTruncated: helper.mode === 'truncated', isStderrTruncated: false } }
  })
  return { clock, ledger, pending, turn, lines, helper, calls, publications,
    snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as Snapshot }
}

const ask = ($: Engine, text: string, turnId = 'turn-1') => $.prompt.submit({ text, turnId, origin: { kind: 'composer' } } as never)
const start = ($: Engine, turnId = 'turn-1') => $.turn.start({ text: 'Continue the requested work', turnId } as never)
const call = ($: Engine, tool: string, extra: object = {}) => $.tool.call({ tool, tool_use_id: `fixture-${tool}`, ...extra } as never)
const stop = ($: Engine, extra: object = {}) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [], ...extra } as never)

test('R1 producer publishes an explicit empty input list', async ($, on) => {
  const fixture = prepare(on)
  await start($)
  expect(fixture.snapshot().inputs).toEqual([])
})

test('R1 producer orders prompt inputs and republishes question and steps coverage', async ($, on) => {
  const fixture = prepare(on)
  await ask($, FIRST)
  await start($)
  expect(fixture.snapshot().inputs).toEqual([{ id: 1, reason: worded(FIRST) }])
  await ask($, SECOND, 'turn-2')
  await start($, 'turn-2')
  expect(fixture.snapshot().inputs).toEqual([{ id: 1, reason: worded(FIRST) }, { id: 2, reason: worded(SECOND) }])
  await call($, 'mcp__track__track_question', { summary: FIRST, source_text: FIRST })
  expect(fixture.snapshot().inputs).toEqual([{ id: 2, reason: worded(SECOND) }])
  await call($, 'mcp__track__track_steps', { steps: ['Inspect the retry'], source_text: SECOND })
  expect(fixture.snapshot().inputs).toEqual([])
})

test('R1 producer ignores held marks, excludes covered and negative inputs, and sorts ids', async ($, on) => {
  const fixture = prepare(on, { inputs: [input(3), input(1, { held: true }), input(2, { covered: 'question' }),
    input(4, { label: 'not_question' }), input(5, { wording: false })] })
  await start($)
  expect(fixture.snapshot().inputs).toEqual([{ id: 1, reason: worded(FIRST) }, { id: 3, reason: worded(FIRST) }])
})

for (const label of ['question', 'not_question'] as const) {
  test(`R2 a delayed ${label} label republishes the input snapshot`, async ($, on) => {
    const fixture = prepare(on, { classifier: true })
    let release = (_: unknown) => {}
    on('model.complete', () => new Promise(resolve => { release = resolve }) as never)
    const text = label === 'question' ? 'Explain the retry mechanism' : FIRST
    await ask($, text)
    await start($)
    await fixture.clock.advance(1)
    const before = fixture.publications.length
    release({ value: { isAnswered: true, text: label, usage: USAGE } })
    await fixture.clock.advance(1)
    expect(fixture.snapshot().inputs).toEqual(label === 'question' ? [{ id: 1, reason: labelled(text) }] : [])
    expect(fixture.publications.length).toBeGreaterThan(before)
  })
}

test('R3 classic Stop claims the input once and returns the exact helper receipt', async ($, on) => {
  const fixture = prepare(on, { inputs: [input(1)] })
  expect((await stop($)).block).toBe(HELPER_REASON)
  expect(fixture.calls).toHaveLength(1)
  expect(fixture.calls[0]?.argv).toEqual(['python3', '/fixture/track/hooks/stop-gate.py', '--claim'])
  expect(fixture.calls[0]?.timeout).toBe(2000)
  expect(fixture.calls[0]?.snapshot).toMatchObject({ inputs: [{ id: 1, reason: worded(FIRST) }], candidates: [] })
  expect(fixture.pending.value.inputs[0]?.held).toBe(true)
  expect(fixture.turn.value.gatedTurnId).toBe('turn-1')
  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  expect(fixture.calls).toHaveLength(1)
})

test('R4 the published input remains present while freshness claim copies omit its key', async ($, on) => {
  const fixture = prepare(on, { inputs: [input(1, { held: true })],
    steps: [{ id: 'plan:1', source: 'plan', subject: 'Review the result', status: 'waiting' }],
    freshness: { turnId: 'turn-1', edits: [], bash: [], steps: ['plan:1'], completed: [], waiting: ['plan:1'],
      response: { turn_id: 'turn-1', request_id: 'fixture-response', arrow_ids: [] }, held: [], nudged: [] } })
  fixture.helper.mode = 'spent'
  await call($, 'Bash', { command: 'true' })
  // The merged baseline has no producer. This prerequisite is R4's observed RED;
  // the no-key assertions below reject a naive producer-only implementation.
  expect(fixture.snapshot().inputs).toEqual([{ id: 1, reason: worded(FIRST) }])
  await stop($, { stop_hook_active: true })
  expect(fixture.calls.length).toBeGreaterThan(0)
  for (const claim of fixture.calls) {
    expect(Object.hasOwn(claim.snapshot, 'inputs')).toBe(false)
    expect(claim.snapshot.candidates).toEqual([{ kind: 'missing_waiting_request', id: 'plan:1' }])
  }
})

for (const mode of ['spent', 'unknown'] as const) {
  test(`R5 ${mode} helper receipt ${mode === 'spent' ? 'acknowledges' : 'preserves'} the input hold`, async ($, on) => {
    const fixture = prepare(on, { inputs: [input(1)] })
    fixture.helper.mode = mode
    expect((await stop($)).block).toBeUndefined()
    expect(fixture.pending.value.inputs[0]?.held === true).toBe(mode === 'spent')
    if (mode === 'unknown') {
      expect(fixture.lines.join('\n')).toContain('pending input repair receipt unavailable')
      fixture.helper.mode = 'block'
      expect((await stop($, { stop_hook_active: true })).block).toBe(HELPER_REASON)
      expect(fixture.pending.value.inputs[0]?.held).toBe(true)
    }
  })
}

test('R6 the byte bound removes candidates before inputs and marks partial evidence', async ($, on) => {
  const inputs = Array.from({ length: 50 }, (_, index) => input(index + 1, { excerpt: `Why ${'😀'.repeat(70)} ${index}?` }))
  const fixture = prepare(on, { inputs,
    steps: [{ id: 'plan:1', source: 'plan', subject: 'Review the result', status: 'waiting' }],
    freshness: { turnId: 'turn-1', edits: [], bash: [], steps: ['plan:1'], completed: [], waiting: ['plan:1'], held: [], nudged: [] } })
  await call($, 'Bash', { command: 'true' })
  const snapshot = fixture.snapshot()
  expect(Array.isArray(snapshot.inputs)).toBe(true)
  expect(snapshot.inputs!.length).toBeGreaterThan(0)
  expect(snapshot.inputs!.length).toBeLessThan(50)
  expect(snapshot.candidates).toEqual([])
  expect(snapshot.truncated).toBe(true)
  expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(16 * 1024)
})

test('C1 a lower Stop block is preserved without spending an input claim', async ($, on) => {
  const fixture = prepare(on, { inputs: [input(1)], below: 'settings hook blocked' })
  expect((await stop($)).block).toBe('settings hook blocked')
  expect(fixture.calls).toHaveLength(0)
  expect(fixture.pending.value.inputs[0]?.held).toBeUndefined()
})

for (const failure of ['exit', 'truncated', 'throw', 'configuration'] as const) {
  test(`C2 unavailable helper (${failure}) retains the old local block once`, async ($, on) => {
    const fixture = prepare(on, { inputs: [input(1)], ...(failure === 'configuration' && { root: false as const }) })
    if (failure !== 'configuration') fixture.helper.mode = failure
    expect((await stop($)).block).toBe(worded(FIRST))
    expect(fixture.pending.value.inputs[0]?.held).toBe(true)
    expect(fixture.turn.value.gatedTurnId).toBe('turn-1')
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  })
}
