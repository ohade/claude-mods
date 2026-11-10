// SOURCE: R5 local save/resume shell gate, 2026-10-30. Native fixture tests own runtime traces.
// Admission/failure/resume digests pin b9c2e24. P2.1 split the operation pin into native
// closures and the two imported owners after original/candidate1351 fixtures and port cases passed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// TRACK-46 slice 3 (2026-11-09, Ohad's standing approval): save, resume and the shared grant moved to
// ledger-store.ts as function declarations; every pinned span below is unchanged.
const source = readFileSync(new URL('../../hooks/ledger-store.ts', import.meta.url), 'utf8')
const between = (text: string, first: string, last: string): string => {
  const start = text.indexOf(first)
  assert.ok(start >= 0, `start anchor exists: ${first}`)
  const end = text.indexOf(last, start + first.length)
  assert.ok(end > start, `end anchor exists: ${last}`)
  return text.slice(start, end)
}
const body = (name: string): string => {
  const head = `export async function ${name}(`
  return between(source, head, '\n}\n')
}
const digest = (text: string): string => createHash('sha256').update(text.trim().split('\n').map(line => line.trimStart()).join('\n')).digest('hex')
const save = body('saveLedger')
const resume = body('resumeOwned')
assert.ok(save.includes("}, 'writer', saveFailure)"), 'R5 save must use the shared grant with its original failure handler')
assert.ok(resume.includes("}, 'writer', resumeFailure, 'propagate')"), 'R5 resume must share the grant and preserve raw-close rejection')
// Replaces original operation digest3edc421f7...; runtime ordering/value/error coverage is in
// legacy-save-workflow.test.tsx, check_legacy_save_flow_ports and check_legacy_save_workflow.
assert.equal(digest(between(save, '    await saveLegacy({', "  }, 'writer', saveFailure)")),
  '2d4511d5a185901d409ca980d7e24bca409b5241b072a21b15d3dd345162397b', 'R5 native per-grant capabilities and acknowledgement callback stay frozen')
assert.equal(digest(between(save, '    assertOwner(token)', '\n  } catch (error) {').replace('    intent = ', '    const intent = ')),
  '5418728d3ea6f45680abb65ecd62457c3b000f415a24648f4294b0c1320868d3', 'R5 admission and v3 routing equal the origin')
assert.equal(digest(between(resume, '      if (context !== undefined)', '\n    }\n    try {')),
  // 2026-11-09 (approved by Ohad): replaces 0feb394c... (6a444b3). The Codex-accepted TRACK-46 A7
  // fix (ecd1bb5) keeps a pending outcome's own marker in the unsaved reason; taint, publish and
  // rethrow are unchanged.
  'f3c4507452f8278320f4eb7b98e3b88126f00bb8d6bb4473f3018eca0216ccff', 'R5 resume failure taints, publishes and rethrows the original cause')
assert.ok(resume.includes('await resumeFailure(error, undefined)\n      return\n    }\n    await inOwnGrant'), 'R5 resume admission errors are handled once, outside the grant')
assert.ok(resume.includes("if (await historyEnabled($) && await resumeRouted($, id) === 'v3') return\n      await ensureWriter($, id)"), 'R5 resume v3 routing stays before the legacy grant')
assert.ok(resume.includes('      await recoverSave($, context, id)\n      await resumeLedger($, context, id)'), 'R5 resume recovers and reloads under the same context')
const grant = body('inOwnGrant')
assert.ok(grant.includes("rawClose: 'log' | 'propagate' = 'log'"), 'R5 default raw-close behavior stays logged')
assert.ok(grant.includes('if (onFailure !== undefined) {\n      await onFailure(error, context)\n      return\n    }'), 'R5 custom failure is awaited before finally, without a second failure invocation')
assert.ok(grant.indexOf('await onFailure(error, context)') < grant.indexOf('if (context !== undefined) context.tainted = true'), 'R5 caller-specific owner handling precedes default taint')
assert.ok(grant.includes("if (rawClose === 'propagate') await closeLock(lock)\n      else await closeLock(lock).catch"), 'R5 resume raw-close rejection is not swallowed')
console.log('check_persistence_grants: unchanged bodies, failure timing and distinct cleanup policies')
