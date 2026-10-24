// OS boundary check: execute production functions with actual child processes.
// Engine/store behavior is not exercised here; the native fixture covers saves.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'

const root = resolve(import.meta.dir, '../..')
const source = readFileSync(`${root}/hooks/register.tsx`, 'utf8')
const scratch = mkdtempSync(`${tmpdir()}/track-cwd-check-`)
const deleted = `${scratch}/caller`
const originalCwd = process.cwd()
const children: ReturnType<typeof spawn>[] = []
const runs: Promise<{ exitCode: number | null; stdout: string; stderr: string }>[] = []
const writer = { token: randomUUID() }
// TRACK-39 P1b1: the selected config is owned scratch; HOME stays real for the Git probes.
const config = `${scratch}/config`
const variables: Record<string, string | undefined> = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: config }
// Inherited lock overrides never reach a child, and an unmigrated client still stays in scratch.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'TRACK_LOCK_DIR' && name !== 'TRACK_LOCK_PROTOCOL'))
const spawned: Array<{ argv: readonly string[]; cwd?: string; env?: Record<string, string> }> = []
const transpiler = new Bun.Transpiler({ loader: 'tsx' })
const compile = (start: string, end: string, name: string, dependencies: Record<string, unknown> = {}) => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert(first >= 0 && last > first, `production function ${name} was not found`)
  return runInNewContext(transpiler.transformSync(source.slice(first, last)) + `\n${name}`, {
    writer, deploymentDriftMessage: () => undefined, Date, Promise, Error, ...dependencies,
  })
}
const launch = (argv: readonly string[], cwd?: string, env?: Record<string, string>) => {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...inherited, CLAUDE_CONFIG_DIR: config, ...env } })
  children.push(child)
  const result = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  // Observe failures even if the consumer has not installed its own observer yet.
  void result.catch(() => undefined)
  return { child, result }
}
const engine = {
  plugin: { root },
  clock: { after: (ms: number, go: () => void) => { const timer = setTimeout(go, ms); return { cancel: () => clearTimeout(timer) } } },
  env: { get: async (name: string) => variables[name] },
  fs: { read: async (path: string) => readFileSync(path, 'utf8') },
  ui: { status: () => undefined },
  process: {
    spawn: (request: { argv: string[]; cwd?: string; env?: Record<string, string> }) => {
      spawned.push({ argv: [...request.argv], cwd: request.cwd, ...(request.env !== undefined && { env: { ...request.env } }) })
      const { child, result } = launch(request.argv, request.cwd, request.env)
      const stream = (async function* () {
        try {
          for await (const chunk of child.stdout!) yield { stream: 'stdout', text: chunk.toString() }
          return await result
        } catch (error) {
          // Prefer the spawn error over its secondary stdout-close error.
          await result
          throw error
        } finally {
          if (child.exitCode === null) child.kill()
          await result.catch(() => undefined) // Expected termination or failed spawn during cleanup.
        }
      })()
      return Object.assign(stream, { result })
    },
    run: (argv: string[], init?: { cwd?: string }) => {
      const pending = (async () => {
        const { child, result } = launch(argv, init?.cwd)
        let stdout = '', stderr = ''
        child.stdout!.on('data', chunk => { stdout += chunk.toString() })
        child.stderr!.on('data', chunk => { stderr += chunk.toString() })
        return { exitCode: (await result).code, stdout, stderr }
      })()
      runs.push(pending)
      return pending
    },
  },
}

try {
  // Only this dedicated process changes cwd; the native engine is untouched.
  mkdirSync(deleted)
  process.chdir(deleted)
  rmdirSync(deleted)
  const reason = compile('const reason =', '\n', 'reason')
  const configDir = compile('const configDir =', 'const stepStop =', 'configDir')
  const acquire = compile('const closeLock =', 'const ensureWriter =', 'acquireLock', { configDir, reason })
  const session = randomUUID()
  const lease = await acquire(engine, 'lease', session)
  const write = await acquire(engine, 'write', session)
  await write.return({ code: null, signal: 'SIGTERM' })
  await lease.return({ code: null, signal: 'SIGTERM' })
  const renewed = await acquire(engine, 'lease', session)
  await renewed.return({ code: null, signal: 'SIGTERM' })
  console.log('PASS: actual lease, write and reacquisition from a deleted cwd')

  const drift = compile('const deployDrift =', 'export const register:', 'checkDeployDrift')
  await drift(engine)
  assert(runs.length >= 2, 'both main/live Git probes must run')
  for (const result of await Promise.all(runs)) assert.equal(result.exitCode, 0, 'Git probe must succeed from a deleted caller cwd')
  console.log('PASS: actual main/live Git probes from a deleted cwd')

  // Checked last, so the deleted-cwd and Git checks above still report on an unmigrated client.
  const locks = spawned.filter(request => /\/hooks\/writer-lock\.py$/.test(request.argv[1] ?? ''))
  assert.deepEqual(locks.map(request => request.argv[2]), ['lease', 'write', 'lease'], 'lease, write and reacquired lease each spawn the writer lock')
  for (const request of locks) {
    assert.deepEqual(request.env, { TRACK_LOCK_PROTOCOL: '2', CLAUDE_CONFIG_DIR: config },
      `${request.argv[2]} spawn must pass TRACK_LOCK_PROTOCOL=2 and the resolved CLAUDE_CONFIG_DIR`)
    assert.equal(request.cwd, root, `${request.argv[2]} spawn must run from the plugin root`)
  }
  console.log('PASS: protocol 2 and the resolved config reach every writer-lock spawn')
} finally {
  process.chdir(originalCwd)
  for (const child of children) if (child.exitCode === null) child.kill()
  // Keep scratch lock files available for inspection and recoverable cleanup.
  console.log(`Scratch: ${scratch}`)
}
