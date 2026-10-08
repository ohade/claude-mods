// Release gate: 500 comparable native mutations/renders for Track reliability.
// Load only in a fresh disposable session. No model calls and no private store access.
import type { Register } from 'claude-code'

let running = false
let renders: Array<{ ms: number; columns: number; rows: number; body_columns: number; body_rows: number; placement: string }> = []
export const register: Register = on => {
  // Load this probe before Track in the same user tier so its observer wraps
  // Track's render response. It records only memory and elapsed time here.
  on('ui.render', { component: 'Pane', requestId: 'track' }, async (_, e, next) => {
    const before = Date.now()
    const result = await next(e)
    if (running && renders.length < 2500) renders.push({ ms: Date.now() - before, columns: e.viewport.columns, rows: e.viewport.rows, body_columns: e.props.bodyColumns, body_rows: e.props.scroll.bodyRows, placement: e.props.placement })
    return result
  })
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'trackbench', description: 'Run 500 native Track updates and write a private receipt', argumentHint: '<absolute-output-path>', immediate: true })
    return next(e)
  })
  on('command.run', { command: 'trackbench' }, async ($, e) => {
    if (running) return { text: 'The probe is already running.' }
    const path = e.args.trim()
    if (!path.startsWith('/') || path.includes('\0')) return { text: 'An absolute output path is required.' }
    const subject = await $.session.id()
    running = true
    renders = []
    const started = Date.now()
    const samples: number[] = []
    const finish = async (failure?: string) => {
      const tools = await $.tool.list()
      let checkpoint: unknown
      if (failure === undefined && tools.some(t => t.name === 'mcp__track__checkpoint')) {
        const saved = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: subject })
        checkpoint = typeof saved.result === 'string' ? JSON.parse(saved.result) : saved
        if ((checkpoint as { ok?: boolean }).ok !== true) failure = 'final durable checkpoint was not acknowledged'
      }
      const result = { evidence: 'LIVE', subject, started, ended: Date.now(), events: samples.length, cadence_ms: 200, update_ms: samples, update_p95_ms: [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1], renders, render_p95_ms: renders.map(r => r.ms).sort((a, b) => a - b)[Math.ceil(renders.length * 0.95) - 1], checkpoint, ...(failure !== undefined && { failure }) }
      await $.fs.write(path, JSON.stringify(result))
      if (JSON.parse(await $.fs.read(path) as string).events !== samples.length) throw new Error('probe receipt read-back differs')
      running = false
      $.ui.toast(`Track probe: ${samples.length} updates; ${failure ?? `p95 ${result.update_p95_ms} ms`}`)
    }
    const step = async () => {
      try {
        if (await $.session.id() !== subject) throw new Error('probe session changed')
        if (samples.length === 0) {
          const created = await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['Native persistence latency probe'] })
          if (created.deny !== undefined || created.isError === true) throw new Error('probe step was refused')
        }
        const status = samples.length % 2 === 0 ? 'paused' : 'in_progress'
        const before = Date.now()
        const result = await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status, note: `Native sample ${samples.length + 1}` })
        if (result.deny !== undefined || result.isError === true || typeof result.result !== 'string' || !result.result.includes(`marked ${status}`) || result.result.includes('unsaved')) throw new Error(`update was not acknowledged: ${JSON.stringify(result)}`)
        samples.push(Date.now() - before)
        if (samples.length === 500) {
          await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed' })
          await finish()
        } else {
          $.clock.after(Math.max(1, started + samples.length * 200 - Date.now()), () => void step())
        }
      } catch (error) {
        await finish(error instanceof Error ? error.message : String(error))
      }
    }
    $.clock.after(1, () => void step().catch(error => { running = false; $.ui.log(`Track probe failed: ${String(error)}`, { to: 'debug' }) }))
    return { text: `Native Track probe started for this session; receipt: ${path}` }
  })
}
