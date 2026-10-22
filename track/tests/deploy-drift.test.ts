// FIXTURE: real session.start handler, controlled Git/receipt results; no filesystem/process work.
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
const LIVE = 'a'.repeat(40)
const MAIN = 'b'.repeat(40)
const setup = (on: On, main: string, gitError = false, receipt = LIVE, ancestor = true) => {
  const lines: string[] = []
  on('env.get', { name: 'HOME' }, () => ({ value: '/fixture' }))
  on('fs.read', { path: '/fixture/.claude/state/claude-mods-live.json' }, () => ({ value: JSON.stringify({ commit: receipt }) }))
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git') return { deny: 'unexpected process' }
    // Contract pin: the native kit does not actually start a Git process.
    expect(e.init?.cwd).toBe('/fixture/git/claude-mods')
    expect(e.init?.timeoutMs).toBeLessThanOrEqual(2000)
    if (gitError) return { value: { exitCode: 128, stdout: '', stderr: 'fixture git error', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv.includes('merge-base')) return { value: { exitCode: ancestor ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const sha = e.argv.includes('/fixture/git/claude-mods') ? main : LIVE
    return { value: { exitCode: 0, stdout: sha + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_, e) => { if (typeof e.text === 'string') lines.push(e.text); return { value: undefined } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return lines
}

test('main ahead of live produces exactly one status after session start returns', async ($, on) => {
  const clock = mock.clock(on)
  const lines = setup(on, MAIN)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  expect(lines).toEqual([])
  await clock.advance(0)
  expect(lines).toEqual(['claude-mods: main bbbbbbb is not live (live aaaaaaa). Run scripts/land.sh main.'])
})

for (const scenario of ['equal', 'git-error', 'receipt-mismatch', 'divergent'] as const) {
  test(`drift status stays silent for ${scenario}`, async ($, on) => {
    const clock = mock.clock(on)
    const lines = setup(on, scenario === 'equal' ? LIVE : MAIN, scenario === 'git-error', scenario === 'receipt-mismatch' ? MAIN : LIVE, scenario !== 'divergent')
    await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
    await clock.advance(0)
    expect(lines).toEqual([])
  })
}

// A land moves live to main while a session runs; the status set at start
// must not outlive it. Rechecked after a turn only while it shows.
const setupMoving = (on: On, heads: { main: string }) => {
  const statuses: (string | undefined)[] = []
  const calls = { git: 0 }
  on('env.get', { name: 'HOME' }, () => ({ value: '/fixture' }))
  on('fs.read', { path: '/fixture/.claude/state/claude-mods-live.json' }, () => ({ value: JSON.stringify({ commit: LIVE }) }))
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git') return { deny: 'unexpected process' }
    calls.git += 1
    if (e.argv.includes('merge-base')) return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const sha = e.argv.includes('/fixture/git/claude-mods') ? heads.main : LIVE
    return { value: { exitCode: 0, stdout: sha + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_, e) => { statuses.push(typeof e.text === 'string' ? e.text : undefined); return { value: undefined } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  return { statuses, calls }
}

const endTurn = async ($: Parameters<TestBody>[0]) => {
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' }).catch(() => undefined)
}

test('the drift status clears after a turn once live has caught up with main', async ($, on) => {
  const clock = mock.clock(on)
  const heads = { main: MAIN }
  const { statuses } = setupMoving(on, heads)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(statuses).toEqual(['claude-mods: main bbbbbbb is not live (live aaaaaaa). Run scripts/land.sh main.'])

  // Landed: live now equals main.
  heads.main = LIVE
  await endTurn($)
  await clock.advance(0)
  expect(statuses.at(-1)).toBeUndefined()
  expect(statuses).toHaveLength(2)
})

test('with no drift at start a turn runs no further check', async ($, on) => {
  const clock = mock.clock(on)
  const { statuses, calls } = setupMoving(on, { main: LIVE })
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const atStart = calls.git

  await endTurn($)
  await clock.advance(0)
  expect(calls.git).toBe(atStart)
  expect(statuses.filter(one => one !== undefined)).toEqual([])
})
