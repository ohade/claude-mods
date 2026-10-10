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
const transpiler = new Bun.Transpiler({ loader: 'tsx' })
const compile = (start: string, end: string, name: string) => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert(first >= 0 && last > first, `production function ${name} was not found`)
  return runInNewContext(transpiler.transformSync(source.slice(first, last)) + `\n${name}`, {
    writer, deploymentDriftMessage: () => undefined, Date, Promise, Error,
  })
}
const launch = (argv: readonly string[], cwd?: string) => {
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, TRACK_LOCK_DIR: `${scratch}/locks` } })
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
  env: { get: async () => process.env.HOME },
  fs: { read: async (path: string) => readFileSync(path, 'utf8') },
  ui: { status: () => undefined },
  process: {
    spawn: (request: { argv: string[]; cwd?: string }) => {
      const { child, result } = launch(request.argv, request.cwd)
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
  const acquire = compile('const closeLock =', 'const ensureWriter =', 'acquireLock')
  const session = randomUUID()
  const lease = await acquire(engine, 'lease', session)
  const write = await acquire(engine, 'write', session)
  await write.return({ code: null, signal: 'SIGTERM' })
  await lease.return({ code: null, signal: 'SIGTERM' })
  const renewed = await acquire(engine, 'lease', session)
  await renewed.return({ code: null, signal: 'SIGTERM' })
  console.log('PASS: actual lease, write and reacquisition from a deleted cwd')

  const drift = compile('const checkDeployDrift =', 'export const register:', 'checkDeployDrift')
  await drift(engine)
  assert(runs.length >= 2, 'both main/live Git probes must run')
  for (const result of await Promise.all(runs)) assert.equal(result.exitCode, 0, 'Git probe must succeed from a deleted caller cwd')
  console.log('PASS: actual main/live Git probes from a deleted cwd')
} finally {
  process.chdir(originalCwd)
  for (const child of children) if (child.exitCode === null) child.kill()
  // Keep scratch lock files available for inspection and recoverable cleanup.
  console.log(`Scratch: ${scratch}`)
}
