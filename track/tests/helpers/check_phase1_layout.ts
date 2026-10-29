// FIXTURE: presentation ownership and pure layout invariants; no native/LIVE claim.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { Question } from '../../types'
import type { BannerParts, BannerRow } from '../../hooks/banner-layout'

const modules = {
  'terminal-text': ['segmenter', 'graphemesOf', 'columnsOf', 'wrappedLines', 'fitLines'],
  'pane-layout': ['clampTo', 'windowOf', 'lastStart', 'flowRows', 'buttonWidth', 'clockText', 'questionLabels'],
  'banner-layout': ['composeBanner', 'bannerFits', 'stepCount', 'bannerWords', 'bannerLine', 'collapseBrief', 'collapseSegment', 'collapseLine'],
}
const composition = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
for (const name of Object.keys(modules)) {
  assert.ok(existsSync(new URL(`../../hooks/${name}.ts`, import.meta.url)), `missing presentation boundary: ${name}.ts`)
}
for (const [name, symbols] of Object.entries(modules)) {
  const source = readFileSync(new URL(`../../hooks/${name}.ts`, import.meta.url), 'utf8')
  for (const symbol of symbols) {
    assert.match(source, new RegExp(`^(?:export )?const ${symbol}\\b`, 'm'), `${name} owns ${symbol}`)
    assert.doesNotMatch(composition, new RegExp(`^(?:const|function) ${symbol}\\b`, 'm'), `composition must import ${symbol}`)
  }
  assert.match(composition, new RegExp(`from './${name}'`))
  assert.ok(source.trimEnd().split('\n').length <= (name === 'banner-layout' ? 160 : 100), `${name} stays within its line limit`)
  for (const line of source.match(/^import .*$/gm) ?? []) {
    if (line.startsWith('import type ')) {
      assert.match(line, /from '\.\.\/types'$/)
    } else if (name === 'terminal-text') {
      assert.fail('terminal-text must have no runtime imports')
    } else {
      assert.match(line, name === 'pane-layout' ? /^import \{ visibleQuestions \} from '\.\/pane-order'$/ : /from '\.\/terminal-text'$/)
    }
  }
}
const bannerSource = readFileSync(new URL('../../hooks/banner-layout.ts', import.meta.url), 'utf8')
for (const symbol of ['BannerCount', 'BannerParts', 'BannerRow']) {
  assert.match(bannerSource, new RegExp(`^export type ${symbol}\\b`, 'm'))
  assert.doesNotMatch(composition, new RegExp(`^type ${symbol}\\b`, 'm'))
}
assert.deepEqual([...bannerSource.matchAll(/^export const (\w+)/gm)].map(match => match[1]).sort(), ['bannerLine', 'collapseLine'], 'banner internals remain private')

// Dynamic imports follow the boundary assertions to produce assertion-red on the baseline.
const { columnsOf, wrappedLines, fitLines } = await import('../../hooks/terminal-text')
const { clampTo, windowOf, lastStart, flowRows, buttonWidth, clockText, questionLabels } = await import('../../hooks/pane-layout')
const { bannerLine, collapseLine } = await import('../../hooks/banner-layout')
assert.deepEqual(['e\u0301', '界', '👨‍👩‍👧‍👦', '\u0301', 'abc'].map(columnsOf), [1, 2, 2, 0, 3], 'combining clusters and wide glyphs use terminal columns')
assert.equal(wrappedLines('界界 界', 4), 2, 'wide words wrap at terminal columns')
assert.equal(wrappedLines('abcdef', 2), 3)
assert.equal(wrappedLines('a b c', 3), 2)
assert.equal(fitLines('界界界', 3, 1), '界…', 'reject a one-column wide-glyph implementation')
assert.equal(fitLines('e\u0301e\u0301e\u0301', 2, 1), 'e\u0301…', 'never split a combining cluster')
assert.equal(fitLines('abc', 3, 1), 'abc')
assert.deepEqual([-2, 2, 9].map(value => clampTo(4, value)), [0, 2, 4])
assert.deepEqual(windowOf([2, 3, 1], 4, 0), [0, 1])
assert.deepEqual(windowOf([7, 1], 3, 0), [0, 1], 'a tall first row remains reachable')
assert.deepEqual(windowOf([2, 3], 0, 1), [1, 1])
assert.deepEqual([lastStart([2, 3, 1], 4), lastStart([7, 8], 3), lastStart([], 3)], [1, 1, 0])
assert.equal(flowRows([3, 0, 4, 2], 8, 1), 2)
assert.equal(buttonWidth('q', 'Clear'), 8)
assert.deepEqual([-1, 59_999, 60_000, 3_599_999, 3_660_000].map(clockText), ['<1m', '<1m', '1m', '59m', '1h 01m'])
const question = (id: number, cleared = false): Question => ({ id, head: 'Question', at: 1, turnId: null, status: 'open', ...(cleared ? { cleared: true } : {}) })
const label = questionLabels([question(90, true), question(8), question(42)])
assert.deepEqual([8, '42', 90, 999].map(label), ['Q1', 'Q2', 'Q90', 'Q999'], 'labels follow all uncleared rows, with permanent-id fallback')
const parts = (label: string, brief = label): BannerParts => ({ label, brief, questions: [], steps: [], counts: [] })
assert.deepEqual(bannerLine('', { ...parts('Tasks'), counts: [{ kind: 'tasks', n: 3 }] }, 40), { glyph: '', words: 'Tasks 3' })
assert.deepEqual(bannerLine('', parts('界界'), 3), { glyph: '', words: '界…' })
assert.deepEqual(bannerLine('◆', { ...parts('Waiting for you', 'You'), questions: ['Q1'], steps: ['S1'] }, 15), { glyph: '◆', words: ' You · Q1 · S1' })
const row = (key: string, label: string, brief: string): BannerRow => ({ key: `banner-${key}`, glyph: '', words: label, background: key, glyphColor: 'inverseText', parts: parts(label, brief) })
const rows = [row('working', 'Working on a very long step', 'Work'), row('you', 'Waiting for you', 'You'), row('unsaved', 'Unsaved changes', 'Save')]
const collapsed = collapseLine(rows, 20)
assert.equal(collapsed.words, 'Unsaved · You · Work', 'retain every label when the full line fits exactly')
assert.equal(collapseLine(rows, 19).words, 'Unsaved · You · +1', 'narrowing preserves Unsaved and You before lower-priority rows')
assert.equal(collapsed.background, 'unsaved')
assert.equal(collapsed.key, 'banner-line')
assert.equal(collapseLine([], 10).words, '')
assert.equal(collapseLine([row('idle', 'Idle', 'Idle')], 10).words, '')
console.log('phase1-layout: ownership and layout invariants satisfied (FIXTURE)')
