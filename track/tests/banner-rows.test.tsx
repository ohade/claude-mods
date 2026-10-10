// FIXTURE: CC-174 banner rows. These assert the split banner on unchanged code and must fail
// until the implementation commit. LIVE pixel acceptance is separate.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const BLUE = '#1a73e8'
const GREY = ['#5f6670', '#7a828c', '#979fa9', '#b4bcc6']
const AMBER = ['#7a5410', '#9a6c16', '#bb861d', '#dba126']
const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }

type El = { key?: string; text?: string; type?: string; props: { backgroundColor?: string; color?: string }; children?: Array<{ type?: string; text?: string; props?: { color?: string }; children?: string[] }> }

const draw = async (
  $: any,
  on: any,
  steps: unknown[],
  activity: unknown,
  options: { questions?: unknown[]; unsaved?: boolean; width?: number; rows?: number; phase?: number } = {},
) => {
  atomStore(on, 'ledger', { ...EMPTY, steps, questions: options.questions ?? [] })
  atomStore(on, 'activity', activity)
  atomStore(on, 'durability', { isUnsaved: options.unsaved === true, reason: options.unsaved === true ? 'quota exhausted' : '' })
  atomStore(on, 'pulse', options.phase ?? 0)
  mock.clock(on)

  return $.ui.mount(pane('dock', options.width ?? 80, options.rows ?? 30)) as Promise<{ findAll: (q: { type?: string }) => Promise<El[]> }>
}

const step = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `plan:${n}`, source: 'plan', subject: `step ${n}`, status, ...extra,
})

const rowsOf = async (ui: { findAll: (q: { type?: string }) => Promise<El[]> }) =>
  (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-'))

// The harness keeps keys on boxes. A box's text is its glyph and words joined.
const textOf = (all: El[], key: string) => String(all.find(el => el.key === key)?.text ?? '')

const idsIn = (text: string) => text.match(/S\d+/g) ?? []

test('you alone is a still blue row naming the waiting step, and the ◆ matches it', async ($, on) => {
  const ui = await draw($, on, [step(1, 'waiting')], IDLE)
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-you'])
  expect(rows[0]?.props.backgroundColor).toBe(BLUE)
  const all = await ui.findAll({})
  expect(textOf(all, 'banner-you')).toBe('◆ Waiting on you · S1')
  const marker = all.find(el => el.type === 'Text' && el.text === '◆')
  expect(marker?.props.color).toBe(BLUE)
})

test('you plus working stacks grey above blue and names each step once', async ($, on) => {
  const ui = await draw($, on, [step(1, 'waiting'), step(2, 'in_progress')], { ...IDLE, isWorking: true })
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-working', 'banner-you'])
  expect(rows[0]?.props.backgroundColor).toBe(GREY[0])
  expect(rows[1]?.props.backgroundColor).toBe(BLUE)
  const all = await ui.findAll({})
  expect(textOf(all, 'banner-working')).toContain('Working')
  expect(textOf(all, 'banner-working')).toContain('S2')
  expect(textOf(all, 'banner-you')).toContain('S1')
  const ids = rows.map(row => textOf(all, String(row.key))).join(' ')
  expect(idsIn(ids).filter((id, i, allIds) => allIds.indexOf(id) !== i)).toEqual([])
})

test('you plus agents plus tasks keeps tasks on the amber row and off the waiting step', async ($, on) => {
  const ui = await draw(
    $, on,
    [step(1, 'waiting'), step(2, 'in_progress', { delegated: true })],
    { ...IDLE, tasks: ['t1', 't2'] },
  )
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-agents', 'banner-you'])
  expect(AMBER).toContain(rows[0]?.props.backgroundColor)
  expect(rows[1]?.props.backgroundColor).toBe(BLUE)
  const all = await ui.findAll({})
  const agents = textOf(all, 'banner-agents')
  const you = textOf(all, 'banner-you')
  expect(agents).toContain('Agents')
  expect(agents).toContain('S2')
  expect(agents).toContain('tasks 2')
  expect(agents).not.toContain('agents (')
  expect(you).toContain('S1')
  expect(you).not.toContain('S2')
  expect(idsIn(`${agents} ${you}`).filter((id, i, allIds) => allIds.indexOf(id) !== i)).toEqual([])
})

test('working plus agents shows both rows and no waiting row', async ($, on) => {
  const ui = await draw(
    $, on,
    [step(1, 'in_progress'), step(2, 'in_progress', { delegated: true })],
    { ...IDLE, isWorking: true, background: ['agent-1'] },
  )
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-agents', 'banner-working'])
  const all = await ui.findAll({})
  expect(textOf(all, 'banner-working')).toContain('S1')
  expect(textOf(all, 'banner-agents')).toContain('S2')
  expect(textOf(all, 'banner-you')).toBe('')
})

test('unsaved stays the top row and does not erase you or agents', async ($, on) => {
  const ui = await draw(
    $, on,
    [step(1, 'waiting'), step(2, 'in_progress', { delegated: true })],
    IDLE,
    { unsaved: true },
  )
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-unsaved', 'banner-agents', 'banner-you'])
  const all = await ui.findAll({})
  expect(textOf(all, 'banner-unsaved')).toContain('Unsaved')
  expect(textOf(all, 'banner-unsaved')).toContain('quota exhausted')
  expect(textOf(all, 'banner-you')).toContain('Waiting on you')
  expect(textOf(all, 'banner-agents')).toContain('Agents')
})

test('paused takes the work slot beside waiting on you', async ($, on) => {
  const ui = await draw($, on, [step(1, 'paused'), step(2, 'waiting')], IDLE)
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-paused', 'banner-you'])
  const all = await ui.findAll({})
  expect(textOf(all, 'banner-paused')).toContain('Paused')
  expect(textOf(all, 'banner-you')).toContain('S2')
  expect(textOf(all, 'banner-you')).not.toContain('S1')
})

test('idle alone is one green row and the safe-to-close line', async ($, on) => {
  const ui = await draw($, on, [step(1, 'completed', { startedAt: 1, endedAt: 2 })], IDLE)
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-idle'])
  expect(rows[0]?.props.backgroundColor).toBe('success')
  const all = await ui.findAll({})
  expect(textOf(all, 'banner-idle').trim()).toBe('Idle · Safe to close')
})

test('an ask dialog names its question and a waiting step, question first', async ($, on) => {
  const ui = await draw(
    $, on,
    [step(7, 'waiting')],
    { ...IDLE, askCalls: ['ask-3'] },
    { questions: [
      { id: 1, head: 'still with the model', at: 1, turnId: 't', status: 'open', askedRequestId: 'model-q' },
      { id: 3, head: 'need you', at: 3, turnId: 't', status: 'open', askedRequestId: 'ask-3' },
    ] },
  )
  const all = await ui.findAll({})
  const you = textOf(all, 'banner-you')
  expect(you).toContain('Q2')
  expect(you).toContain('S1')
  expect(you.indexOf('Q2')).toBeLessThan(you.indexOf('S1'))
  expect(you).not.toContain('Q1')
})

test('an ask dialog with no waiting step names the question and invents no step', async ($, on) => {
  const ui = await draw(
    $, on,
    [step(1, 'pending')],
    { ...IDLE, askCalls: ['ask-3'] },
    { questions: [{ id: 3, head: 'need you', at: 3, turnId: 't', status: 'open', askedRequestId: 'ask-3' }] },
  )
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-you'])
  const all = await ui.findAll({})
  const you = textOf(all, 'banner-you')
  expect(you).toContain('Q1')
  expect(you).not.toMatch(/S\d+/)
})

test('a short pane collapses every active state onto one line', async ($, on) => {
  const ui = await draw(
    $, on,
    [step(1, 'waiting'), step(2, 'in_progress')],
    { ...IDLE, isWorking: true },
    { rows: 8 },
  )
  const rows = await rowsOf(ui)
  expect(rows.map(row => row.key)).toEqual(['banner-line'])
  expect(rows[0]?.props.backgroundColor).toBe(BLUE)
  const all = await ui.findAll({})
  const line = textOf(all, 'banner-line')
  expect(line).toContain('Waiting on you')
  expect(line).toContain('Working')
  expect(line).toContain('S1')
  expect(line).toContain('S2')
  expect(line.length).toBeLessThanOrEqual(80)
})

test('a narrow waiting row shows a count instead of the step ids', async ($, on) => {
  const ui = await draw(
    $, on,
    [step(1, 'waiting'), step(2, 'waiting'), step(3, 'waiting'), step(4, 'waiting')],
    IDLE,
    { width: 18 },
  )
  const all = await ui.findAll({})
  const you = textOf(all, 'banner-you')
  expect(you).toContain('You')
  expect(you).not.toMatch(/S\d+/)
  expect(you).toContain('4')
  expect(you.trim().length).toBeLessThanOrEqual(18)
})

test('the you glyph stays still and the agents glyph pulses, never in its row background', async ($, on) => {
  let phase = 0
  atomStore(on, 'ledger', { ...EMPTY, steps: [step(1, 'waiting'), step(2, 'in_progress', { delegated: true })] })
  atomStore(on, 'activity', IDLE)
  atomStore(on, 'durability', { isUnsaved: false, reason: '' })
  on('state.get', { plugin: 'track', key: 'pulse' }, () => ({ value: { value: phase, version: 1 } }))
  mock.clock(on)
  const first = await $.ui.mount(pane('dock', 80, 30))
  const glyph = async (ui: { findAll: (q: { type?: string }) => Promise<El[]> }, key: string) => {
    const row = (await ui.findAll({ type: 'Box' })).find(el => el.key === key)
    const child = row?.children?.find(el => el.type === 'Text')

    return { text: child?.text ?? child?.children?.join('') ?? '', props: { color: child?.props?.color } }
  }
  const you0 = await glyph(first, 'banner-you')
  const agent0 = await glyph(first, 'banner-agents')
  phase = 3
  await first.unmount()
  const later = await $.ui.mount(pane('dock', 80, 30))
  const you3 = await glyph(later, 'banner-you')
  const agent3 = await glyph(later, 'banner-agents')
  expect(you0?.props.color).toBe('inverseText')
  expect(you3?.props.color).toBe('inverseText')
  expect(agent0?.text).toBe('⧗')
  expect(agent3?.text).toBe('⧗')
  expect(agent0?.props.color).toBe('inverseText')
  expect(agent3?.props.color).not.toBe(agent0?.props.color)
  expect(agent0?.props.color).not.toBe('#7a5410')
  expect(agent3?.props.color).not.toBe('#7a5410')
})
