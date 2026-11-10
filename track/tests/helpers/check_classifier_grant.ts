// SOURCE: R5's named local transaction-consolidation gate (2026-10-30).
// Runtime success/failure/queue order is pinned separately by track39-client-transactions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// TRACK-46 slice 3 (2026-11-09, Ohad's standing approval): both functions moved to ledger-store.ts
// as function declarations (the engine follows $ across an import only into one); bodies unchanged.
const source = readFileSync(new URL('../../hooks/ledger-store.ts', import.meta.url), 'utf8')
const body = (name: string): string => {
  const start = source.indexOf(`export async function ${name}(`)
  assert.ok(start >= 0, `${name} declaration exists`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `${name} declaration closes`)
  return source.slice(start, end + 2)
}
const classifier = body('saveClassifierSetting')
assert.ok(classifier.includes("await inOwnGrant($, session, context => writeVerified($, context, CLASSIFIER_KEY, { isOn }), 'classifier')"),
  'R5 classifier must use the shared grant lifecycle')
assert.equal(classifier, `export async function saveClassifierSetting($: EngineInterface, isOn: boolean): Promise<void> {
  const run = persistence.queue.then(async () => {
    const session = await $.session.id()
    await ensureWriter($, session)
    await inOwnGrant($, session, context => writeVerified($, context, CLASSIFIER_KEY, { isOn }), 'classifier')
  })
  persistence.queue = run.catch(() => undefined)
  await run
}`, 'R5 classifier keeps native queue, session and writer admission before the shared grant')
const grant = body('inOwnGrant')
assert.ok(grant.includes("cleanupLabel: 'writer' | 'classifier' = 'writer'"), 'R5 shared grant defaults to the existing writer cleanup label')
assert.ok(grant.includes('`track: ${cleanupLabel} lock cleanup failed: ${reason(error)}`'), 'R5 raw-close diagnostic keeps the caller label and original cause')
assert.ok(grant.includes('if (context !== undefined) context.tainted = true\n    throw error'), 'R5 failed work taints its context and rethrows')
assert.ok(grant.includes('if (context !== undefined) await finishWrite($, context)'), 'R5 shared grant retains its existing final completion')
console.log('check_classifier_grant: shared lifecycle and native admission preserved')
