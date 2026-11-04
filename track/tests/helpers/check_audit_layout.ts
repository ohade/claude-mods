// FIXTURE: truthful pending-save labels and explicit terminal line budgets.
import assert from 'node:assert/strict'
import { collapseLine } from '../../hooks/banner-layout'
import { paneBanner } from '../../hooks/pane-banner-model'
import { fitLines, wrappedLines } from '../../hooks/terminal-text'

const checks: Array<[string, () => void]> = [
  ['an uncertain save must remain pending when banners collapse', () => {
    const { openRows } = paneBanner({
      l: { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] },
      now: { isWorking: true, agentCalls: [], askCalls: [], background: [] },
      questions: [], steps: [], questionLabel: id => `Q${id}`,
      phase: 0, isUnsaved: true, unsavedReason: 'save outcome pending', pendingCause: 'lost_ack', width: 24,
    })
    assert.equal(openRows.length, 2, 'control: both pending save and working banners are present')
    const text = collapseLine(openRows, 24).words
    assert.equal(text.includes('Unsaved'), false, 'pending outcome must not become a definite Unsaved claim')
    assert.equal(text.includes('pending'), true, 'the collapsed banner retains pending meaning')
  }],
  ['explicit line breaks are measured and fitted as terminal lines', () => {
    assert.equal(wrappedLines('a\nb', 80), 2, 'a hard line break starts another terminal line')
    assert.equal(wrappedLines('\n', 80), 2, 'empty hard lines still occupy rows')
    assert.equal(wrappedLines('abcd\nef', 3), 3, 'word wrapping is applied independently within each hard line')
    assert.equal(wrappedLines('界\n😀', 2), 2, 'wide graphemes retain their width across hard lines')
    assert.equal(fitLines('a\nb', 80, 2), 'a\nb', 'text that fits keeps its exact content')
    assert.equal(fitLines('a\nb', 80, 1).includes('\n'), false, 'one fitted line cannot retain a hard line break')
    assert.ok(wrappedLines(fitLines('a\nb', 80, 1), 80) <= 1)
  }],
]
let failures = 0
for (const [name, check] of checks) {
  try { check(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
}
process.exitCode = failures === 0 ? 0 : 1
