// SOURCE: R5 local save/resume shell gate, 2026-10-30. Native fixture tests own runtime traces.
// Digests pin b9c2e24's operation/failure bodies with only leading indentation removed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
const between = (text: string, first: string, last: string): string => {
  const start = text.indexOf(first)
  assert.ok(start >= 0, `start anchor exists: ${first}`)
  const end = text.indexOf(last, start + first.length)
  assert.ok(end > start, `end anchor exists: ${last}`)
  return text.slice(start, end)
}
const body = (name: string): string => between(source, `const ${name} = `, '\n}\n')
const digest = (text: string): string => createHash('sha256').update(text.trim().split('\n').map(line => line.trimStart()).join('\n')).digest('hex')
const save = body('saveLedger')
const resume = body('resumeOwned')
assert.ok(save.includes("}, 'writer', saveFailure)"), 'R5 save must use the shared grant with its original failure handler')
assert.ok(resume.includes("}, 'writer', resumeFailure, 'propagate')"), 'R5 resume must share the grant and preserve raw-close rejection')
assert.equal(digest(between(save, '    await recoverSave($, context, id)', "  }, 'writer', saveFailure)")),
  '3edc421f7dd82eba8d910e400b3b36c8ec8ec827c43d95b7a484cc3ca076d0e8', 'R5 save operation and acknowledgement order equal the origin')
assert.equal(digest(between(save, '    // A stale caller', '\n  }\n  let intent')),
  'b8636d7b6d8d183762c6a39dae78377cf06b61cb005352e02acc57f9ffb10e39', 'R5 save failure preserves OwnerChanged before taint, recovery and receipts')
assert.equal(digest(between(save, '    assertOwner(token)', '\n  } catch (error) {').replace('    intent = ', '    const intent = ')),
  '5418728d3ea6f45680abb65ecd62457c3b000f415a24648f4294b0c1320868d3', 'R5 admission and v3 routing equal the origin')
assert.equal(digest(between(resume, '      if (context !== undefined)', '\n    }\n    try {')),
  '0feb394cd510e1ddc27f50d0a1f3f9871f446135cebc5cc0a3ec04a0fa09c4ce', 'R5 resume failure taints, publishes and rethrows the original cause')
assert.ok(save.includes('await saveFailure(error, undefined)\n    return\n  }\n  const session = id'), 'R5 admission errors are handled once, before any legacy grant')
assert.ok(resume.includes('await resumeFailure(error, undefined)\n      return\n    }\n    await inOwnGrant'), 'R5 resume admission errors are handled once, outside the grant')
assert.ok(resume.includes("if (await historyEnabled($) && await resumeRouted($, id) === 'v3') return\n      await ensureWriter($, id)"), 'R5 resume v3 routing stays before the legacy grant')
assert.ok(resume.includes('      await recoverSave($, context, id)\n      await resumeLedger($, context, id)'), 'R5 resume recovers and reloads under the same context')
for (const text of [save, resume]) {
  assert.ok(text.includes('persistence.queue.then(async () => {'), 'R5 native queue is retained')
  assert.ok(text.includes('persistence.queue = run.catch(() => undefined)\n  await run'), 'R5 queue rejection recovery and caller await are retained')
  assert.ok(!text.includes('await acquireLock('), 'R5 operation no longer duplicates acquisition')
  assert.ok(!text.includes('await finishWrite('), 'R5 operation no longer duplicates final completion')
}
const grant = body('inOwnGrant')
assert.ok(grant.includes("rawClose: 'log' | 'propagate' = 'log'"), 'R5 default raw-close behavior stays logged')
assert.ok(grant.includes('if (onFailure !== undefined) {\n      await onFailure(error, context)\n      return\n    }'), 'R5 custom failure is awaited before finally, without a second failure invocation')
assert.ok(grant.indexOf('await onFailure(error, context)') < grant.indexOf('if (context !== undefined) context.tainted = true'), 'R5 caller-specific owner handling precedes default taint')
assert.ok(grant.includes("if (rawClose === 'propagate') await closeLock(lock)\n      else await closeLock(lock).catch"), 'R5 resume raw-close rejection is not swallowed')
console.log('check_persistence_grants: unchanged bodies, failure timing and distinct cleanup policies')
