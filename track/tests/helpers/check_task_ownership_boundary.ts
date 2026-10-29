// FIXTURE: pure cancellation and task ownership rules; no native/LIVE claim.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { Activity, Step } from '../../types'

const cancelBoundary = new URL('../../hooks/cancel-policy.ts', import.meta.url)
const ownershipBoundary = new URL('../../hooks/task-ownership.ts', import.meta.url)
assert.ok(existsSync(cancelBoundary), 'missing ownership boundary: cancel-policy.ts')
assert.ok(existsSync(ownershipBoundary), 'missing ownership boundary: task-ownership.ts')
const composition = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
const cancelSource = readFileSync(cancelBoundary, 'utf8')
const ownershipSource = readFileSync(ownershipBoundary, 'utf8')
for (const [source, symbols, module] of [
  [cancelSource, ['USER_CANCEL', 'USER_REJECT', 'PERMISSION_DENIED', 'withoutLeadingSpace', 'reasonAtStart', 'cancelReasonOf', 'cancelOwner'], 'cancel-policy'],
  [ownershipSource, ['OWNER_CAP', 'launchOwner', 'agentLaunchOwner', 'canFollowUp', 'ownersForLiveSteps', 'rememberOwner', 'rememberLaunch'], 'task-ownership'],
] as const) {
  for (const symbol of symbols) {
    assert.match(source, new RegExp(`^(?:export )?const ${symbol}\\b`, 'm'), `${module} owns ${symbol}`)
    assert.doesNotMatch(composition, new RegExp(`^const ${symbol}\\b`, 'm'), `composition imports ${symbol}`)
  }
  assert.match(composition, new RegExp(`from '\\./${module}'`))
  assert.ok(source.trimEnd().split('\n').length <= 100, `${module} stays within 100 lines`)
  for (const line of source.match(/^import .*$/gm) ?? []) {
    assert.match(line, /^(?:import type \{ (?:Activity, Step|Step) \} from '\.\.\/types'|import \{ norm \} from '\.\/ledger-text')$/)
  }
}
for (const symbol of ['dropFinishedOwners', 'applyCancel']) assert.match(composition, new RegExp(`^const ${symbol}\\b`, 'm'), `${symbol} stays native`)

// Imports follow named boundary assertions so the missing module yields assertion-red.
const { cancelReasonOf, cancelOwner } = await import('../../hooks/cancel-policy')
const { launchOwner, agentLaunchOwner, canFollowUp, ownersForLiveSteps, rememberOwner, rememberLaunch } = await import('../../hooks/task-ownership')
const cancel = "The user doesn't want to take this action right now"
const reject = "The user doesn't want to proceed with this tool use. The tool use was rejected"
assert.equal(cancelReasonOf({ deny: '\uFEFF  Permission to use Bash has been denied', isError: false }), 'refused')
assert.equal(cancelReasonOf({ deny: reject, isError: false }), 'refused')
assert.equal(cancelReasonOf({ text: cancel, isError: false }), undefined)
assert.equal(cancelReasonOf({ text: `\uFEFF \n${cancel}`, result: reject, isError: true }), 'cancelled by you')
assert.equal(cancelReasonOf({ text: 'other', result: reject, isError: true }), 'refused')
assert.equal(cancelReasonOf({ text: `prefix ${cancel}`, isError: true }), undefined)
assert.equal(cancelReasonOf({ deny: cancel, isError: false }), undefined)
assert.equal(cancelReasonOf({ text: 1, result: null, isError: true }), undefined)

const step = (id: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({ id, source: 'plan', subject: `Title ${id}`, status, ...extra })
const main = step('main', 'in_progress', { activeTurnId: 'now' })
const delegated = step('agent', 'in_progress', { activeTurnId: 'now', delegated: true })
const stale = step('stale', 'in_progress', { activeTurnId: 'old' })
const cleared = step('cleared', 'in_progress', { activeTurnId: 'now', cleared: true })
const rows = [main, delegated, stale, cleared]
const rowsBefore = JSON.stringify(rows)
assert.equal(cancelOwner(rows, 'Bash', 'now'), 'main')
assert.equal(cancelOwner(rows, 'Agent', 'now'), undefined)
assert.equal(cancelOwner([delegated], 'Agent', 'now'), 'agent')
assert.equal(cancelOwner([delegated], 'Bash', 'now'), undefined)
assert.equal(cancelOwner(rows, 'Bash', null), undefined)
assert.equal(cancelOwner([stale], 'Bash', 'now'), undefined)
assert.deepEqual(launchOwner(rows, 'now'), [])
assert.deepEqual(launchOwner([main, stale, cleared], 'now'), ['main'])
assert.deepEqual(launchOwner(rows, null), [])
assert.deepEqual(launchOwner([stale], 'now'), [])
assert.deepEqual(agentLaunchOwner(rows, 'now'), ['agent'])
assert.deepEqual(agentLaunchOwner([main], 'now'), ['main'])
assert.deepEqual(agentLaunchOwner([delegated, step('agent2', 'in_progress', { activeTurnId: 'now', delegated: true })], 'now'), [])
assert.deepEqual(agentLaunchOwner(rows, null), [])
assert.deepEqual(agentLaunchOwner([stale], 'now'), [])
const statuses = [step('pending', 'pending'), step('delegated', 'pending', { delegated: true }), step('paused', 'paused'), step('running', 'in_progress'), step('waiting', 'waiting', { delegated: true }), step('done', 'completed', { delegated: true }), step('clear', 'paused', { cleared: true })]
assert.deepEqual(statuses.map(canFollowUp), [false, true, true, true, false, false, false])
const owners = { a: ['pending', 'paused', 'running'], b: ['waiting', 'done', 'clear'], c: ['delegated'] }
const ownersBefore = JSON.stringify(owners)
assert.deepEqual(ownersForLiveSteps(owners, statuses), { a: ['paused', 'running'], c: ['delegated'] })
assert.deepEqual(ownersForLiveSteps(undefined, statuses), {})
assert.equal(JSON.stringify(rows), rowsBefore)
assert.equal(JSON.stringify(owners), ownersBefore)

const activity: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [] }
let owned: Activity = activity
for (let i = 0; i < 65; i++) owned = { ...owned, ...rememberOwner(owned, `task-${i}`, ['main'], [main]) }
assert.equal(owned.ownerOrder?.length, 64)
assert.equal(owned.launchOwners?.length, 64)
assert.equal(owned.owners?.['task-0'], undefined)
assert.deepEqual(owned.ownerOrder?.slice(0, 2), ['task-1', 'task-2'])
assert.deepEqual(owned.ownerOrder?.slice(-2), ['task-63', 'task-64'])
const numbered: Activity = { ...activity, owners: { '2': ['main'], '10': ['main'], x: ['main'] }, ownerOrder: ['10', '2', 'x'] }
const relaunched = rememberOwner(numbered, '10', ['main'], [{ ...main, subject: '  1. HELLO, World!  ' }])
assert.deepEqual(relaunched.ownerOrder, ['2', 'x', '10'])
assert.deepEqual(relaunched.launchOwners, [{ task: '10', steps: [{ id: 'main', subject: 'hello world' }] }])
assert.deepEqual(rememberOwner({ ...activity, ...relaunched }, '10', [], [main]).launchOwners, [])
const identityFull: Activity = { ...activity, owners: { legacy: ['main'] }, ownerOrder: ['legacy'], launchOwners: Array.from({ length: 64 }, (_, i) => ({ task: i === 0 ? 'legacy' : `identity-${i}`, steps: [{ id: 'main', subject: 'title main' }] })) }
const identityBefore = JSON.stringify(identityFull)
const evicted = rememberOwner(identityFull, 'new', ['main'], [main])
assert.equal(evicted.owners?.legacy, undefined, 'identity eviction removes legacy fallback')
assert.equal(evicted.launchOwners?.length, 64)
assert.equal(JSON.stringify(identityFull), identityBefore)
let launches: Activity = activity
for (let i = 0; i < 65; i++) launches = { ...launches, ...rememberLaunch(launches, `task-${i}`) }
assert.equal(launches.launchSeq, 65)
assert.equal(launches.launchNumbers?.length, 64)
assert.deepEqual(launches.launchNumbers?.[0], { task: 'task-1', seq: 2 })
const relaunchedNumber = rememberLaunch(launches, 'task-2')
assert.equal(relaunchedNumber.launchSeq, 66)
assert.deepEqual(relaunchedNumber.launchNumbers?.at(-1), { task: 'task-2', seq: 66 })
assert.equal(relaunchedNumber.launchNumbers?.length, 64)
assert.deepEqual(activity, { isWorking: false, agentCalls: [], askCalls: [], background: [] })
console.log('task-ownership: cancellation and task ownership invariants satisfied (FIXTURE)')
