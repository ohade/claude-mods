// Ohad's banner decisions at install review, 2026-10-09: idle with pending steps says how many
// are left, and the banner collapses by whole steps shown, not by lines.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }

type El = { key?: string; text?: string; type?: string; props: Record<string, unknown> }
type Ui = { findAll: (q: { type?: string }) => Promise<El[]>; unmount: () => Promise<void> }

const step = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `plan:${n}`, source: 'plan', subject: `step ${n}`, status, ...extra,
})

const given = (on: any, steps: unknown[], activity: unknown) => {
  atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', activity)
  atomStore(on, 'durability', { isUnsaved: false, reason: '' })
  atomStore(on, 'pulse', 0)
  mock.clock(on)
}
const draw = ($: any, width = 80, rows = 30) => $.ui.mount(pane('dock', width, rows)) as Promise<Ui>
const mount = async ($: any, on: any, steps: unknown[], activity: unknown) => {
  given(on, steps, activity)

  return draw($)
}

const bannerRows = async (ui: Ui) => (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-'))
const textOf = async (ui: Ui, key: string) => String((await bannerRows(ui)).find(el => el.key === key)?.text ?? '')
// The steps whose first line is drawn: each step's text starts with its number.
const shownSteps = async (ui: Ui, count: number) => {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  return Array.from({ length: count }, (_, i) => `S${i + 1}. `).filter(head => texts.some(t => t.includes(head))).length
}

test('idle with pending steps says how many are left instead of safe to close', async ($, on) => {
  const ui = await mount($, on, [step(1, 'completed', { startedAt: 1, endedAt: 2 }), step(2, 'pending'), step(3, 'pending')], IDLE)
  expect((await textOf(ui, 'banner-idle')).trim()).toBe('Idle · 2 pending')
})

test('idle with one pending step uses the same words', async ($, on) => {
  const ui = await mount($, on, [step(1, 'pending')], IDLE)
  expect((await textOf(ui, 'banner-idle')).trim()).toBe('Idle · 1 pending')
})

test('idle with only finished steps still says safe to close', async ($, on) => {
  const ui = await mount($, on, [step(1, 'completed', { startedAt: 1, endedAt: 2 })], IDLE)
  expect((await textOf(ui, 'banner-idle')).trim()).toBe('Idle · Safe to close')
})

test('a stacked banner always leaves min(3, steps) whole steps in view, even when steps wrap', async ($, on) => {
  const long = 'a step whose subject is long enough to wrap onto a second line'
  const steps = [
    step(1, 'waiting', { subject: long }),
    step(2, 'in_progress', { subject: long }),
    step(3, 'pending', { subject: long }),
    step(4, 'pending', { subject: long }),
  ]
  given(on, steps, { ...IDLE, isWorking: true })
  const broken: number[] = []
  let stacked = 0
  for (let rows = 12; rows <= 40; rows++) {
    const ui = await draw($, 40, rows)
    const banners = await bannerRows(ui)
    if (banners.length > 1) {
      stacked++
      if ((await shownSteps(ui, steps.length)) < Math.min(3, steps.length)) broken.push(rows)
    }
    await ui.unmount()
  }
  // The fixture must reach the stacked layout, or the check proves nothing.
  expect(stacked).toBeGreaterThan(0)
  expect(broken).toEqual([])
})
