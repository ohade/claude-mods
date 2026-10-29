// Failure-intake diagnose over caller-owned reads. register.tsx builds the ports per call, so every
// engine read, ownership value and cache stays in the native adapter; this file only orders and projects.
import type { Activity, Ledger, Pending, Turn } from '../types'
import { visibleSteps } from './steps'
import { fitBundle } from './diagnose-bundle'
import type { Bundle, GateProjection, RingEntry } from './diagnose-bundle'
import type { LoadedIdentity } from './identity-read'

export const DIAGNOSE_OWNER = 'track: diagnose needs an admitted owner'
export const DIAGNOSE_MAIN_LOOP = 'track: diagnose is main-loop only'

// isAdmitted reads the current ownership on every call; epoch is read synchronously, once, first.
export type DiagnosePorts = {
  epoch: () => number
  sessionId: () => Promise<string>
  isAdmitted: (epoch: number, session: string) => Promise<boolean>
  readLedger: () => Promise<Ledger>
  readTurn: () => Promise<Turn>
  readActivity: () => Promise<Activity>
  readPending: () => Promise<Pending>
  observedDisk: () => Promise<string | undefined>
  claimStats: (session: string, turnId: string | null, heldInputs: number[]) => Promise<Array<{ name: string; kind: string; present: boolean }>>
  cachedGate: () => GateProjection | undefined
  events: () => ReadonlyArray<{ owner: string | undefined; entry: RingEntry }>
  identity: LoadedIdentity
}

// D7-D11: a read-only bundle for failure intake. It never takes or switches ownership, never
// republishes the gate and writes no atom, env value, file or lease.
export const diagnose = async (ports: DiagnosePorts, e: { agentId?: string }): Promise<{ result: string } | { deny: string }> => {
  if (e.agentId !== undefined) return { deny: DIAGNOSE_MAIN_LOOP }
  const epoch = ports.epoch()
  let id: string
  try { id = await ports.sessionId() } catch { return { deny: DIAGNOSE_OWNER } }
  if (!(await ports.isAdmitted(epoch, id))) return { deny: DIAGNOSE_OWNER }
  const l = await ports.readLedger()
  const t = await ports.readTurn()
  const a = await ports.readActivity()
  const p = await ports.readPending()
  const disk = await ports.observedDisk()
  const fresh = t.freshness?.turnId === t.currentId ? t.freshness : undefined
  const visible = visibleSteps(l.steps)
  const byStatus: Record<string, number> = {}
  for (const step of visible) byStatus[step.status] = (byStatus[step.status] ?? 0) + 1
  const heldInputs = p.inputs.filter(input => input.held === true).map(input => input.id)
  let claims: Array<{ name: string; kind: string; present: boolean }> | null
  try { claims = await ports.claimStats(id, t.currentId, heldInputs) } catch { claims = null }
  const cached = ports.cachedGate()
  const bundle: Bundle = {
    v: 1,
    identity: ports.identity,
    ...(disk !== undefined && { observed_disk: disk }),
    session_id: id,
    ledger: { questions: l.questions.filter(q => q.cleared !== true).length, open: l.questions.filter(q => q.cleared !== true && q.status === 'open').length,
      steps: visible.length, by_status: byStatus },
    turn: { current_id: t.currentId, gated: t.currentId !== null && t.gatedTurnId === t.currentId,
      freshness: fresh === undefined ? null : { turn_id: fresh.turnId, edits: fresh.edits.length, bash: fresh.bash.length, steps: fresh.steps.length,
        completed_ids: fresh.completed.map(row => row.id), waiting_ids: [...fresh.waiting], held: [...fresh.held], nudged: [...fresh.nudged] } },
    activity: { is_working: a.isWorking === true, main_turn_id: a.mainTurnId ?? null, background_ids: [...a.background], task_ids: [...(a.tasks ?? [])], launch_seq: a.launchSeq ?? 0 },
    pending: { count: p.inputs.length, held_count: heldInputs.length, covered_count: p.inputs.filter(input => input.covered !== undefined).length },
    // E-I3: another owner's cached gate or events are never shown; null means none for this owner.
    gate: cached?.session_id === id ? { ...cached.gate } : null,
    claims,
    ring: ports.events().filter(row => row.owner === id).map(row => ({ ...row.entry, meta: { ...row.entry.meta } })),
    truncated: false,
  }
  const text = fitBundle(bundle)
  // D10: an owner change during the call refuses; it never mixes two owners' rows.
  let now: string
  try { now = await ports.sessionId() } catch { return { deny: DIAGNOSE_OWNER } }
  if (now !== id || !(await ports.isAdmitted(epoch, id))) return { deny: DIAGNOSE_OWNER }
  return { result: text }
}
