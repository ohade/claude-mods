// FIXTURE architecture proof: rendering is separate from native question ownership.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const hook = (name: string) => new URL(`../../hooks/${name}`, import.meta.url)
const view = readFileSync(hook('pane-question-view.tsx'), 'utf8')
// TRACK-46 slice 11 (2026-11-09, Ohad's standing approval): the pane and transcript UI handler bodies
// moved to ui-render.tsx, a native adapter file; the pane drawing is checked there.
const ui = readFileSync(hook('ui-render.tsx'), 'utf8')
assert.doesNotMatch(view, /from ['"](?:\.\/register|claude-code)['"]|\b(?:EngineInterface|Runtime|atom|memberOf|read|update|renderInstances|jump|withdraw|toggleReveal|ledger|opened)\b|\$(?!\{)/, 'question view cannot own native state or capabilities')
assert.match(ui, /const restoreInstance = q\.restoredBy === undefined \? undefined : renderInstances\.get\(`restore:\$\{q\.restoredBy\}`\)/, 'restore host is resolved while rendering')
assert.match(ui, /onPress: \(\) => jump\(\$, \[questionKey \?\? askedAt\], 'start', questionKey, questionKey === undefined \? undefined : restoreInstance\)/, 'Q keeps its captured host')
assert.match(ui, /onPress: \(\) => ready \? jump\(\$, answerIds, 'start', answerKey, answerInstance\) : undefined/, 'A keeps its ready guard and captured host')
assert.match(ui, /onPress: \(\) => toggleReveal\(q\.id, 'q', index\)/)
assert.match(ui, /onPress: \(\) => toggleReveal\(q\.id, 'a', index\)/)
assert.match(ui, /onWithdraw: \(\) => withdraw\(\$, q\.id, l\.session_id\)/, "the ✕ names the session its row was drawn for")
// 2026-11-09 (Ohad chose re-pointing with Codex review): a revealed side wraps at the row's text
// width, which the fold control narrows when the question needs more than one line.
assert.match(ui, /const revealShown = revealRaw !== undefined \? fitLines\(revealRaw, qTextWidth\(q\), revealBudget\) : undefined/)
assert.match(view, /width=\{13\}/)
assert.equal((view.match(/width=\{6\}/g) ?? []).length, 2, 'both marker slots keep width 6')
assert.doesNotMatch(view, /\bdisabled\b/, 'dim controls retain their existing callback semantics')
console.log('pane-question-boundary: rendering and native ownership satisfied (FIXTURE)')
