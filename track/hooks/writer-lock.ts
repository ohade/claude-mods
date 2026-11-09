import type { EngineInterface, Timer } from 'claude-code'
import { truncate } from './ledger-text'
import { configDir, writer, reason, noteEvent } from './track-state'
import type { LockStream } from './track-state'

export type WriteGrant = { config: string; token: string; id: string; nonce: string }
export type WriteContext = { stream: LockStream; grant: WriteGrant; phase: 'open' | 'sealed'; tainted: boolean }

export const closeLock = async (stream: LockStream): Promise<void> => { await stream.return({ code: null, signal: 'SIGTERM' }) }
export const guardStates = new WeakMap<LockStream, 'live' | 'closed'>()
export const writeGrants = new WeakMap<LockStream, WriteGrant>()
export async function acquireLock($: EngineInterface, mode: 'lease' | 'write' | 'guard', session: string): Promise<LockStream> {
  const config = await configDir($)
  if (!config?.startsWith('/')) throw new Error('writer lock configuration unavailable')
  // The caller's worktree may have been removed while this session stayed open.
  const stream: LockStream = $.process.spawn({ argv: ['python3', `${$.plugin.root}/hooks/writer-lock.py`, mode, session, writer.token], cwd: $.plugin.root,
    env: { TRACK_LOCK_PROTOCOL: '2', CLAUDE_CONFIG_DIR: config } })
  // return() closes a live stream by design, so its result rejects on normal cleanup.
  void stream.result.catch(() => undefined)
  let deadline: Timer | undefined
  try {
    const reading = (async () => {
      let output = ''
      let received = 0
      while (true) {
        const chunk = await stream.next()
        if (chunk.done) throw new Error('writer lock returned no receipt')
        received += encodeURIComponent(chunk.value.text).replace(/%[0-9A-F]{2}/g, 'x').length
        if (received > 4096) throw new Error('writer lock receipt exceeded its limit')
        if (chunk.value.stream !== 'stdout') continue
        output += chunk.value.text
        try { return JSON.parse(output) as { ok?: boolean; protocol?: number; reason?: string; token?: string; mode?: string; state?: string; transaction?: { id?: unknown; nonce?: unknown } } | null }
        catch { /* A stdout chunk may end inside the JSON receipt. */ }
      }
    })()
    const expired = new Promise<never>((_, reject) => {
      deadline = $.clock.after(mode === 'guard' ? 1000 : 4000, () => reject(new Error('writer lock receipt timed out')))
    })
    const receipt = await Promise.race([reading, expired])
    if (receipt?.ok !== true || receipt.protocol !== 2 || receipt.token !== writer.token || receipt.mode !== mode) throw new Error(receipt?.reason ?? 'writer lock receipt is incompatible')
    if (mode === 'write') {
      const transaction = receipt.transaction
      if (typeof transaction?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transaction.id) ||
          typeof transaction.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(transaction.nonce)) throw new Error('writer lock transaction is incompatible')
      writeGrants.set(stream, { config, token: receipt.token, id: transaction.id, nonce: transaction.nonce })
    }
    if (mode === 'guard') {
      if (receipt.state !== 'closed' && receipt.state !== 'live') throw new Error('target lease state is unknown')
      guardStates.set(stream, receipt.state)
    }
    return stream
  } catch (error) {
    // A pending next() can also stall return() in the transport. Start child
    // termination, but do not hold the store lock waiting for an unknown guard.
    if (mode === 'guard') void closeLock(stream).catch(cleanup => $.ui.log(`track: timed-out guard release failed: ${reason(cleanup)}`, { to: 'debug' }))
    else await closeLock(stream).catch(() => undefined)
    throw error
  } finally {
    deadline?.cancel()
  }
}
export const writeContext = (stream: LockStream): WriteContext => {
  const grant = writeGrants.get(stream)
  if (grant === undefined) throw new Error('writer lock transaction is unavailable')
  return { stream, grant: { ...grant }, phase: 'open', tainted: false }
}
export const assertWriteOpen = (context: WriteContext): void => {
  if (context.phase === 'open') return
  context.tainted = true
  throw new Error('writer transaction is sealed')
}
// Taint survives caught errors and successful rollback. An open, tainted
// transaction may still repair its writes, but can never request completion.
export const transactionOperation = async <T,>(context: WriteContext, operation: () => Promise<T>): Promise<T> => {
  assertWriteOpen(context)
  try { return await operation() }
  catch (error) { context.tainted = true; throw error }
}
// Resolves true only after the acknowledgement and normal exit; callers that
// need no proof of completion ignore the value.
export async function finishWrite($: EngineInterface, context: WriteContext): Promise<boolean> {
  const { stream, grant } = context
  let deadline: Timer | undefined
  let confirmed = false
  try {
    assertWriteOpen(context)
    context.phase = 'sealed'
    if (context.tainted) return false
    // The request is the last durable action. Its own write is awaited before
    // starting the acknowledgement/normal-exit deadline.
    await $.fs.write(`${grant.config}/state/track/locks/tx/${grant.id}.${grant.nonce}.complete`, grant.nonce)
    const reading = (async () => {
      let output = ''
      let received = 0
      let acknowledged = false
      while (true) {
        const chunk = await stream.next()
        if (chunk.done) {
          if (!acknowledged || chunk.value.code !== 0 || chunk.value.signal !== null) throw new Error('writer completion needs its acknowledgement and normal exit')
          return
        }
        received += new TextEncoder().encode(chunk.value.text).length
        if (received > 4096) throw new Error('writer completion receipt exceeded its limit')
        if (chunk.value.stream !== 'stdout') continue
        output += chunk.value.text
        let receipt: { ok?: unknown; protocol?: unknown; mode?: unknown; token?: unknown; transaction?: { id?: unknown; nonce?: unknown } } | null
        try { receipt = JSON.parse(output) }
        catch { continue } // A stdout chunk may end inside the JSON receipt.
        if (acknowledged || receipt?.ok !== true || receipt.protocol !== 2 || receipt.mode !== 'completed' || receipt.token !== grant.token ||
            receipt.transaction?.id !== grant.id || receipt.transaction.nonce !== grant.nonce) throw new Error('writer completion receipt is incompatible')
        acknowledged = true
        output = ''
      }
    })()
    const expired = new Promise<never>((_, reject) => {
      deadline = $.clock.after(2000, () => reject(new Error('writer completion timed out')))
    })
    await Promise.race([reading, expired])
    confirmed = true
  } catch (error) {
    context.tainted = true
    $.ui.log(`track: completion-unconfirmed: ${truncate(reason(error), 200)}`, { to: 'debug' })
    noteEvent($, 'writer.completion_unconfirmed')
  } finally {
    deadline?.cancel()
    // return() also cancels a pending next() on a failed acknowledgement.
    // Its cancellation result is never evidence that the helper exited normally.
    await closeLock(stream).catch(error => {
      $.ui.log(`track: writer lock cleanup failed: ${truncate(reason(error), 200)}`, { to: 'debug' })
      noteEvent($, 'writer.lock_cleanup_failed')
    })
  }
  return confirmed
}
export async function ensureWriter($: EngineInterface, session: string): Promise<void> {
  if (writer.session === session && writer.lease !== null) return
  const previous = writer.lease
  writer.lease = null
  writer.session = ''
  if (previous !== null) await closeLock(previous)
  const lease = await acquireLock($, 'lease', session)
  writer.lease = lease
  writer.session = session
  // The helper owns the flock for the lifetime of this stream. An exited
  // helper cannot authorize a later write, even when the session id is equal.
  const ended = () => {
    if (writer.lease !== lease) return
    writer.lease = null
    writer.session = ''
    $.ui.log('track: writer lease ended; the next save must reacquire it', { to: 'debug' })
  }
  // HookStream.result settles only after the iterator reaches its end. Keep
  // reading the live stream so an exit is observed between saving calls.
  void (async () => {
    try {
      for await (const chunk of lease) {
        if (chunk.text.trim() !== '') $.ui.log(`track: writer lease ${chunk.stream}: ${truncate(chunk.text, 200)}`, { to: 'debug' })
      }
    } catch (error) {
      if (writer.lease === lease) {
        $.ui.log(`track: writer lease failed: ${reason(error)}`, { to: 'debug' })
        noteEvent($, 'writer.lease_failed')
      }
    } finally { ended() }
  })()
}
