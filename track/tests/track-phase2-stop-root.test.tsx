// FIXTURE: LIVE row-0 host condition, 2026-10-26: env root is unset; SDK plugin.root is available.
// The probe serializes the SDK's undefined unset value as null.
// This models the two hook receipts over one claim set. Python tests cover real claim files;
// the LIVE probe proves the actual host failure. This file is not LIVE evidence.
import { expect, mock, test } from 'claude-code/testing'
import type { Ledger, Pending, StepFreshness, Turn } from '../types'
import type { Engine, On } from './kit'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'

const CONFIG = '/fixture/config'
const COMMAND_REASON = 'track: command hook claimed the uncovered fixture input'
const FRESHNESS_REASON = 'track: waiting step needs its request'
type Snapshot = { inputs?: Array<{ id: number; reason: string }>; inputs_complete?: boolean; candidates?: Array<{ kind: string }> }
const prepare = (on: On, kind: 'input' | 'freshness') => {
  mock.clock(on)
  const steps: Ledger['steps'] = kind === 'freshness'
    ? [{ id: 'plan:1', source: 'plan', subject: 'Review the result', status: 'waiting' }] : []
  const fresh: StepFreshness = { turnId: 'turn-1', edits: [], bash: [], steps: steps.map(row => row.id),
    waiting: steps.map(row => row.id), completed: [], held: [], nudged: [] }
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps })
  const pending = atomStore<Pending>(on, 'pending', { nextId: 2, inputs: kind === 'input' ? [
    { id: 1, head: 'Why does Stop block twice?', excerpt: 'Why does Stop block twice?', textHash: 'row0-input', turnId: 'turn-1' },
  ] : [] })
  atomStore<Turn>(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, freshness: fresh })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const product = { root: undefined as string | undefined }
  // Capture the product root independently from an existing metadata-root caller.
  pluginStore(on, {}, undefined, { beforeLockSpawn: request => {
    const helper = String(request.argv[1] ?? '')
    const root = helper.slice(0, -'/hooks/writer-lock.py'.length)
    expect(helper.endsWith('/hooks/writer-lock.py') && root.startsWith('/') && request.cwd === root).toBe(true)
    expect(product.root === undefined || product.root === root).toBe(true)
    product.root = root
  } })
  blobPool(on, { configDir: CONFIG })
  logs(on)
  // No CLAUDE_PLUGIN_ROOT or HOME: env.get uses the SDK's undefined-for-unset contract.
  const env = new Map<string, string>([['CLAUDE_CONFIG_DIR', CONFIG]])
  const claims = new Set<number>()
  const command = { stops: 0, writes: 0 }
  const calls: Array<{ argv: readonly string[]; snapshot: Snapshot }> = []
  on('session.id', () => ({ value: SESSION }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('classic.Stop', () => {
    command.stops++
    if (kind === 'input' && !claims.has(1)) {
      claims.add(1)
      command.writes++
      return { block: COMMAND_REASON }
    }
    return {}
  })
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, (_, e) => {
    const snapshot = JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}') as Snapshot
    calls.push({ argv: e.argv, snapshot })
    expect(product.root).toBeDefined()
    expect(e.argv).toEqual(['python3', `${product.root}/hooks/stop-gate.py`, '--claim'])
    expect(e.init?.env?.CLAUDE_CONFIG_DIR).toBe(CONFIG)
    expect(JSON.parse(e.init?.stdin ?? '{}')).toMatchObject({ session_id: SESSION })
    if (kind === 'input') {
      expect(snapshot.inputs?.map(row => row.id)).toEqual([1])
      expect(snapshot.inputs_complete).toBe(true)
      expect(claims.has(1)).toBe(true)
    } else {
      expect(Object.hasOwn(snapshot, 'inputs')).toBe(false)
      expect(Object.hasOwn(snapshot, 'inputs_complete')).toBe(false)
      expect(snapshot.candidates).toEqual([{ kind: 'missing_waiting_request', id: 'plan:1' }])
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(kind === 'input' ? {} : { decision: 'block', reason: FRESHNESS_REASON }),
      stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { pending, product, claims, command, calls }
}
const stop = ($: Engine, active: boolean) => $.classic.Stop({ session_id: SESSION, stop_hook_active: active, background_tasks: [] } as never)
const captureRoot = async ($: Engine, fixture: ReturnType<typeof prepare>) => {
  // The normal checkpoint path reaches writer-lock.py through $.plugin.root.
  await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION, tool_use_id: 'row0-root-proof' } as never)
  expect(fixture.product.root?.startsWith('/')).toBe(true)
}

test('row 0 input: a null env root still meets the command claim through SDK plugin.root on Stop 2', async ($, on) => {
  const fixture = prepare(on, 'input')
  await captureRoot($, fixture)
  expect((await stop($, false)).block).toBe(COMMAND_REASON)
  expect(fixture.command.writes).toBe(1)
  expect([...fixture.claims]).toEqual([1])
  expect(fixture.calls).toHaveLength(0)
  expect((await stop($, true)).block).toBeUndefined()
  expect(fixture.command.stops).toBe(2)
  expect(fixture.calls).toHaveLength(1)
  expect(fixture.pending.value.inputs[0]?.held).toBe(true)
  expect(fixture.command.writes).toBe(1)
  expect([...fixture.claims]).toEqual([1])
})

test('row 0 freshness: a null env root still invokes the shared helper through SDK plugin.root', async ($, on) => {
  const fixture = prepare(on, 'freshness')
  await captureRoot($, fixture)
  expect((await stop($, true)).block).toBe(FRESHNESS_REASON)
  expect(fixture.calls).toHaveLength(1)
  expect((await stop($, true)).block).toBeUndefined()
  expect(fixture.calls).toHaveLength(1)
})
