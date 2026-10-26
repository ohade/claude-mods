// FIXTURE: refuter r1 rows for the A1 history client. A save whose outcome is unknown never reads as
// "unsaved" on any public surface; a pane preference refused after a committed root keeps the rows
// acknowledged; an unreadable TRACK_HISTORY_V3 never sends a bound v3 session to the legacy store.
// The history.py model here is minimal: bind, read and save with a per-call fault schedule.
import { expect, mock, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'
import type { Ledger } from '../types'
import { EMPTY, atomStore, blobPool, logs, pluginStore, trackPrompt } from './kit'
import type { Engine, On } from './kit'

const CONFIG = '/fixture/config'
const SESSION = '39393939-1111-4000-8000-000000000001'
const KEY = 'plugins--track_inline-a0b48c8b9db0'
const DRIVE_MS = 10000

type Options = { ledger?: Ledger; rejectSave?: (ordinal: number) => boolean; durability?: Record<string, unknown>; refuseSet?: (key: string) => string | undefined }

const reply = (response: Record<string, unknown>, exitCode = 0): ProcessRunResult =>
  ({ exitCode, stdout: `${JSON.stringify(response)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')

const fixture = (on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', structuredClone(options.ledger ?? EMPTY))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false, autoOpenDone: true })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '', ...options.durability } as { isUnsaved: boolean; reason: string; closedByPerson?: boolean })
  atomStore(on, 'historyPending' as never, null)
  const store = pluginStore(on, {}, undefined, { refuseSet: options.refuseSet })
  blobPool(on, { configDir: CONFIG })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const flag = { value: '1' as string | undefined, throws: false }
  on('env.get', { name: /^TRACK_HISTORY_V3$/ }, () => {
    if (flag.throws) throw new Error('fixture env read failed')
    return { value: flag.value }
  })
  const lines = logs(on)
  const model = { root: undefined as undefined | { seq: number; generation: string; checkpoint: unknown; savedAt: number; text: string; hash: string } }
  const saves: Array<Record<string, unknown>> = []
  on('process.run', { argv: /\/hooks\/history\.py$/ }, async (_, event) => {
    const op = event.argv[2]
    const request = JSON.parse(event.init!.stdin!) as Record<string, unknown>
    if (op === 'bind') return { value: reply({ ok: true, protocol: 3, op, store: KEY }) }
    if (op === 'read') {
      const root = model.root
      return { value: reply(root === undefined ? { ok: true, protocol: 3, op, state: 'absent' }
        : { ok: true, protocol: 3, op, state: 'valid', root: { seq: root.seq, generation: root.generation, checkpoint: root.checkpoint, savedAt: root.savedAt }, root_sha256: root.hash, ledger_text: root.text }) }
    }
    if (op === 'save') {
      saves.push(request)
      if (options.rejectSave?.(saves.length) === true) throw new Error('fixture history receipt lost before commit')
      const seq = (model.root?.seq ?? 0) + 1
      const text = String(request.ledger_text)
      model.root = { seq, generation: String(request.generation), checkpoint: request.checkpoint, savedAt: Number(request.savedAt), text, hash: await digest(`${seq}:${text}`) }
      return { value: reply({ ok: true, protocol: 3, op, request_id: request.request_id, seq, root_sha256: model.root.hash }) }
    }
    return { value: reply({ ok: false, protocol: 3, op, phase: 'precommit', reason: 'fixture op unsupported' }, 1) }
  })
  return { clock, ledger, durability, store, lines, model, saves, flag }
}
type Fixture = ReturnType<typeof fixture>

const drive = async <T,>(f: Fixture, call: Promise<T>): Promise<T> => {
  let finished = false
  void call.then(() => { finished = true }, () => { finished = true })
  await f.clock.settle()
  if (!finished) await f.clock.advance(DRIVE_MS)
  return call
}
const call = ($: Engine, tool: string, fields: Record<string, unknown>) => $.tool.call({ tool: `mcp__track__${tool}`, ...fields } as never)
const text = (result: { result?: unknown; context?: unknown; deny?: unknown }) => `${String(result.result ?? '')}\n${String(result.deny ?? '')}\n${(Array.isArray(result.context) ? result.context : []).join('\n')}`
const stepLabels = (ledger: string | undefined) => ledger === undefined ? [] : (JSON.parse(ledger) as Ledger).steps.map(step => step.subject)

test('TRACK-39 V3 PT1 a pending reorder save never reads as unsaved', async ($, on) => {
  const f = fixture(on, { rejectSave: ordinal => ordinal === 2 })
  await drive(f, call($, 'track_steps', { steps: ['A', 'B'] }))
  expect(f.saves.length, 'PT1: the first save committed').toBe(1)
  const result = await drive(f, call($, 'reorder_steps', { ids: ['plan:2', 'plan:1'] }))
  const shown = text(result as never)
  expect(f.saves.length, 'PT1: the reorder attempted one save').toBe(2)
  expect(shown.includes('save outcome pending'), 'PT1: reorder reports the pending outcome').toBe(true)
  expect(/unsaved/i.test(shown), 'PT1: reorder text never says unsaved for a pending outcome').toBe(false)
  expect(f.lines.filter(line => /unsaved/i.test(line)), 'PT1: no unsaved log or toast').toEqual([])
})

test('TRACK-39 V3 PT2 a pending rewind save never reads as unsaved in the prompt drop', async ($, on) => {
  const question = { id: 1, head: 'Old question', at: 1, turnId: 'old', status: 'open', trackedBy: 'old-call' }
  const f = fixture(on, { ledger: { ...EMPTY, session_id: SESSION, nextQuestionId: 2, questions: [question] } as Ledger, rejectSave: () => true })
  const result = await drive(f, trackPrompt($, 'status'))
  expect(f.saves.length > 0, 'PT2: the rewind attempted a history save').toBe(true)
  expect(String(result.drop ?? '').includes('save outcome pending'), 'PT2: the drop reports the pending outcome').toBe(true)
  expect(/unsaved/i.test(String(result.drop ?? '')), 'PT2: the drop never says unsaved for a pending outcome').toBe(false)
})

test('TRACK-39 V3 PT3 a preference refused after a committed root keeps the rows acknowledged', async ($, on) => {
  const f = fixture(on, { durability: { isUnsaved: true, reason: 'pane preference save pending', closedByPerson: true },
    refuseSet: key => key === 'closedByPerson' ? 'fixture preference refused' : undefined })
  const result = await drive(f, call($, 'track_steps', { steps: ['A'] }))
  expect(stepLabels(f.model.root?.text), 'PT3: the root committed the rows').toEqual(['A'])
  expect(/unsaved/i.test(text(result as never)), 'PT3: committed rows are not reported unsaved').toBe(false)
  expect(f.lines.filter(line => /unsaved/i.test(line)), 'PT3: no unsaved log or toast for committed rows').toEqual([])
  expect(f.durability.value.reason.startsWith('pane preference save pending'), 'PT3: only the preference stays pending').toBe(true)
  expect(f.durability.value.closedByPerson, 'PT3: the preference is kept for the next save').toBe(true)
})

test('TRACK-39 V3 PT4 an unreadable flag after a bind never saves a v3 session to the legacy store', async ($, on) => {
  const f = fixture(on)
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  expect(f.saves.length, 'PT4: the flagged save committed').toBe(1)
  f.flag.throws = true
  await drive(f, call($, 'track_steps', { steps: ['B'], after: 'plan:1' }))
  expect(f.store.held.has(`s:${SESSION}`), 'PT4: no legacy body for a bound v3 session').toBe(false)
  expect(f.saves.length, 'PT4: the second save still went to history').toBe(2)
  expect(stepLabels(f.model.root?.text), 'PT4: the root holds both rows').toEqual(['A', 'B'])
  expect(f.lines.some(line => line.includes('TRACK_HISTORY_V3')), 'PT4: the unreadable flag is logged').toBe(true)
})
