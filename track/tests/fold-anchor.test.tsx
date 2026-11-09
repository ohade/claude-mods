// FIXTURE: render descriptions. Codex review of the one-line rows, 2026-11-09: unfolding a row at
// the edge of an overflowed region must keep that row in view, and a new plan that reuses a step
// id must start folded even when the old row with that id was unfolded.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const LONG = 'Ohad decision for Codex narrated step 11: may the full suite run four existing unchanged tests that give their own fixture children a temporary home'
const questions = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, head: `${i + 1} ${LONG}`, at: i + 1, turnId: 'turn', status: 'open' }))
const steps = Array.from({ length: 20 }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `${i + 1} ${LONG}`, status: 'pending', sourceId: `plan:old-${i + 1}` }))

type Found = { find: (query: { key: string }) => Promise<unknown> }
const visible = async (ui: Found, keys: string[]) => (await Promise.all(keys.map(async key => ((await ui.find({ key })) === undefined ? undefined : key)))).filter((key): key is string => key !== undefined)

test('unfolding the first visible question of an overflowed region keeps it in view', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 21, questions })
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 22))
  const shown = await visible(ui, questions.map(q => `row-q-${q.id}`))
  expect(shown.length).toBeLessThan(questions.length)
  const edge = Number(shown[0]!.slice('row-q-'.length))
  await ui.press({ key: `x-q-${edge}` })
  expect(await ui.find({ key: `row-q-${edge}` })).toBeDefined()
  await ui.unmount()
})

test('unfolding the last visible step of an overflowed region keeps it in view', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, steps })
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 22))
  const shown = await visible(ui, steps.map(s => `row-s-${s.id}`))
  expect(shown.length).toBeLessThan(steps.length)
  const edge = shown.at(-1)!.slice('row-s-'.length)
  await ui.press({ key: `x-s-${edge}` })
  expect(await ui.find({ key: `row-s-${edge}` })).toBeDefined()
  await ui.unmount()
})

test('a new plan reusing an unfolded step id starts folded', async ($, on) => {
  const held = atomStore(on, 'ledger', { ...EMPTY, steps: [steps[0]!] })
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 40))
  await ui.press({ key: 'x-s-plan:1' })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  expect(await texts()).toContain(steps[0]!.subject)
  held.value = { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: `New plan ${LONG}`, status: 'pending', sourceId: 'plan:new-1' }] }
  held.version += 1
  await ui.redraw()
  const replaced = (await texts()).find(t => t.startsWith('New plan'))
  expect(replaced?.endsWith('…')).toBe(true)
  await ui.unmount()
})
