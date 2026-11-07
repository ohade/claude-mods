// FIXTURE: production adapter and flows, with in-memory engine and mocked helper process.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = process.env.TRACK_REPORT_TEST_ROOT ?? resolve(import.meta.dir, '../..')
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href)
const { diagnose } = await load('hooks/diagnose-flow.ts')
const { sameRecord } = await load('hooks/durable-record.ts')
const { EMPTY_REPORT, openReport, editReport, previewReport } = await load('hooks/report-flow.ts')
const source = readFileSync(resolve(root, 'hooks/register.tsx'), 'utf8')
const transpiler = new Bun.Transpiler({ loader: 'tsx' })

function fixture(initialized: boolean) {
  const ownership: { epoch: number; running?: unknown } = { epoch: 7 }
  const ringOwner: { id?: string } = {}
  const ledger = 'ledger', durability = 'durability', turn = 'turn', activity = 'activity', pending = 'pending', reportForm = 'reportForm'
  const state: Record<string, any> = {}
  const read = async (_engine: unknown, key: string) => state[key]
  const update = async (_engine: unknown, key: string, change: (value: any) => any) => state[key] = change(state[key])
  let duringClaims = () => {}
  let claimCount = 0
  const dependencies: Record<string, any> = {
    ownership, ringOwner, ledger, durability, turn, activity, pending, reportForm, read, update,
    reason: String, switchOwner: () => { throw new Error('unexpected owner transition') },
    observedDisk: async () => undefined, claimStats: async () => { claimCount++; duringClaims(); return [] },
    gateCache: {}, eventRing: [], LOADED_IDENTITY: { loaded: 'fixture' },
    configDir: async () => '/fixture/config', diagnose, sameValue: sameRecord,
  }
  const compile = (start: string, end: string, name: string) => {
    const first = source.indexOf(start), last = source.indexOf(end, first)
    if (first < 0 || last <= first) throw new Error(`missing production span ${name}`)
    return runInNewContext(transpiler.transformSync(source.slice(first, last)) + `\n${name}`, dependencies)
  }
  dependencies.EMPTY_LEDGER = compile('const EMPTY_LEDGER:', '\n', 'EMPTY_LEDGER')
  dependencies.ensureOwner = compile('const ensureOwner =', '// Failure-intake D3:', 'ensureOwner')
  dependencies.diagnosePorts = compile('const diagnosePorts =', 'const reportPorts =', 'diagnosePorts')
  const reportPorts = compile('const reportPorts =', 'const copyReportSession =', 'reportPorts')
  state[ledger] = { ...dependencies.EMPTY_LEDGER, ...(initialized ? { session_id: 'fixture-session' } : {}) }
  state[durability] = {}
  state[turn] = { currentId: null, gatedTurnId: null }
  state[activity] = { isWorking: false, background: [] }
  state[pending] = { inputs: [] }
  state[reportForm] = { ...EMPTY_REPORT }
  const calls: Array<{ argv: string[]; request: any }> = []
  const engine = {
    session: { id: async () => 'fixture-session', cwd: async () => '/fixture/cwd', version: async () => ({ version: 'fixture' }) },
    plugin: { root: '/fixture/plugin' },
    process: { run: async (argv: string[], request: any) => {
      calls.push({ argv, request })
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, draft_id: 'fixture-draft', scope: ['fixture'], note_out: 'valid note', note_changed: false }) }
    } },
  }
  return { ownership, state, calls, engine, reportPorts, ledger, durability, reportForm, claims: () => claimCount, onClaims: (fn: () => void) => { duringClaims = fn } }
}

async function prepare(initialized = false) {
  const f = fixture(initialized)
  const owner = await f.reportPorts(f.engine).owner()
  expect(owner).toBeDefined()
  const ports = f.reportPorts(f.engine, owner)
  await openReport(ports)
  await editReport(ports, owner, 'valid note')
  return { ...f, owner, ports }
}
async function run(f: Awaited<ReturnType<typeof prepare>>) {
  await previewReport(f.ports, f.owner)
  return f.state[f.reportForm]
}
function rejected(f: Awaited<ReturnType<typeof prepare>>, form: any) {
  expect(f.calls).toHaveLength(0)
  expect(form.phase).not.toBe('preview')
}
async function accepted(initialized: boolean) {
  const f = await prepare(initialized)
  const form = await run(f)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.argv).toEqual(['python3', '/fixture/plugin/hooks/bug-report.py', 'preview'])
  expect(JSON.parse(f.calls[0]!.request.stdin).note).toBe('valid note')
  expect(form.phase).toBe('preview')
  expect(form.draftId).toBe('fixture-draft')
  expect(form.noteOut).toBe('valid note')
}

test('initialized owner reaches helper and receives preview', () => accepted(true))
test('fresh pristine owner reaches helper and receives preview', () => accepted(false))
test('null memory owner rejects', async () => {
  const f = await prepare(); f.state[f.durability].memorySession = null
  rejected(f, await run(f))
})
test('unowned ledger with counter drift rejects', async () => {
  const f = await prepare(); f.state[f.ledger] = { ...f.state[f.ledger], nextQuestionId: 2 }
  rejected(f, await run(f))
})
test('unowned ledger with a question row rejects', async () => {
  const f = await prepare()
  f.state[f.ledger] = { ...f.state[f.ledger], nextQuestionId: 2, questions: [{ id: 1, head: 'unowned fixture row', at: 1, turnId: 'prior-turn', status: 'open' }] }
  rejected(f, await run(f))
})
test('foreign owner rejects', async () => {
  const f = await prepare(); f.state[f.ledger] = { ...f.state[f.ledger], session_id: 'foreign-session' }
  rejected(f, await run(f))
})
test('running transition rejects', async () => {
  const f = await prepare(); f.ownership.running = { id: 'other' }
  rejected(f, await run(f))
})
test('stale epoch rejects', async () => {
  const f = await prepare(); f.ownership.epoch++
  rejected(f, await run(f))
})
test('memory owner becomes null during diagnostic collection', async () => {
  const f = await prepare(); f.onClaims(() => { f.state[f.durability].memorySession = null })
  rejected(f, await run(f))
  expect(f.claims()).toBe(1)
})
test('epoch becomes stale during diagnostic collection', async () => {
  const f = await prepare(); f.onClaims(() => { f.ownership.epoch++ })
  rejected(f, await run(f))
  expect(f.claims()).toBe(1)
})
