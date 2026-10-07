import { expect, test } from 'claude-code/testing'

import { freshNumbers, imageNumbers } from '../hooks/numbers.ts'

test("a prompt's own pictures are the numbers it names past the last one seen", () => {
  expect(freshNumbers('compare [Image #1] with [Image #3]', 2)).toEqual([3])
})

test('a slash command names its pasted pictures in the arguments of its expansion', () => {
  const expansion = 'Base directory for this skill: /skills/recall\n\nARGUMENTS: look at these [Image #2] [Image #3]'

  expect(freshNumbers(expansion, 1)).toEqual([2, 3])
})

test('a message sent while Claude works names its picture inside the engine framing', () => {
  const folded = 'The user sent a new message while you were working:\nwhy is it blank? [Image #4]'

  expect(freshNumbers(folded, 3)).toEqual([4])
})

test('a number named twice counts once, in the order first written', () => {
  expect(imageNumbers('[Image #5] then [Image #4] and [Image #5] again')).toEqual([5, 4])
})

test('a row that names no picture has none of its own', () => {
  expect(freshNumbers('an attached file, no tag', 0)).toEqual([])
})
