import { expect, test } from 'bun:test'
import { createPaneLayoutCache } from '../../track/hooks/pane-layout-cache'
import type { RegionLayout } from '../../track/hooks/pane-layout-cache'

const geometry: RegionLayout = {
  qHead: 1, sHead: 1, qRows: 2, sRows: 3, qLast: 0, sLast: 0,
  qStart: 0, qEnd: 1, sStart: 0, sEnd: 1,
}

test('text and effective width own a measurement; pane resize discards old measurements', () => {
  const calls: Array<[string, number]> = []
  const cache = createPaneLayoutCache((text, width) => {
    calls.push([text, width])
    return Math.ceil(text.length / width)
  })
  cache.begin(60)
  expect(cache.lines('abcdefgh', 4)).toBe(2)
  expect(cache.lines('abcdefgh', 4)).toBe(2)
  expect(calls).toEqual([['abcdefgh', 4]])
  expect(cache.lines('abcdefgh', 2)).toBe(4)
  expect(cache.lines('editedabcdefgh', 4)).toBe(4)
  cache.finish()
  cache.begin(60)
  expect(cache.lines('abcdefgh', 4)).toBe(2)
  expect(calls).toHaveLength(3)
  cache.finish()
  cache.begin(17)
  expect(cache.lines('abcdefgh', 4)).toBe(2)
  expect(calls).toHaveLength(4)
})

test('removed content is evicted instead of retained through unbounded edits', () => {
  let calls = 0
  const cache = createPaneLayoutCache(() => ++calls)
  cache.begin(60)
  expect(cache.lines('removed title', 40)).toBe(1)
  cache.finish()
  cache.begin(60)
  cache.lines('replacement title', 40)
  cache.finish()
  cache.begin(60)
  expect(cache.lines('removed title', 40)).toBe(3)
})

test('both banner layouts are reused; changed geometry keys and resize recompute', () => {
  let calls = 0
  const cache = createPaneLayoutCache(() => 1)
  const calculate = () => {
    calls++
    return { ...geometry }
  }
  cache.begin(60)
  const stacked = cache.layout('rows30/banner2', calculate)
  const collapsed = cache.layout('rows30/banner1', calculate)
  cache.finish()
  cache.begin(60)
  expect(cache.layout('rows30/banner2', calculate)).toBe(stacked)
  expect(cache.layout('rows30/banner1', calculate)).toBe(collapsed)
  expect(calls).toBe(2)
  cache.layout('rows20/banner1', calculate)
  expect(calls).toBe(3)
  cache.finish()
  cache.begin(17)
  expect(cache.layout('rows30/banner1', calculate)).not.toBe(collapsed)
  expect(calls).toBe(4)
})
