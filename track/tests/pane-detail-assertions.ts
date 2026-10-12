import { expect } from 'claude-code/testing'
import type { Engine } from './kit'

type PaneUI = Awaited<ReturnType<Engine['ui']['mount']>>
export type DetailKind = 'q' | 's'

// Read only painted source fragments. The counter and controls are separate
// from the subject, so exact reconstruction also detects duplicated previews.
export const detailFragment = async (ui: PaneUI, kind: DetailKind, id: string | number, label: string) => {
  const first = String((await ui.find({ key: `${kind}-text-${id}` }))?.text ?? '')
  expect(first.startsWith(`${label}. `)).toBe(true)
  return first.slice(label.length + 2) + String((await ui.find({ key: `detail-${kind}-${id}` }))?.text ?? '')
}

export const detailPosition = async (ui: PaneUI, kind: DetailKind, id: string | number) => {
  const counter = String((await ui.find({ key: `detail-page-${kind}-${id}` }))?.text ?? '')
  expect(counter).toMatch(/^\d+\/\d+$/)
  const [page, total] = counter.split('/').map(Number)
  expect(page).toBeGreaterThanOrEqual(1)
  expect(total).toBeGreaterThanOrEqual(page)
  return { page: page!, total: total! }
}

export const collectTitlePages = async (ui: PaneUI, kind: DetailKind, id: string | number, label: string, expected: string) => {
  const initial = await detailPosition(ui, kind, id)
  expect(initial.page).toBe(1)
  expect(initial.total).toBeLessThanOrEqual(expected.length + 1)
  for (const action of ['prev', 'next', 'close']) {
    expect((await ui.find({ key: `detail-${action}-${kind}-${id}` }))?.type).toBe('Button')
  }
  const fragments: string[] = []
  for (let page = 1; page <= initial.total; page++) {
    expect(await detailPosition(ui, kind, id)).toEqual({ page, total: initial.total })
    fragments.push(await detailFragment(ui, kind, id, label))
    await ui.press({ key: `detail-next-${kind}-${id}` })
  }
  expect(await detailPosition(ui, kind, id)).toEqual({ page: initial.total, total: initial.total })
  expect(await detailFragment(ui, kind, id, label)).toBe(fragments.at(-1))
  expect(fragments.join('')).toBe(expected)
  return fragments
}
