// FIXTURE: an old transcript read cannot remove rows added or compacted while
// it waited. A confirmed rewind must survive restart.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const old = { id: 1, head: 'Old question', at: 1, turnId: 'old', status: 'open', trackedBy: 'old-call' }
const prepare = (on: any) => {
  const initial = { ...EMPTY, nextQuestionId: 2, questions: [old] }
  const l = atomStore(on, 'ledger', initial)
  atomStore(on, 'turn', { currentId: 'new', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, savedAt: 1, ledger: initial } })
  let session = SESSION
  on('session.id', () => ({ value: session }))
  const proceeded = { count: 0 }
  on('prompt.submit', (_, e) => { proceeded.count++; return { text: e.text, context: e.context } })
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(go => { enter = go })
  const held = new Promise<void>(go => { release = go })
  const reads = { count: 0 }
  on('session.messages', async () => { reads.count++; enter(); await held; return { value: [] } })
  return { l, store, entered, release, reads, proceeded, setSession: (id: string) => { session = id } }
}

test('a stale rewind read keeps a question added while the transcript call waited', async ($, on) => {
  const { l, entered, release } = prepare(on)
  const pending = $.prompt.submit({ text: 'status' })
  await entered
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Added after the read', tool_use_id: 'new-call' } as never)
  release()
  await pending
  expect((l.value as any).questions.map((q: any) => q.head)).toEqual(['Added after the read'])
})

test('compaction during a rewind read prevents dropping the compacted question', async ($, on) => {
  const { l, entered, release } = prepare(on)
  const pending = $.prompt.submit({ text: 'status' })
  await entered
  l.value = { ...l.value, compactedAt: 2 } as any
  release()
  await pending
  expect((l.value as any).questions).toEqual([old])
})

test('a confirmed rewind is saved before the model-bound prompt continues', async ($, on) => {
  const { l, store, entered, release } = prepare(on)
  const pending = $.prompt.submit({ text: 'status' })
  await entered
  release()
  await pending
  expect((l.value as any).questions).toHaveLength(0)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions).toHaveLength(0)
})

test('a refused rewind save blocks the model prompt and retries the same pending save', async ($, on) => {
  const { store, entered, release, proceeded } = prepare(on)
  store.faults.write = 'rewind store unavailable'
  const pending = $.prompt.submit({ text: 'status' })
  await entered
  release()
  const refused = await pending
  expect(proceeded.count).toBe(0)
  expect(refused.drop).toContain('rewind')
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions).toEqual([old])
  store.faults.write = ''
  const retried = await $.prompt.submit({ text: 'status' })
  expect(retried.drop).toBeUndefined()
  expect(proceeded.count).toBe(1)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions).toHaveLength(0)
})

test('a durable rewind clears its pending marker before a later unrelated store refusal', async ($, on) => {
  const { store, entered, release, proceeded } = prepare(on)
  const first = $.prompt.submit({ text: 'status' })
  await entered
  release()
  await first
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions).toHaveLength(0)
  store.faults.write = 'unrelated later store refusal'
  const later = await $.prompt.submit({ text: 'later status' })
  expect(later.drop).toBeUndefined()
  expect(proceeded.count).toBe(2)
})

test('concurrent rewind checks share one transcript observation', async ($, on) => {
  const { entered, release, reads } = prepare(on)
  const first = $.prompt.submit({ text: 'status' })
  await entered
  const second = $.prompt.submit({ text: 'later status' })
  await new Promise(go => setTimeout(go, 20))
  release()
  await Promise.all([first, second])
  expect(reads.count).toBe(1)
})

test('a transcript observation from the old session cannot remove a new-session row', async ($, on) => {
  const { l, entered, release, setSession } = prepare(on)
  const pending = $.prompt.submit({ text: 'status' })
  await entered
  setSession('11111111-2222-4333-8444-555555555555')
  const newer = { ...old, head: 'A new-session row with a reused display id' }
  l.value = { ...l.value, questions: [newer] }
  release()
  await pending
  expect(l.value.questions).toEqual([newer])
})
