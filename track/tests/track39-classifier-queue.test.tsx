// FIXTURE: public classifier commands and in-memory LEGACY lock receipts. No OS lock or LIVE SDK proof.
// TRACK-39 release gate: classifier setting writes must share the store lock before GC activation.
import { expect, mock, test } from 'claude-code/testing'
import { entryBytes, SIZE_INDEX } from '../hooks/size-index'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'

const ON = 'track: the Haiku question classifier is on. Each typed prompt costs one small Haiku call; /track classifier off stops it.'
const OFF = 'track: the Haiku question classifier is off; the wording check decides. /track classifier on starts it.'
const NOT_SAVED = 'track: the classifier setting was not saved — '
const HISTORY = '00000000-0000-4000-8000-000000000039'
const command = ($: Engine, args: string) => $.command.run({ command: 'track', args } as never)

const fixture = (on: On, isOn = false, interceptClassifier = true) => {
  const clock = mock.clock(on)
  const initial = {
    classifier: { isOn }, sentinel: { preserved: ['fixture', 39] },
    [`s:${HISTORY}`]: { v: 1, session_id: HISTORY, ledger: EMPTY },
    [`h:${HISTORY}`]: { v: 1, session_id: HISTORY, generation: 'fixture-generation' },
    [`r:${HISTORY}:fixture`]: { v: 1, kind: 'fixture-history' },
    saved: { [HISTORY]: { at: 1, bytes: 39, unfinished: true } },
  }
  const original = new Map(Object.entries(JSON.parse(JSON.stringify(initial)) as typeof initial))
  const events: string[] = []
  const violations: string[] = []
  const mutations: string[] = []
  const deletions: string[] = []
  const unexpectedProcesses: string[] = []
  const control = { heldWrite: 0, writeRefusal: '', refuseClassifier: false, holdFirst: false, classifierEntries: 0 }
  let releaseFirst = () => {}
  let signalFirst = () => {}
  const firstEntered = new Promise<void>(resolve => { signalFirst = resolve })
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve })
  const options: NonNullable<Parameters<typeof pluginStore>[3]> = {
    refuseSet: (key, value) => {
      if (key === 'classifier' && control.refuseClassifier) return 'fixture classifier data write refused'
      recordMutation(key, value)
      return undefined
    },
  }
  const recordMutation = (key: string, value: unknown) => {
    mutations.push(key)
    if (key === 'classifier') {
      events.push(`mutate:${(value as { isOn: boolean }).isOn ? 'on' : 'off'}`)
      if (control.heldWrite !== 1) violations.push(`classifier mutation heldWrite=${control.heldWrite}`)
    }
  }
  // This first provider owns grant counts and releases; pluginStore's fallback never grants here.
  on('process.spawn', { argv: /writer-lock\.py$/ }, async function* (_, e) {
    const mode = e.argv[2]!
    events.push(`spawn:${mode}`)
    const refusal = mode === 'lease' ? options.leaseFailure : mode === 'write' ? control.writeRefusal : 'unexpected fixture guard'
    if (refusal) {
      events.push(`refuse:${mode}`)
      yield { stream: 'stdout' as const, text: JSON.stringify({ ok: false, reason: refusal }) }
      return { value: { code: 1, signal: null } }
    }
    if (mode === 'write') control.heldWrite++
    events.push(`grant:${mode}`)
    try {
      yield { stream: 'stdout' as const, text: JSON.stringify({ ok: true, mode, token: e.argv[4] }) }
      return { value: { code: 0, signal: null } }
    } finally {
      events.push(`release:${mode}`)
      if (mode === 'write') control.heldWrite--
    }
  })
  // No fixture may fall through to an actual helper, model CLI, or blob publisher.
  on('process.spawn', async function* (_, e) {
    unexpectedProcesses.push(e.argv.join(' '))
    yield { stream: 'stderr' as const, text: 'fixture refuses unexpected process' }
    return { value: { code: 1, signal: null } }
  })
  on('process.run', (_, e) => {
    unexpectedProcesses.push(e.argv.join(' '))
    return { deny: 'fixture refuses unexpected process' }
  })
  let store: ReturnType<typeof pluginStore>
  if (interceptClassifier) on('store.set', { key: /^classifier$/ }, async (_, e) => {
    control.classifierEntries++
    if (control.holdFirst && control.classifierEntries === 1) {
      signalFirst()
      await firstReleased
    }
    recordMutation(e.key, e.value)
    store.held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  // Filtered known-key deletion observer, not a competing catch-all store provider.
  on('store.delete', { key: /^(?:classifier$|capacitySizes$|sentinel$|saved$|[shr]:|cleanup(?:$|:))/ }, (_, e) => {
    deletions.push(e.key)
    store.held.delete(e.key)
    return { value: undefined }
  })
  atomStore(on, 'ledger', EMPTY)
  on('session.id', () => ({ value: SESSION }))
  store = pluginStore(on, initial, undefined, options)
  const assertPreserved = () => {
    const allowed = new Set(['classifier', SIZE_INDEX])
    expect(mutations.filter(key => !allowed.has(key))).toEqual([])
    expect(deletions).toEqual([])
    expect(unexpectedProcesses).toEqual([])
    expect([...store.held].filter(([key]) => !allowed.has(key))).toEqual([...original].filter(([key]) => !allowed.has(key)))
    expect([...store.held.keys()].sort()).toEqual([...original.keys(), ...(store.held.has(SIZE_INDEX) ? [SIZE_INDEX] : [])].sort())
  }
  const assertIndexed = (expected: boolean) => {
    expect(store.held.get('classifier')).toEqual({ isOn: expected })
    const index = store.held.get(SIZE_INDEX) as { v: number; sizes: Record<string, number>; pending?: string } | undefined
    expect(index?.v).toBe(1)
    expect(index?.pending).toBeUndefined()
    expect(index?.sizes.classifier).toBe(entryBytes('classifier', { isOn: expected }))
    assertPreserved()
  }
  const assertUnchanged = () => {
    expect([...store.held]).toEqual([...original])
    expect(mutations).toEqual([])
    assertPreserved()
  }
  return { clock, store, events, violations, mutations, control, options, firstEntered, releaseFirst,
    assertPreserved, assertIndexed, assertUnchanged }
}

test('classifier on/off mutate only after a verified write grant', async ($, on) => {
  const f = fixture(on)
  const enabled = await command($, 'classifier on')
  // Named primary RED: the real command has returned; baseline mutates with heldWrite=0.
  expect(f.violations).toEqual([])
  expect(enabled.text).toBe(ON)
  expect(f.events.indexOf('grant:lease') >= 0).toBe(true)
  expect(f.events.indexOf('grant:lease') < f.events.indexOf('grant:write')).toBe(true)
  expect(f.events.indexOf('grant:write') < f.events.indexOf('mutate:on')).toBe(true)
  expect(f.control.heldWrite).toBe(0)
  f.assertIndexed(true)
  expect((await command($, 'classifier off')).text).toBe(OFF)
  expect(f.violations).toEqual([])
  expect(f.events.filter(event => event.endsWith(':write') || event.startsWith('mutate:'))).toEqual([
    'spawn:write', 'grant:write', 'mutate:on', 'release:write',
    'spawn:write', 'grant:write', 'mutate:off', 'release:write',
  ])
  expect(f.control.heldWrite).toBe(0)
  f.assertIndexed(false)
})

test('classifier read-only query takes no writer lock and mutates nothing', async ($, on) => {
  const f = fixture(on, true)
  expect((await command($, 'classifier')).text).toBe(ON)
  expect(f.events).toEqual([])
  f.assertUnchanged()
})

test('refused session lease keeps setting and queue can retry', async ($, on) => {
  const f = fixture(on)
  f.options.leaseFailure = 'fixture session lease refused'
  const refused = await command($, 'classifier on')
  expect(refused.text?.startsWith(NOT_SAVED)).toBe(true)
  expect(refused.text).toContain(f.options.leaseFailure)
  expect(f.events).toEqual(['spawn:lease', 'refuse:lease'])
  f.assertUnchanged()
  delete f.options.leaseFailure
  expect((await command($, 'classifier on')).text).toBe(ON)
  expect(f.violations).toEqual([])
  expect(f.control.heldWrite).toBe(0)
  f.assertIndexed(true)
})

test('busy write grant keeps setting and queue can retry', async ($, on) => {
  const f = fixture(on)
  f.control.writeRefusal = 'fixture store writer is busy'
  const refused = await command($, 'classifier on')
  expect(refused.text?.startsWith(NOT_SAVED)).toBe(true)
  expect(refused.text).toContain(f.control.writeRefusal)
  expect(f.events.filter(event => event.endsWith(':write'))).toEqual(['spawn:write', 'refuse:write'])
  expect(f.events.includes('grant:lease')).toBe(true)
  f.assertUnchanged()
  f.control.writeRefusal = ''
  expect((await command($, 'classifier on')).text).toBe(ON)
  expect(f.violations).toEqual([])
  expect(f.events.filter(event => event === 'grant:write' || event === 'release:write')).toEqual(['grant:write', 'release:write'])
  expect(f.control.heldWrite).toBe(0)
  f.assertIndexed(true)
})

test('refused classifier data write retains pending and retry repairs it', async ($, on) => {
  // No classifier set override: kit.refuseSet exercises the genuine indexedStore failure path.
  const f = fixture(on, false, false)
  f.control.refuseClassifier = true
  const refused = await command($, 'classifier on')
  expect(refused.text?.startsWith(NOT_SAVED)).toBe(true)
  expect(refused.text).toContain('fixture classifier data write refused')
  expect(f.store.held.get('classifier')).toEqual({ isOn: false })
  expect((f.store.held.get(SIZE_INDEX) as { pending?: string } | undefined)?.pending).toBe('classifier')
  expect(f.mutations.filter(key => key === 'classifier')).toEqual([])
  expect(f.control.heldWrite).toBe(0)
  f.assertPreserved()
  f.control.refuseClassifier = false
  expect((await command($, 'classifier on')).text).toBe(ON)
  expect(f.violations).toEqual([])
  expect(f.control.heldWrite).toBe(0)
  f.assertIndexed(true)
})

test('overlapping toggles share the persistence queue', async ($, on) => {
  const f = fixture(on)
  f.control.holdFirst = true
  const first = command($, 'classifier on')
  let second: ReturnType<typeof command> | undefined
  let settled: PromiseSettledResult<Awaited<ReturnType<typeof command>>>[] = []
  try {
    await f.firstEntered
    second = command($, 'classifier off')
    // Existing mock.clock pattern drains runnable work while the first data write stays held.
    await f.clock.advance(0)
    expect(f.events.filter(event => event === 'grant:write')).toHaveLength(1)
    expect(f.events.filter(event => event === 'spawn:write')).toHaveLength(1)
    expect(f.control.classifierEntries).toBe(1)
  } finally {
    f.releaseFirst()
    settled = await Promise.allSettled(second === undefined ? [first] : [first, second])
  }
  expect(settled).toHaveLength(2)
  for (const result of settled) {
    expect(result.status).toBe('fulfilled')
    if (result.status === 'fulfilled') expect([ON, OFF]).toContain(result.value.text)
  }
  expect(f.violations).toEqual([])
  expect(f.events.filter(event => event.endsWith(':write') || event.startsWith('mutate:'))).toEqual([
    'spawn:write', 'grant:write', 'mutate:on', 'release:write',
    'spawn:write', 'grant:write', 'mutate:off', 'release:write',
  ])
  expect(f.control.classifierEntries).toBe(2)
  expect(f.control.heldWrite).toBe(0)
  f.assertIndexed(false)
})
