import { expect, mock, test } from 'claude-code/testing'
import type { Register } from 'claude-code'
import type { Activity, Ledger } from '../types'
import { EMPTY, pane } from '../tests/kit'

// TRACK-14 part 1: the real mod/engine chain, with synthetic state, not Ink paint.
// Kept outside tests/ so the repeatable benchmark does not slow the regression suite.
const NOW = 1_800_000_000_000
const SAMPLES = 40
const WARMUP = 5
const WINDOW_MS = 6000
const OBSERVATION_MS = 100
const SOURCE_DIGEST = 'TRACK14_PREPARED_SOURCE_DIGEST'

const observer = {
  name: 'track-render-observer',
  tier: 'prepend' as const,
  register: ((on) => {
    on('ui.render', { component: 'Pane', requestId: 'track' }, async ($, event, next) => {
      const began = performance.now()
      const tree = await next(event)
      const elapsed = performance.now() - began
      $.ui.log(`TRACK14_RENDER ${JSON.stringify({ elapsed_ms: elapsed })}`, { to: 'debug' })
      return tree
    })
  }) as Register,
}

const fixture = (steps: number, questions: number, busy: boolean): Ledger => ({
  ...EMPTY, v: 1, nextQuestionId: questions + 1,
  steps: Array.from({ length: steps }, (_, i) => ({
    id: `plan:${i + 1}`, source: 'plan',
    subject: `FIXTURE step ${i + 1}: preserve the full long title while measuring the unchanged terminal pane`,
    status: busy && i === Math.floor(steps / 2) ? 'in_progress' : i % 3 === 0 ? 'completed' : 'pending',
    ...(busy && i === Math.floor(steps / 2) && { startedAt: NOW - 7000, activeTurnId: 'fixture-turn' }),
  })),
  questions: Array.from({ length: questions }, (_, i) => ({
    id: i + 1, head: `FIXTURE question ${i + 1}: retain full question text across narrow and wide layouts`,
    at: NOW, turnId: null, status: i % 3 === 0 ? 'answered' : 'open',
    ...(i % 3 === 0 && { answerText: `FIXTURE answer ${i + 1}` }),
  })),
})

const scenarios = [
  { name: 'empty', steps: 0, questions: 0, busy: false },
  { name: 'steps-50', steps: 50, questions: 0, busy: false },
  { name: 'maximum', steps: 300, questions: 200, busy: false },
  { name: 'busy', steps: 50, questions: 0, busy: true },
  { name: 'rapid-scroll', steps: 300, questions: 200, busy: false },
  { name: 'resize', steps: 300, questions: 200, busy: false },
  { name: 'closed-busy', steps: 50, questions: 0, busy: true },
]

for (const scenario of scenarios) test(`TRACK14 FIXTURE ${scenario.name}`, {
  plugins: [observer], timeoutMs: 60_000,
}, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const ledger = { value: fixture(scenario.steps, scenario.questions, scenario.busy) }
  const original = JSON.stringify(ledger.value)
  const activity: Activity = { isWorking: scenario.busy, agentCalls: [], askCalls: [], background: [], tasks: [] }
  // The test-side engine has no state noun. Call the host beneath each seed read,
  // retaining its version/dependency tracking, and override only the fixture value.
  on('state.get', { plugin: 'track', key: 'ledger' }, async (_, event, next) => {
    const host = await next(event)
    return { value: { ...host.value, value: ledger.value } }
  })
  on('state.get', { plugin: 'track', key: 'activity' }, async (_, event, next) => {
    const host = await next(event)
    return { value: { ...host.value, value: activity } }
  })
  // Observe writes, but pass them through to the host so redraw dependencies stay real.
  const pulse = { writes: [] as unknown[] }
  const tick = { writes: [] as unknown[] }
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, event, next) => {
    ledger.value = event.value as Ledger
    return next(event)
  })
  on('state.set', { plugin: 'track', key: 'pulse' }, (_, event, next) => {
    pulse.writes.push(event.value)
    return next(event)
  })
  on('state.set', { plugin: 'track', key: 'tick' }, (_, event, next) => {
    tick.writes.push(event.value)
    return next(event)
  })
  const dispatches: number[] = []
  const timerErrors: string[] = []
  let explicitInvalidations = 0
  on('ui.log', (_, event) => {
    if (event.text.startsWith('TRACK14_RENDER ')) dispatches.push(JSON.parse(event.text.slice(15)).elapsed_ms)
    if (/track: (pulse|clock) tick failed:/.test(event.text)) timerErrors.push(event.text)
    return { value: undefined }
  })
  on('ui.invalidate', (_, event, next) => {
    explicitInvalidations++
    return next(event)
  })
  on('ui.scroll', () => ({}))

  const ui = await $.ui.mount(pane('dock', 60, 30))
  expect((await ui.findAll({ type: 'Text' })).some(el => String(el.text).includes('SESSION TRACKER'))).toBe(true)
  expect(ledger.value.steps).toHaveLength(scenario.steps)
  expect(ledger.value.questions).toHaveLength(scenario.questions)
  for (let i = 0; i < WARMUP; i++) await ui.redraw()
  const sampleStart = dispatches.length
  let scrollEvents = 0
  let resizeEvents = 0
  for (let i = 0; i < SAMPLES; i++) {
    if (scenario.name === 'rapid-scroll') {
      await $.ui.scroll({ component: 'Pane', requestId: 'track', offset: 0, by: i % 2 ? -3 : 7,
        bodyRows: 30, contentRows: 30, origin: { kind: 'person' }, pointer: { row: 18, column: 5 } } as never)
      await clock.advance(50)
      scrollEvents++
    }
    if (scenario.name === 'resize') {
      await ui.redraw(pane('dock', i % 2 ? 30 : 60, i % 2 ? 20 : 30).props)
      resizeEvents++
    } else await ui.redraw()
  }
  const samples = dispatches.slice(sampleStart)
  expect(samples.length).toBeGreaterThanOrEqual(SAMPLES)
  expect(samples.every(ms => Number.isFinite(ms) && ms >= 0)).toBe(true)
  const snapshot = await ui.drawn()
  const pulseBefore = pulse.writes.length
  const tickBefore = tick.writes.length
  const invalidationsBefore = explicitInvalidations
  const timerRenderStart = dispatches.length
  if (scenario.name === 'closed-busy') await ui.unmount()
  for (let elapsed = 0; elapsed < WINDOW_MS; elapsed += OBSERVATION_MS) {
    await clock.advance(OBSERVATION_MS)
    if (scenario.name !== 'closed-busy') await ui.drawn()
  }
  const timerWindow = {
    virtual_ms: WINDOW_MS, observation_ms: OBSERVATION_MS,
    pulse_state_writes: pulse.writes.length - pulseBefore,
    clock_state_writes: tick.writes.length - tickBefore,
    explicit_invalidation_calls: explicitInvalidations - invalidationsBefore,
    observed_render_dispatches: dispatches.length - timerRenderStart,
  }
  // A state-driven visible redraw must reach the observer, or its frequency is unmeasured.
  if (scenario.name === 'busy') expect(timerWindow.observed_render_dispatches).toBeGreaterThan(0)
  expect(JSON.stringify(ledger.value)).toBe(original)
  expect(timerErrors).toEqual([])
  if (scenario.name !== 'closed-busy') await ui.unmount()
  console.log(`TRACK14_BASELINE ${JSON.stringify({
    schema_version: 1, proof_class: 'FIXTURE', scenario: scenario.name,
    production_source_digest: SOURCE_DIGEST,
    steps: scenario.steps, questions: scenario.questions, busy: scenario.busy,
    metric: 'pane_render_dispatch_ms', warmup: WARMUP, requested_samples: SAMPLES,
    samples_ms: samples, timer_window: timerWindow, scroll_events: scrollEvents,
    resize_events: resizeEvents, snapshot,
    limitations: ['Engine/mod dispatch, not terminal paint', 'Mock-clock timer window, not painted frame rate',
      'Timing samples use requested redraws; timer window only reads host drawings at 10 Hz',
      'Key-to-paint latency is UNRESOLVED'],
  })}`)
})
