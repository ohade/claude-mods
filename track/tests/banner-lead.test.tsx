// FIXTURE: CC-174 lead fixes after the round-2 review. These fail on f8cdf7c.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }

type El = { key?: string; text?: string; type?: string; props: { backgroundColor?: string; color?: string } }

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

const bannerRows = async (ui: { findAll: (q: { type?: string }) => Promise<El[]> }) =>
  (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-'))
const textOf = async (ui: { findAll: (q: { type?: string }) => Promise<El[]> }, key: string) =>
  String((await bannerRows(ui)).find(el => el.key === key)?.text ?? '')
// Terminal columns: CJK and fullwidth characters take two.
const columns = (text: string): number => [...text].reduce((sum, ch) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)

test('a narrow agents row keeps both the step and the task count, dropping the label first', async ($, on) => {
  const ui = await mount($, on, [step(1, 'completed'), step(2, 'in_progress', { delegated: true })], { ...IDLE, tasks: ['t1', 't2'] }, { width: 21 })
  const row = await textOf(ui, 'banner-agents')
  expect(row).toContain('S2')
  expect(row).toContain('tasks 2')
  expect(columns(row.trim())).toBeLessThanOrEqual(21)
})

test('a step count is labelled as steps, apart from the other counts', async ($, on) => {
  const ui = await mount($, on, [1, 2, 3, 4].map(n => step(n, 'waiting')), IDLE, { width: 18 })
  const row = await textOf(ui, 'banner-you')
  expect(row).toContain('steps 4')
  expect(columns(row.trim())).toBeLessThanOrEqual(18)
})

test('an ask dialog in the middle of a main step is not activity unknown', async ($, on) => {
  const ui = await mount($, on, [step(1, 'in_progress')], { ...IDLE, isWorking: true, askCalls: ['ask-1'] })
  const keys = (await bannerRows(ui)).map(row => row.key)
  expect(keys).toContain('banner-you')
  expect(keys).not.toContain('banner-unknown')
})

test('the main turn shows a Working row beside a delegated step even with no main step', async ($, on) => {
  const ui = await mount($, on, [step(1, 'in_progress', { delegated: true })], { ...IDLE, isWorking: true })
  const keys = (await bannerRows(ui)).map(row => row.key)
  expect(keys).toContain('banner-agents')
  expect(keys).toContain('banner-working')
})

test('the collapsed line never drops Unsaved or You while it drops other states', async ($, on) => {
  const ui = await mount(
    $, on,
    [step(1, 'waiting'), step(2, 'in_progress'), step(3, 'in_progress', { delegated: true })],
    { ...IDLE, isWorking: true },
    { unsaved: true, reason: 'quota exhausted', rows: 8, width: 20 },
  )
  const line = await textOf(ui, 'banner-line')
  expect(line).toContain('Unsaved')
  expect(line).toContain('◆')
  expect(line).toMatch(/\+\d/)
  expect(columns(line.trim())).toBeLessThanOrEqual(20)
})

test('the collapsed line keeps the +n of a dropped state at a narrow width', async ($, on) => {
  const ui = await mount(
    $, on,
    [step(1, 'in_progress'), step(2, 'in_progress', { delegated: true }), step(3, 'pending')],
    { ...IDLE, isWorking: true },
    { rows: 8, width: 14 },
  )
  const line = await textOf(ui, 'banner-line')
  expect(line).toContain('+1')
  expect(columns(line.trim())).toBeLessThanOrEqual(14)
})

test('a CJK unsaved reason is cut to the pane in terminal columns', async ($, on) => {
  const ui = await mount($, on, [], IDLE, { unsaved: true, reason: '書き込みに失敗しました', width: 28 })
  const row = await textOf(ui, 'banner-unsaved')
  expect(row).toContain('Unsaved')
  expect(columns(row.trim())).toBeLessThanOrEqual(28)
})
