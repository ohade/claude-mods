// FIXTURE: CC-174 correction round 2. These fail on 880525b and lock D1–D6.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const GREY = '#5f6670'
const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }

type El = { key?: string; text?: string; type?: string; props: { backgroundColor?: string; color?: string }; children?: Array<{ type?: string; text?: string; props?: { color?: string } }> }

const step = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `plan:${n}`, source: 'plan', subject: `step ${n}`, status, ...extra,
})

const mount = async ($: any, on: any, steps: unknown[], activity: unknown, options: { width?: number; rows?: number; unsaved?: boolean; reason?: string } = {}) => {
  atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', activity)
  atomStore(on, 'durability', { isUnsaved: options.unsaved === true, reason: options.reason ?? '' })
  atomStore(on, 'pulse', 0)
  mock.clock(on)

  return $.ui.mount(pane('dock', options.width ?? 80, options.rows ?? 30)) as Promise<{ findAll: (q: { type?: string }) => Promise<El[]> }>
}

const bannerText = async (ui: { findAll: (q: { type?: string }) => Promise<El[]> }, key: string) => {
  const row = (await ui.findAll({ type: 'Box' })).find(el => el.key === key)

  return String(row?.text ?? '')
}

for (const width of [18, 19]) {
  test(`one waiting step at width ${width} keeps its id inside the pane`, async ($, on) => {
    const ui = await mount($, on, [step(1, 'waiting')], IDLE, { width })
    const you = await bannerText(ui, 'banner-you')
    expect(you).toContain('You')
    expect(you).toContain('S1')
    expect(you.trim().length).toBeLessThanOrEqual(width)
  })
}

test('a long unsaved reason is cut to the pane', async ($, on) => {
  const reason = 'persistence failure '.repeat(6).trim()
  const ui = await mount($, on, [], IDLE, { unsaved: true, reason, width: 80 })
  const row = await bannerText(ui, 'banner-unsaved')
  expect(row).toContain('Unsaved')
  expect(row.trim().length).toBeLessThanOrEqual(80)
  expect(row).toContain('…')
  expect(row).not.toContain(reason)
})

test('an agent call with a task is named as agents, not as tasks alone', async ($, on) => {
  const ui = await mount($, on, [], { ...IDLE, agentCalls: ['x'], tasks: ['t1'] })
  const row = await bannerText(ui, 'banner-agents')
  expect(row).toContain('Agents')
  expect(row).toContain('tasks 1')
  expect(row).not.toContain('Waiting on tasks')
})

test('a narrow agents row keeps the task count apart from the step', async ($, on) => {
  const ui = await mount(
    $, on,
    [step(1, 'completed'), step(2, 'in_progress', { delegated: true })],
    { ...IDLE, tasks: ['t1', 't2'] },
    { width: 22 },
  )
  const at22 = await bannerText(ui, 'banner-agents')
  expect(at22).toContain('tasks 2')
  expect(at22).not.toMatch(/· 2$/)
  expect(at22.trim().length).toBeLessThanOrEqual(22)
})

test('a wide agents row names the delegated step and the task count apart', async ($, on) => {
  const ui = await mount(
    $, on,
    [step(1, 'completed'), step(2, 'in_progress', { delegated: true })],
    { ...IDLE, tasks: ['t1', 't2'] },
    { width: 40 },
  )
  const at40 = await bannerText(ui, 'banner-agents')
  expect(at40).toContain('S2')
  expect(at40).toContain('tasks 2')
})

test('four banner rows collapse once they would hide a third step', async ($, on) => {
  const ui = await mount(
    $, on,
    [step(1, 'waiting'), step(2, 'in_progress'), step(3, 'in_progress', { delegated: true })],
    { ...IDLE, isWorking: true },
    { unsaved: true, reason: 'quota exhausted', rows: 12 },
  )
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-'))
  expect(rows.map(row => row.key)).toEqual(['banner-line'])
  expect(rows[0]?.props.backgroundColor).toBe('warning')
  const line = String(rows[0]?.text ?? '')
  expect(line).toContain('Unsaved')
  expect(line).toContain('Waiting on you')
  expect(line).toContain('Working')
  expect(line).toContain('Agents')
  expect(line).toContain('S1')
  expect(line).toContain('S2')
  expect(line).toContain('S3')
  expect(line.length).toBeLessThanOrEqual(80)
})

test('the working banner glyph is the row text color, not the row background', async ($, on) => {
  const ui = await mount($, on, [step(1, 'in_progress')], { ...IDLE, isWorking: true })
  const row = (await ui.findAll({ type: 'Box' })).find(el => el.key === 'banner-working')
  const glyph = row?.children?.find(el => el.type === 'Text')
  expect(glyph?.text ?? glyph?.children?.join('')).toBe('◐')
  expect(glyph?.props?.color).toBe('inverseText')
  expect(row?.props.backgroundColor).toBe(GREY)
  expect(glyph?.props?.color).not.toBe(row?.props.backgroundColor)
})
