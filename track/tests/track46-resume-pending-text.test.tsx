// FIXTURE: TRACK-46 A7. A resume that cannot resolve an earlier save request
// does not know whether that save committed. The pane must say the save
// outcome is pending, never that the rows are unsaved. A resume that fails on
// a known refusal stays visibly unsaved.
import { expect, mock, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'
import type { Ledger } from '../types'
import { EMPTY, atomStore, blobPool, logs, pane, pluginStore, trackPrompt } from './kit'
import type { Engine, On } from './kit'

const CONFIG = '/fixture/config'
const SESSION = '46464646-7777-4000-8000-000000000007'
const OTHER = '46464646-7777-4000-8000-0000000000aa'
const KEY = 'plugins--track_inline-a0b48c8b9db0'
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
type El = { key?: string; text?: string; type?: string }

const reply = (response: Record<string, unknown>, exitCode = 0): ProcessRunResult =>
  ({ exitCode, stdout: `${JSON.stringify(response)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const fixture = (on: On, fault: 'resolve-unknown' | 'bind-refused') => {
  const clock = mock.clock(on)
  atomStore<Ledger>(on, 'ledger', structuredClone(EMPTY))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false, autoOpenDone: true })
  atomStore(on, 'activity', IDLE)
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'pulse', 0)
  // The memory last belonged to another session, so the first event resumes SESSION.
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: OTHER } as { isUnsaved: boolean; reason: string; memorySession?: string })
  atomStore(on, 'historyPending' as never, { session_id: SESSION, request_id: 'earlier-save', expect: { absent: true } } as never)
  pluginStore(on, {})
  blobPool(on, { configDir: CONFIG })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.get', { name: /^TRACK_HISTORY_V3$/ }, () => ({ value: '1' }))
  logs(on)
  on('process.run', { argv: /\/hooks\/history\.py$/ }, async (_, event) => {
    const op = event.argv[2]
    if (op === 'bind') {
      return { value: fault === 'bind-refused'
        ? reply({ ok: false, protocol: 3, op, phase: 'precommit', reason: 'fixture bind refused' }, 1)
        : reply({ ok: true, protocol: 3, op, store: KEY }) }
    }
    // The resolve receipt is lost: whether the earlier save committed stays unknown.
    if (op === 'resolve') throw new Error('fixture resolve receipt lost')
    return { value: reply({ ok: true, protocol: 3, op, state: 'absent' }) }
  })
  return { clock, durability }
}

const drive = async <T,>(clock: { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }, call: Promise<T>): Promise<T> => {
  let finished = false
  void call.then(() => { finished = true }, () => { finished = true })
  await clock.settle()
  if (!finished) await clock.advance(10000)
  return call
}

const bannerText = async ($: Engine) => {
  const ui = await $.ui.mount(pane('dock', 100, 30)) as unknown as { findAll: (q: { type?: string }) => Promise<El[]> }
  return String((await ui.findAll({ type: 'Box' })).find(el => el.key === 'banner-unsaved')?.text ?? '')
}

test('A7 a resume with an unresolved earlier save shows the outcome as pending, not unsaved', async ($, on) => {
  const f = fixture(on, 'resolve-unknown')
  await drive(f.clock, trackPrompt($, 'status')).catch(() => undefined)
  expect(f.durability.value.isUnsaved, 'the resume could not confirm the rows').toBe(true)
  const row = await bannerText($)
  expect(row, 'the pane names the pending outcome').toContain('Save outcome pending')
  expect(/unsaved/i.test(row), 'a possibly committed save is never called unsaved').toBe(false)
})

test('A7 control: a resume refused before any commit stays visibly unsaved', async ($, on) => {
  const f = fixture(on, 'bind-refused')
  await drive(f.clock, trackPrompt($, 'status')).catch(() => undefined)
  expect(f.durability.value.isUnsaved).toBe(true)
  const row = await bannerText($)
  expect(row).toContain('Unsaved')
  expect(row).not.toContain('Save outcome pending')
})
