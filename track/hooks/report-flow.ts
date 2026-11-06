export type ReportOwner = { session: string; epoch: number }
export type ReportPhase = 'editing' | 'previewing' | 'preview' | 'filing' | 'filed' | 'ambiguous'
export type ReportForm = {
  owner?: ReportOwner; revision: number; note: string; phase: ReportPhase
  draftId?: string; scope?: string[]; noteOut?: string; noteChanged?: boolean
  ticket?: string; error?: string
}
export type PreviewReply = { ok: true; draft_id: string; scope: string[]; note_out: string; note_changed: boolean } | { ok: false; error: string }
export type FileReply = { ok: true; ticket: string } | { ok: false; error: string; ambiguous?: boolean }
export type ReportPorts = {
  owner(): Promise<ReportOwner | undefined>
  isCurrent(owner: ReportOwner): Promise<boolean>
  read(): Promise<ReportForm>
  update(change: (form: ReportForm) => ReportForm): Promise<void>
  preview(owner: ReportOwner, note: string): Promise<PreviewReply>
  file(draftId: string): Promise<FileReply>
}
export const EMPTY_REPORT: ReportForm = { revision: 0, note: '', phase: 'editing' }

const sameOwner = (left: ReportOwner | undefined, right: ReportOwner): boolean =>
  left?.session === right.session && left.epoch === right.epoch

const editing = (form: ReportForm, owner: ReportOwner, note: string): ReportForm => ({
  owner, revision: form.revision + 1, note, phase: 'editing',
})

export async function openReport(ports: ReportPorts): Promise<void> {
  const owner = await ports.owner()
  if (!owner || !(await ports.isCurrent(owner))) return
  await ports.update(form => sameOwner(form.owner, owner) ? form : editing(form, owner, ''))
}

export async function newReport(ports: ReportPorts, owner: ReportOwner): Promise<void> {
  if (!(await ports.isCurrent(owner))) return
  await ports.update(form => {
    if (!sameOwner(form.owner, owner) || (form.phase !== 'filed' && form.phase !== 'ambiguous')) return form
    return editing(form, owner, '')
  })
}

export async function editReport(ports: ReportPorts, owner: ReportOwner, note: string): Promise<void> {
  if (!(await ports.isCurrent(owner))) return
  await ports.update(form => {
    if (!sameOwner(form.owner, owner) || (form.phase !== 'editing' && form.phase !== 'preview')) return form
    return editing(form, owner, note)
  })
}

export async function previewReport(ports: ReportPorts, owner: ReportOwner): Promise<void> {
  if (!(await ports.isCurrent(owner))) return
  const claim: { value?: { note: string; revision: number } } = {}
  await ports.update(form => {
    claim.value = undefined
    if (!sameOwner(form.owner, owner) || (form.phase !== 'editing' && form.phase !== 'preview')) return form
    const next = editing(form, owner, form.note)
    if (!form.note.trim()) return { ...next, error: 'Enter a note before previewing.' }
    if (form.note.length > 4000) return { ...next, error: 'Note must be at most 4000 characters.' }
    claim.value = { note: form.note, revision: next.revision }
    return { ...next, phase: 'previewing' }
  })
  const captured = claim.value
  if (!captured || !(await ports.isCurrent(owner))) return
  let reply: PreviewReply
  try {
    reply = await ports.preview(owner, captured.note)
  } catch {
    reply = { ok: false, error: 'Preview failed. Please try again.' }
  }
  if (!(await ports.isCurrent(owner))) return
  await ports.update(form => {
    if (!sameOwner(form.owner, owner) || form.revision !== captured.revision || form.phase !== 'previewing') return form
    if (!reply.ok) return { ...form, phase: 'editing', error: reply.error }
    return { ...form, phase: 'preview', draftId: reply.draft_id, scope: reply.scope, noteOut: reply.note_out, noteChanged: reply.note_changed }
  })
}

export async function fileReport(ports: ReportPorts, owner: ReportOwner): Promise<void> {
  if (!(await ports.isCurrent(owner))) return
  const claim: { value?: { draftId: string; revision: number } } = {}
  await ports.update(form => {
    claim.value = undefined
    if (!sameOwner(form.owner, owner) || form.phase !== 'preview' || !form.draftId) return form
    claim.value = { draftId: form.draftId, revision: form.revision + 1 }
    return { ...form, revision: claim.value.revision, phase: 'filing', error: undefined }
  })
  const captured = claim.value
  if (!captured || !(await ports.isCurrent(owner))) return
  let reply: FileReply
  try {
    reply = await ports.file(captured.draftId)
  } catch {
    reply = { ok: false, error: 'File outcome is unknown.' }
  }
  if (!(await ports.isCurrent(owner))) return
  await ports.update(form => {
    if (!sameOwner(form.owner, owner) || form.revision !== captured.revision || form.phase !== 'filing') return form
    if (reply.ok) return { ...form, phase: 'filed', ticket: reply.ticket }
    if (reply.ambiguous === false) return { ...form, phase: 'preview', error: reply.error }
    return { ...form, phase: 'ambiguous', error: 'Check Plane before filing another report; do not retry this draft.' }
  })
}
