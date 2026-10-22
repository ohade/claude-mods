// FIXTURE: TRACK-30 review findings, 2026-10-19. A Stop return alone did not
// prove model delivery. Use tool-result context, with a next-prompt fallback.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs } from './kit'
import type { Engine, On } from './kit'
import type { Turn } from '../types'

const prepare = async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Review unfinished work', status: 'pending' }] })
  atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  logs(on)
  const contexts: string[][] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.id', () => ({ value: SESSION }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'File contents', context: ['existing tool context'] }))
  on('classic.Stop', () => ({ additionalContext: ['existing lower context'] }))
  on('prompt.submit', (_, e) => { contexts.push([...(e.context ?? [])]); return { text: e.text } })
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  await $.turn.start({ text: 'Continue agreed work', turnId: 'main-1' } as never)
  return { clock, contexts, ledger }
}

const readFile = ($: Engine, extra: object = {}) => $.tool.call({ tool: 'Read', tool_use_id: 'read-fixture', file_path: '/fixture/file', ...extra } as never)

test('TRACK-30 the first main tool result after five minutes carries one review context', async ($, on) => {
  const f = await prepare($, on)
  await f.clock.advance(299_999)
  expect((await readFile($)).context).toEqual(['existing tool context'])
  await $.turn.start({ text: 'Child task', turnId: 'child-1', agentId: 'worker-1' } as never)
  await f.clock.advance(2)
  const child = await readFile($, { agentId: 'worker-1' })
  expect(child.context).toEqual(['existing tool context'])
  const result = await readFile($)
  expect(result.result).toBe('File contents')
  expect(result.context?.[0]).toBe('existing tool context')
  expect(result.context?.slice(1).join('\n')).toContain('review open steps')
  expect(result.context?.slice(1).join('\n')).toContain('plan:1 (pending)')
  expect((await readFile($)).context).toEqual(['existing tool context'])
})

test('TRACK-30 a genuine next main turn gets its own timed tool-result review', async ($, on) => {
  const f = await prepare($, on)
  await f.clock.advance(300_001)
  expect((await readFile($)).context?.join('\n')).toContain('review open steps')
  await $.turn.start({ text: 'Continue', turnId: 'main-2' } as never)
  expect((await readFile($)).context).toEqual(['existing tool context'])
  await f.clock.advance(300_001)
  expect((await readFile($)).context?.join('\n')).toContain('review open steps')
})

test('TRACK-30 a review reached only at Stop also reaches the next real prompt once', async ($, on) => {
  const f = await prepare($, on)
  await f.clock.advance(300_001)
  const stopped = await $.classic.Stop({ session_id: SESSION, background_tasks: [], stop_hook_active: false } as never)
  expect(stopped.block).toBeUndefined()
  expect(stopped.additionalContext?.[0]).toBe('existing lower context')
  await $.turn.start({ text: 'Next request', turnId: 'main-2' } as never)
  await $.prompt.submit({ text: 'Continue the work', origin: { kind: 'composer' } } as never)
  expect(f.contexts.at(-1)?.join('\n')).toContain('review open steps')
  await $.prompt.submit({ text: 'Continue again', origin: { kind: 'composer' } } as never)
  expect(f.contexts.at(-1)?.join('\n')).not.toContain('review open steps')
})

test('TRACK-30 the registered mark_step tool exposes explicit complete local ownership', async ($, on) => {
  let described: any
  on('tool.register', (_, e) => {
    if (e.name === 'mark_step') described = e
    return { value: { tool: `mcp__track__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ deny: 'no panes here' }))
  logs(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(described.inputSchema.properties.external_owner?.type).toBe('boolean')
  expect(described.description).toContain('external_owner:false')
  expect(described.description).toContain('external_owner:true')
  expect(described.description).toContain('unknown')
})

test('TRACK-30 model-bound guidance declares local scope before launching local workers', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  on('prompt.compose', () => ({ sections: [] }))
  const composed = await $.prompt.compose({ model: 'fixture', promptModel: 'fixture', surfaces: ['terminal'], tools: [], traits: [], outputStyle: null })
  const rule = composed.sections.find(section => section.id === 'track:rule')?.text ?? ''
  expect(rule).toContain('external_owner:false')
  expect(rule).toContain('before launching')
  expect(rule).toContain('external_owner:true')
  expect(rule).toContain('unknown')
})

test('TRACK-30 a denied tool cannot consume the timed main review', async ($, on) => {
  const clock = mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Review work', status: 'pending' }] })
  atomStore(on, 'turn', { currentId: 'main-1', startedAt: 0, gatedTurnId: null })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  logs(on)
  let denied = true
  on('tool.call', { tool: 'Read' }, () => denied ? { deny: 'controlled refusal' } : { result: 'Read completed', context: ['existing tool context'] })
  await clock.advance(300_001)
  const refusal = await readFile($)
  expect(refusal.deny).toBe('controlled refusal')
  expect(refusal.context).toBeUndefined()
  denied = false
  expect((await readFile($)).context?.join('\n')).toContain('review open steps')
})

test('TRACK-30 the Stop fallback rebuilds current rows instead of replaying old row text', async ($, on) => {
  const f = await prepare($, on)
  await f.clock.advance(300_001)
  await $.classic.Stop({ session_id: SESSION, background_tasks: [], stop_hook_active: false } as never)
  f.ledger.value = { ...EMPTY, steps: [{ id: 'plan:2', source: 'plan', subject: 'New current work', status: 'pending' }] }
  await $.turn.start({ text: 'Next request', turnId: 'main-2' } as never)
  await $.prompt.submit({ text: 'Continue current work', origin: { kind: 'composer' } } as never)
  const review = f.contexts.at(-1)?.find(line => line.includes('review open steps')) ?? ''
  expect(review).toContain('plan:2 (pending)')
  expect(review).not.toContain('plan:1')
})
