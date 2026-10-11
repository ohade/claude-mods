import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

// TRACK-21 (2026-10-11): another session's count pruning deleted a live bucket.
// These checks stay unchanged across the implementation's red/green runs.
test('TRACK-21 preserves other records rather than evicting by count', async ($, on) => {
  const initial: Record<string, unknown> = {}
  for (let i = 1; i <= 24; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    initial[`s:${id}`] = { v: 1, savedAt: i, ledger: EMPTY }
  }
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on, initial)
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  for (const key of Object.keys(initial)) expect(store.held.has(key)).toBe(true)
})

test('TRACK-21 checkpoints current rows after an acknowledged record disappears', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'keep this row', status: 'open', at: 1, turnId: 't1' }], nextQuestionId: 2 })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on)
  const lines = logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const finish = () => $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await finish()
  expect(store.held.has(`s:${SESSION}`)).toBe(true)
  store.held.delete(`s:${SESSION}`)
  await finish()
  expect(store.held.has(`s:${SESSION}`)).toBe(true)
  const saved = store.held.get(`s:${SESSION}`) as { ledger: typeof ledger.value }
  expect(saved.ledger.questions).toEqual(ledger.value.questions)
  expect(lines.some(line => line.includes('stale writer revision'))).toBe(false)
})

test('TRACK-21 startup owns its lease and store lock before reading the bucket', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const modes: string[] = []
  pluginStore(on, {}, 4 * 1024 * 1024, {
    beforeLockSpawn: request => modes.push(request.argv[2]),
    beforeGet: key => {
      if (key === `s:${SESSION}`) {
        expect(modes).toContain('lease')
        expect(modes).toContain('write')
      }
    },
  })
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)
  expect(modes).toContain('lease')
  expect(modes).toContain('write')
})
