// Failure-intake feed-site pins (correction round 1, refuter findings M3 and L1): the D6 allowlist is exact.
// save.failed is fed only at the two unsaved-save-failed sites (46b6134 :2098 legacy, :2505 history else branch),
// never on a pending save outcome; stop.nudge is fed at the six listed freshnessNudge callers, never for facts:<kind>.
// FIXTURE: history.py, stop-gate.py and git are stand-ins answering receipts only; the ring is read through diagnose.
import { expect, mock, test } from 'claude-code/testing'
import type { Ledger, StepFreshness } from '../types'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'

const DIAGNOSE = 'mcp__track__diagnose'
const CONFIG = '/fixture/config'
const KEY = 'plugins--track_inline-a0b48c8b9db0'
const DRIVE_MS = 10000
const HEAD = '4'.repeat(40)

const reply = (response: Record<string, unknown>, exitCode = 0) =>
  ({ exitCode, stdout: `${JSON.stringify(response)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
const gitHead = () => ({ value: { exitCode: 0, stdout: `${HEAD}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// M3: a minimal history.py model (bind, read, save, resolve) keyed by session, as in track39-history-v3-rework2.
type SaveMode = 'ok' | 'lost' | 'refused'
const history = (on: On) => {
  const clock = mock.clock(on)
  atomStore<Ledger>(on, 'ledger', { ...structuredClone(EMPTY), session_id: SESSION } as Ledger)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false, autoOpenDone: true })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'pulse', 0)
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: SESSION } as never)
  atomStore(on, 'historyPending', null as never)
  pluginStore(on)
  blobPool(on, { configDir: CONFIG })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('env.get', { name: /^TRACK_HISTORY_V3$/ }, () => ({ value: '1' }))
  const mode = { save: 'ok' as SaveMode }
  const roots = new Map<string, { seq: number; hash: string; text: string; generation: string; checkpoint: unknown; savedAt: number }>()
  const committed = new Set<string>()
  const saves: string[] = []
  on('process.run', { argv: /^git$/ }, () => gitHead())
  on('process.run', { argv: /\/hooks\/history\.py$/ }, async (_, event) => {
    const op = String(event.argv[2])
    const request = JSON.parse(event.init!.stdin!) as Record<string, unknown>
    if (op === 'bind') return { value: reply({ ok: true, protocol: 3, op, store: KEY }) }
    if (op === 'read') {
      const root = roots.get(String(request.session_id))
      return { value: reply(root === undefined ? { ok: true, protocol: 3, op, state: 'absent' }
        : { ok: true, protocol: 3, op, state: 'valid', root: { seq: root.seq, generation: root.generation, checkpoint: root.checkpoint, savedAt: root.savedAt }, root_sha256: root.hash, ledger_text: root.text }) }
    }
    if (op === 'save') {
      saves.push(mode.save)
      if (mode.save === 'lost') throw new Error('fixture history receipt lost before commit')
      if (mode.save === 'refused') return { value: reply({ ok: false, protocol: 3, op, request_id: request.request_id, phase: 'precommit', reason: 'fixture save refused' }, 1) }
      const session = String(request.session_id)
      const seq = (roots.get(session)?.seq ?? 0) + 1
      const text = String(request.ledger_text)
      const root = { seq, generation: String(request.generation), checkpoint: request.checkpoint, savedAt: Number(request.savedAt), text, hash: await digest(`${seq}:${text}`) }
      roots.set(session, root)
      committed.add(String(request.request_id))
      return { value: reply({ ok: true, protocol: 3, op, request_id: request.request_id, seq, root_sha256: root.hash }) }
    }
    if (op === 'resolve') {
      return { value: committed.has(String(request.request_id))
        ? reply({ ok: true, protocol: 3, op, request_id: request.request_id, outcome: 'committed', seq: roots.get(String(request.session_id))!.seq, root_sha256: roots.get(String(request.session_id))!.hash })
        : reply({ ok: false, protocol: 3, op, request_id: request.request_id, phase: 'postcommit', reason: 'fixture outcome unknown' }, 1) }
    }
    return { value: reply({ ok: false, protocol: 3, op, phase: 'precommit', reason: 'fixture op unsupported' }, 1) }
  })
  return { clock, durability, mode, saves }
}

const drive = async <T,>(clock: { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }, call: Promise<T>): Promise<T> => {
  let finished = false
  void call.then(() => { finished = true }, () => { finished = true })
  await clock.settle()
  if (!finished) await clock.advance(DRIVE_MS)
  return call
}
const tool = ($: Engine, name: string, fields: Record<string, unknown> = {}) =>
  $.tool.call({ tool: name, tool_use_id: `toolu_${name}`, ...fields } as never) as Promise<Record<string, unknown>>
const ringOf = (r: Record<string, unknown>): any[] => {
  if (typeof r.result !== 'string') return []
  try { return (JSON.parse(r.result) as { ring?: any[] }).ring ?? [] } catch { return [] }
}

test('[M3] a pending save outcome (HistoryOutcomePending) feeds no save.failed event', async ($, on) => {
  const h = history(on)
  await drive(h.clock, tool($, 'mcp__track__track_steps', { steps: ['A'] }))
  h.mode.save = 'lost'
  await drive(h.clock, tool($, 'mcp__track__track_steps', { steps: ['B'], after: 'plan:1' }))
  expect(h.saves, 'M3: the second save was attempted and its receipt lost').toEqual(['ok', 'lost'])
  expect(String((h.durability.value as { reason: string }).reason).startsWith('save outcome pending'), 'M3: the outcome is pending, not failed').toBe(true)
  const r = await drive(h.clock, tool($, DIAGNOSE))
  expect(typeof r.result, 'M3: a bundle came back').toBe('string')
  expect(ringOf(r).filter(e => e.code === 'save.failed'), 'M3: no save.failed for a pending outcome').toEqual([])
})

test('[M3] an unsaved history save that failed (the :2505 site) still feeds save.failed', async ($, on) => {
  const h = history(on)
  h.mode.save = 'refused'
  await drive(h.clock, tool($, 'mcp__track__track_steps', { steps: ['A'] }))
  expect(h.saves, 'M3: the save was attempted and refused').toEqual(['refused'])
  expect((h.durability.value as { isUnsaved: boolean }).isUnsaved, 'M3: the ledger is unsaved').toBe(true)
  const r = await drive(h.clock, tool($, DIAGNOSE))
  expect(ringOf(r).filter(e => e.code === 'save.failed').map(e => e.meta?.phase), 'M3: the history site feeds save.failed').toEqual(['history'])
})

// L1: a waiting step without a request is a freshness candidate; the claim helper either answers with
// stderr (the facts:<kind> caller, not in the stop.nudge row) or throws (a listed `claim` caller).
const stopWorld = (on: On, helper: 'facts' | 'throw') => {
  mock.clock(on)
  const steps = [{ id: 'plan:1', source: 'plan', subject: 'Review the result', status: 'waiting' }]
  const freshness: StepFreshness = { turnId: 'turn-1', edits: [], bash: [], steps: ['plan:1'], completed: [], waiting: ['plan:1'], held: [], nudged: [] }
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps } as Ledger)
  atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: SESSION } as never)
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  const turn = atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0, freshness } as never)
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on, { classifier: { isOn: false } })
  const env = new Map<string, string>([['CLAUDE_CONFIG_DIR', CONFIG], ['CLAUDE_PLUGIN_ROOT', '/fixture/track']])
  const claims: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('classic.Stop', () => ({}))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('process.run', { argv: /^git$/ }, () => gitHead())
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, () => {
    claims.push(helper)
    if (helper === 'throw') throw new Error('fixture helper unavailable')
    return { value: { exitCode: 0, stdout: '{}', stderr: 'track: fixture fact unavailable', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { turn, claims }
}
const stopOnce = ($: Engine) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [] } as never)
const nudgeCodes = (ring: any[]): string[] => ring.filter(e => e.code === 'stop.nudge').map(e => String(e.meta?.code))

test('[L1] the facts:<kind> caller shows its nudge but feeds no stop.nudge event', async ($, on) => {
  const w = stopWorld(on, 'facts')
  await stopOnce($)
  expect(w.claims, 'L1: the freshness claim ran').toEqual(['facts'])
  const nudged = ((w.turn.value as { freshness?: StepFreshness }).freshness?.nudged ?? []) as string[]
  expect(nudged.some(code => code.startsWith('facts:')), `L1: the facts nudge was shown (${JSON.stringify(nudged)})`).toBe(true)
  const ring = ringOf(await tool($, DIAGNOSE))
  expect(nudgeCodes(ring).filter(code => code.startsWith('facts:')), 'L1: no stop.nudge for the facts caller').toEqual([])
})

test('[L1] a listed caller (claim failed or denied) feeds stop.nudge', async ($, on) => {
  const w = stopWorld(on, 'throw')
  await stopOnce($)
  expect(w.claims, 'L1: the freshness claim ran').toEqual(['throw'])
  const ring = ringOf(await tool($, DIAGNOSE))
  expect(nudgeCodes(ring), 'L1: the claim caller feeds stop.nudge').toContain('claim')
})
