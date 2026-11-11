// FIXTURE: TRACK-46 Phase 2, unit 3 step B. stop-gate.py publishes one permanent claim file per held
// input (publish_input_claim). classic.Stop is skipped on this host some of the time, so the next main
// prompt learns `held` from those files: a regular, non-link file at the input's claim path for this
// session, input id and epoch (or legacy name). None of these fixtures raises classic.Stop.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore } from './kit'
import type { Engine, On } from './kit'
import type { Pending, PendingInput } from '../types'

const CONFIG = '/fixture/config'
const INPUTS = `${CONFIG}/state/track/stop-holds/inputs`
const OTHER = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
const ASKED = 'how was 154 fixed?'
const PLAIN = 'send it now'
const STILL = 'track: still unregistered:'

type StatAnswer = { kind: 'file' | 'directory' | 'other'; isLink: boolean } | 'missing' | 'throw'

const sha256 = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')
// stop-gate.py claim_name: sha256 of the compact JSON [session, turn, kind].
const claimPath = async (claimTurn: string, session = SESSION) => `${INPUTS}/${await sha256(JSON.stringify([session, claimTurn, 'uncovered_input']))}`

const seeded = (id: number, excerpt: string, extra: Partial<PendingInput> = {}): PendingInput =>
  ({ id, head: excerpt, excerpt, textHash: `hash-${id}`, turnId: 'turn-0', ...extra })

const prepare = (on: On, seed: Pending = { inputs: [], nextId: 1 }) => {
  mock.clock(on)
  mock.store(on, {})
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1 })
  const pending = atomStore<Pending>(on, 'pending', seed)
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const context: string[][] = []
  const statted: string[] = []
  // Path -> answer; any other path is missing. `all` answers every path.
  const files = new Map<string, StatAnswer>()
  const stat = { all: undefined as StatAnswer | undefined }
  on('session.id', () => ({ value: SESSION }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : e.name === 'HOME' ? '/fixture/home' : undefined }))
  on('fs.stat', (_, e) => {
    const path = String((e as { path?: unknown }).path)
    statted.push(path)
    const answer = stat.all ?? files.get(path) ?? 'missing'
    if (answer === 'throw') throw new Error('EIO: fixture stat failure')
    if (answer === 'missing') return { deny: `ENOENT: no such file, stat '${path}'` } as never
    return { value: { ...answer, size: 64, mtimeMs: 1 } } as never
  })
  on('prompt.submit', (_, e) => { context.push([...(e.context ?? [])]); return { text: e.text } })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  return { pending, context, statted, files, stat }
}

const ask = ($: Engine, text: string, extra: object = {}) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, ...extra } as never)
const held = (pending: { value: Pending }, id: number) => pending.value.inputs.find(i => i.id === id)?.held
const lastContext = (context: string[][]) => (context.at(-1) ?? []).join('\n')

test('claim present: the next typed prompt names the held input and persists held', async ($, on) => {
  const { pending, context, files } = prepare(on)
  await ask($, ASKED)
  const epoch = pending.value.epoch
  expect(typeof epoch, 'the first input mints the epoch').toBe('string')
  files.set(await claimPath(`input:${epoch}:1`), { kind: 'file', isLink: false })
  await ask($, PLAIN)
  expect(lastContext(context)).toContain(`${STILL} "${ASKED}"`)
  expect(held(pending, 1), 'the claim file marks the input held').toBe(true)
})

test('claim absent: no reminder and held stays unset', async ($, on) => {
  const { pending, context } = prepare(on)
  await ask($, ASKED)
  await ask($, PLAIN)
  expect(lastContext(context)).not.toContain(STILL)
  expect(held(pending, 1)).toBeUndefined()
})

for (const [name, answer] of [['a link', { kind: 'file', isLink: true }], ['a directory', { kind: 'directory', isLink: false }]] as const) {
  test(`wrong file kind: ${name} at the claim path counts as absent`, async ($, on) => {
    const { pending, context, files } = prepare(on)
    await ask($, ASKED)
    const path = await claimPath(`input:${pending.value.epoch}:1`)
    files.set(path, answer)
    await ask($, PLAIN)
    expect(lastContext(context)).not.toContain(STILL)
    expect(held(pending, 1)).toBeUndefined()
  })
}

test("another session's claim for the same input id does not mark it", async ($, on) => {
  const { pending, context, files } = prepare(on)
  await ask($, ASKED)
  files.set(await claimPath(`input:${pending.value.epoch}:1`, OTHER), { kind: 'file', isLink: false })
  await ask($, PLAIN)
  expect(lastContext(context)).not.toContain(STILL)
  expect(held(pending, 1)).toBeUndefined()
})

test('own input: the prompt that adds an input never names it, even with its claim present', async ($, on) => {
  const { pending, context, statted, stat } = prepare(on)
  stat.all = { kind: 'file', isLink: false }
  await ask($, ASKED)
  expect(pending.value.inputs.map(i => i.excerpt)).toEqual([ASKED])
  expect(lastContext(context)).not.toContain(STILL)
  expect(held(pending, 1)).toBeUndefined()
  expect(statted.filter(path => path.startsWith(INPUTS)), 'no other input is waiting, so no file is touched').toEqual([])
})

test('legacy name: an input queued before its epoch is looked up under input:<id>', async ($, on) => {
  const { pending, context, statted, files } = prepare(on, { inputs: [seeded(3, 'legacy one?', { legacy: true })], nextId: 4, epoch: 'E1' })
  const path = await claimPath('input:3')
  files.set(path, { kind: 'file', isLink: false })
  await ask($, PLAIN)
  expect(statted.filter(p => p.startsWith(INPUTS))).toEqual([path])
  expect(lastContext(context)).toContain(`${STILL} "legacy one?"`)
  expect(held(pending, 3)).toBe(true)
})

test('epoch name: a normal input is looked up under input:<epoch>:<id>, lowest id first', async ($, on) => {
  const { pending, context, statted, files } = prepare(on, { inputs: [seeded(5, 'second one?'), seeded(4, 'first one?')], nextId: 6, epoch: 'E1' })
  const first = await claimPath('input:E1:4')
  const second = await claimPath('input:E1:5')
  files.set(second, { kind: 'file', isLink: false })
  await ask($, PLAIN)
  expect(statted.filter(p => p.startsWith(INPUTS))).toEqual([first, second])
  expect(lastContext(context)).toContain(`${STILL} "second one?"`)
  expect(lastContext(context)).not.toContain('"first one?"')
  expect(held(pending, 5)).toBe(true)
  expect(held(pending, 4)).toBeUndefined()
})

test('stat failure: every stat throws and the prompt passes through as today', async ($, on) => {
  const { pending, context, stat } = prepare(on)
  await ask($, ASKED)
  stat.all = 'throw'
  await ask($, PLAIN)
  expect(context).toHaveLength(2)
  expect(lastContext(context)).not.toContain(STILL)
  expect(held(pending, 1)).toBeUndefined()
})

test('a subagent prompt checks no claim file', async ($, on) => {
  const { pending, statted, stat } = prepare(on, { inputs: [seeded(2, 'waiting one?')], nextId: 3, epoch: 'E1' })
  stat.all = { kind: 'file', isLink: false }
  await ask($, PLAIN, { agentId: 'agent-1' })
  expect(statted.filter(p => p.startsWith(INPUTS))).toEqual([])
  expect(held(pending, 2)).toBeUndefined()
})
