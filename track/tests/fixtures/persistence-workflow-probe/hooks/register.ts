// P2.1 native capability spike, not production transaction acceptance or a verified fix.
// The shell has the production try/work/onFailure/finally shape. It does not replace
// Track's real writer lock; full production grant checks remain a later gate.
// Tier C, agent consumer. /workflowprobe MODE ABSOLUTE_RECEIPT; no args = help.
// Only this disposable plugin's own store/state and the named receipt are written.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { workflow } from './workflow'

declare module 'claude-code' {
  interface PluginState { 'track-workflow-probe': { published: string } }
}

const published = atom({ plugin: 'track-workflow-probe', key: 'published' } as const, '')
type Row = { trigger: string; subject: string; current: string; trace: string[]; value: unknown; atom: string; tainted: boolean; error?: string; started: number; ended: number }
let epoch = 0
let stopPath: string | undefined
let turnPath: string | undefined
let returned = false

const probe = async ($: EngineInterface, trigger: string, path: string, delay = 20, invalid = false, captured?: { subject: string; epoch: number }): Promise<void> => {
  const subject = captured?.subject ?? await $.session.id()
  const admitted = captured?.epoch ?? epoch
  const key = `probe:${subject}:${trigger}`
  const value = `${subject}/${trigger}`
  const trace: string[] = []
  const context = { tainted: false }
  const started = await $.clock.now()
  let error: string | undefined
  const fence = async () => {
    if (epoch !== admitted || await $.session.id() !== subject) throw new Error('OwnerChanged')
  }
  try {
    trace.push('admitted')
    await workflow({
      read: async () => { trace.push('read'); return $.store.get(key) },
      wait: async () => { trace.push('wait'); await $.clock.sleep(delay); trace.push('waited') },
      write: async next => {
        await fence()
        trace.push('write')
        // A real SDK rejection tests error propagation across the imported frame.
        await $.store.set(key, invalid ? () => next : next)
      },
      publish: async next => { await fence(); trace.push('publish'); await update($, published, () => next) },
    }, value)
    trace.push('ack')
  } catch (caught) {
    // Native caller policy, as in saveFailure: OwnerChanged does not taint a new owner.
    error = caught instanceof Error ? caught.message : String(caught)
    trace.push('onFailure')
    if (error !== 'OwnerChanged') context.tainted = true
  } finally {
    trace.push('finishWrite')
    const row: Row = { trigger, subject, current: await $.session.id(), trace, value: await $.store.get(key), atom: await read($, published), tainted: context.tainted, ...(error !== undefined && { error }), started, ended: await $.clock.now() }
    const rows = await $.store.get('rows') as Row[] | undefined
    await $.store.set('rows', [...(rows ?? []), row])
    const receipt = { v: 1, evidence: 'LIVE', scope: 'imported callback capability; probe shell, not production grant acceptance', engine: await $.session.version(), returned, rows: await $.store.get('rows') }
    await $.fs.write(path, JSON.stringify(receipt))
    if (JSON.parse(await $.fs.read(path) as string).rows.length !== (rows?.length ?? 0) + 1) throw new Error('probe receipt read-back differs')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    epoch++
    await $.command.register({ name: 'workflowprobe', description: 'P2.1 disposable callback probe', argumentHint: '<run|stop|turn|old|read|reload> <absolute-receipt>', immediate: true })
    return next(e)
  })
  on('command.run', { command: 'workflowprobe' }, async ($, e) => {
    const match = /^(run|stop|turn|old|read|reload) (\/[^\0\r\n]+)$/.exec(e.args.trim())
    if (match === null) return { text: 'Usage: /workflowprobe <run|stop|turn|old|read|reload> <absolute-receipt>' }
    const mode = match[1]!
    const path = match[2]!
    if (mode === 'read') return { text: JSON.stringify({ subject: await $.session.id(), rows: await $.store.get('rows'), receipt: await $.fs.read(path) }) }
    if (mode === 'reload') {
      const rows = await $.store.get('rows') as Row[] | undefined
      const values = []
      for (const row of rows ?? []) values.push({ subject: row.subject, trigger: row.trigger, value: await $.store.get(`probe:${row.subject}:${row.trigger}`) })
      await $.fs.write(path, JSON.stringify({ evidence: 'LIVE', scope: 'fresh-process durable store read', subject: await $.session.id(), engine: await $.session.version(), values }))
      return { text: `Durable values read and written to ${path}` }
    }
    if (mode === 'stop') { stopPath = path; return { text: 'Stop probe armed for the next real Stop.' } }
    if (mode === 'turn') { turnPath = path; return { text: 'Probe armed for the existing turn.complete event.' } }
    if (mode === 'old') {
      const captured = { subject: await $.session.id(), epoch }
      $.clock.after(10000, () => void probe($, 'old-owner', path, 20, false, captured).catch(error => $.ui.log(String(error), { to: 'debug' })))
      return { text: 'Old-owner probe scheduled; clear this session before ten seconds elapse.' }
    }
    returned = false
    await probe($, 'command', path)
    await probe($, 'failure', path, 20, true)
    $.clock.after(100, () => void probe($, 'clock-after-return', path).catch(error => $.ui.log(String(error), { to: 'debug' })))
    returned = true
    return { text: 'Command and failure probes ran; clock continuation scheduled.' }
  })
  // The shipped saveLedger caller awaits next before saving. This probes that same frame.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && turnPath !== undefined) {
      const path = turnPath
      turnPath = undefined
      await probe($, 'turn.complete', path)
    }
    return done
  })
  on('classic.Stop', async ($, e, next) => {
    if (stopPath !== undefined) {
      const path = stopPath
      stopPath = undefined
      await probe($, 'Stop', path)
    }
    return next(e)
  })
}
