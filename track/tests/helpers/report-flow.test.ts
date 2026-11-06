import { describe, expect, test } from 'bun:test'
import { EMPTY_REPORT, editReport, fileReport, openReport, previewReport } from '../../hooks/report-flow'
import type { FileReply, PreviewReply, ReportForm, ReportOwner, ReportPorts } from '../../hooks/report-flow'

const A = { session: 'A', epoch: 1 }
const B = { session: 'B', epoch: 2 }
const A2 = { session: 'A', epoch: 3 }
const success: PreviewReply = { ok: true, draft_id: 'draft-1', scope: ['session', 'note'], note_out: 'scrubbed', note_changed: true }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function fixture() {
  let current: ReportOwner | undefined = A
  let state: ReportForm = { ...EMPTY_REPORT }
  const previews: Array<{ owner: ReportOwner; note: string }> = []
  const files: string[] = []
  let previewCall: ReportPorts['preview'] = async () => success
  let fileCall: ReportPorts['file'] = async () => ({ ok: true, ticket: 'PLANE-42' })
  const ports: ReportPorts = {
    owner: async () => current,
    isCurrent: async owner => current?.session === owner.session && current.epoch === owner.epoch,
    read: async () => state,
    update: async change => { state = change(state) },
    preview: async (owner, note) => { previews.push({ owner, note }); return previewCall(owner, note) },
    file: async draft => { files.push(draft); return fileCall(draft) },
  }
  return {
    ports, previews, files, state: () => state,
    setOwner: (owner: ReportOwner | undefined) => { current = owner },
    setPreview: (call: ReportPorts['preview']) => { previewCall = call },
    setFile: (call: ReportPorts['file']) => { fileCall = call },
  }
}
async function draft(f: ReturnType<typeof fixture>) {
  await openReport(f.ports)
  await editReport(f.ports, A, 'raw note')
  await previewReport(f.ports, A)
}

describe('report flow', () => {
  test('preview shows exact scrubbed draft without filing; only explicit file files it once', async () => {
    const f = fixture()
    await openReport(f.ports)
    await fileReport(f.ports, A)
    expect(f.files).toEqual([])
    await editReport(f.ports, A, 'raw note')
    await previewReport(f.ports, A)
    expect(f.previews).toEqual([{ owner: A, note: 'raw note' }])
    expect(f.files).toEqual([])
    expect(f.state()).toMatchObject({ phase: 'preview', draftId: 'draft-1', scope: ['session', 'note'], noteOut: 'scrubbed', noteChanged: true })
    await fileReport(f.ports, A)
    await fileReport(f.ports, A)
    expect(f.files).toEqual(['draft-1'])
    expect(f.state()).toMatchObject({ phase: 'filed', ticket: 'PLANE-42' })
  })

  test('overlapping presses make one call in each busy phase and reopen preserves busy', async () => {
    const f = fixture(); const p = deferred<PreviewReply>(); const pStarted = deferred<void>()
    f.setPreview(async () => { pStarted.resolve(); return p.promise })
    await openReport(f.ports); await editReport(f.ports, A, 'note')
    const first = previewReport(f.ports, A)
    expect(await Promise.race([pStarted.promise.then(() => true), first.then(() => false)])).toBe(true)
    await openReport(f.ports); expect(f.state().phase).toBe('previewing')
    await previewReport(f.ports, A); await fileReport(f.ports, A)
    expect(f.previews).toHaveLength(1); expect(f.files).toEqual([])
    p.resolve(success); await first
    const q = deferred<FileReply>(); const qStarted = deferred<void>()
    f.setFile(async () => { qStarted.resolve(); return q.promise })
    const filing = fileReport(f.ports, A)
    expect(await Promise.race([qStarted.promise.then(() => true), filing.then(() => false)])).toBe(true)
    await openReport(f.ports); expect(f.state().phase).toBe('filing')
    await fileReport(f.ports, A); await previewReport(f.ports, A)
    expect(f.files).toEqual(['draft-1'])
    q.resolve({ ok: true, ticket: 'P-1' }); await filing
    await openReport(f.ports); expect(f.state()).toMatchObject({ phase: 'filed', ticket: 'P-1' })
  })

  test('edit invalidates draft and refuses blank or over-limit notes visibly', async () => {
    const f = fixture(); await draft(f)
    await editReport(f.ports, A, 'changed'); await fileReport(f.ports, A)
    expect(f.files).toEqual([]); expect(f.state().draftId).toBeUndefined()
    for (const note of ['  \n ', 'x'.repeat(4001)]) {
      await editReport(f.ports, A, note); await previewReport(f.ports, A)
      expect(f.state().phase).toBe('editing'); expect(f.state().error).toBeTruthy()
    }
    expect(f.previews).toHaveLength(1)
  })

  test('owner switch before file prevents call', async () => {
    const f = fixture(); await draft(f); f.setOwner(B)
    await fileReport(f.ports, A)
    expect(f.files).toEqual([])
    await openReport(f.ports)
    expect(f.state()).toMatchObject({ owner: B, phase: 'editing', note: '' })
  })

  test('an atomic update retry cannot keep a claim from a discarded callback', async () => {
    const f = fixture(); await openReport(f.ports); await editReport(f.ports, A, 'note')
    const update = f.ports.update
    f.ports.update = async change => {
      change(await f.ports.read())
      await update(form => ({ ...form, owner: B }))
      await update(change)
    }
    await previewReport(f.ports, A)
    expect(f.previews).toEqual([])
    expect(f.state().owner).toEqual(B)
  })

  test('revision rejects a stale preview after A to B to the same A owner', async () => {
    const f = fixture(); const held = deferred<PreviewReply>(); const started = deferred<void>()
    f.setPreview(async () => { started.resolve(); return held.promise })
    await openReport(f.ports); await editReport(f.ports, A, 'old')
    const pending = previewReport(f.ports, A)
    expect(await Promise.race([started.promise.then(() => true), pending.then(() => false)])).toBe(true)
    f.setOwner(B); await openReport(f.ports)
    f.setOwner(A); await openReport(f.ports); await editReport(f.ports, A, 'new')
    const before = f.state(); held.resolve(success); await pending
    expect(f.state()).toEqual(before)
    expect(f.state()).toMatchObject({ owner: A, phase: 'editing', note: 'new' })
  })

  for (const operation of ['preview', 'file'] as const) {
    test(`owner A to B to A with new epoch rejects stale ${operation} result`, async () => {
      const f = fixture(); const started = deferred<void>()
      let pending: Promise<void>; let finish: () => void
      if (operation === 'preview') {
        const held = deferred<PreviewReply>(); f.setPreview(async () => { started.resolve(); return held.promise })
        await openReport(f.ports); await editReport(f.ports, A, 'old note')
        pending = previewReport(f.ports, A); finish = () => held.resolve(success)
      } else {
        await draft(f); const held = deferred<FileReply>(); f.setFile(async () => { started.resolve(); return held.promise })
        pending = fileReport(f.ports, A); finish = () => held.resolve({ ok: true, ticket: 'OLD' })
      }
      expect(await Promise.race([started.promise.then(() => true), pending.then(() => false)])).toBe(true)
      f.setOwner(B); await openReport(f.ports)
      f.setOwner(A2); await openReport(f.ports); await editReport(f.ports, A2, 'new note')
      const before = f.state(); finish(); await pending
      expect(f.state()).toEqual(before)
      expect(f.state()).toMatchObject({ owner: A2, phase: 'editing', note: 'new note' })
    })
  }

  for (const mode of ['throw', 'ambiguous', 'unspecified'] as const) {
    test(`${mode} file failure is terminal and tells person to check Plane`, async () => {
      const f = fixture(); await draft(f)
      f.setFile(async () => {
        if (mode === 'throw') throw new Error('secret exception')
        return mode === 'ambiguous' ? { ok: false, error: 'failed', ambiguous: true } : { ok: false, error: 'failed' }
      })
      await fileReport(f.ports, A); await openReport(f.ports)
      expect(f.state().phase).toBe('ambiguous'); expect(f.state().error).toMatch(/check.*plane/i)
      await fileReport(f.ports, A); await previewReport(f.ports, A); await editReport(f.ports, A, 'other')
      expect(f.files).toEqual(['draft-1']); expect(f.previews).toHaveLength(1)
      expect(f.state().phase).toBe('ambiguous')
    })
  }

  test('unambiguous failure permits only an explicit retry of the same draft', async () => {
    const f = fixture(); await draft(f)
    f.setFile(async () => ({ ok: false, error: 'not filed', ambiguous: false }))
    await fileReport(f.ports, A)
    expect(f.state()).toMatchObject({ phase: 'preview', draftId: 'draft-1', error: 'not filed' })
    expect(f.files).toEqual(['draft-1'])
    f.setFile(async () => ({ ok: true, ticket: 'P-2' }))
    await fileReport(f.ports, A)
    expect(f.files).toEqual(['draft-1', 'draft-1']); expect(f.state()).toMatchObject({ phase: 'filed', ticket: 'P-2' })
  })

  test('preview failures return to editing without leaking thrown errors or filing', async () => {
    const f = fixture(); await openReport(f.ports); await editReport(f.ports, A, 'note')
    f.setPreview(async () => { throw new Error('secret exception') })
    await previewReport(f.ports, A)
    expect(f.state().phase).toBe('editing'); expect(f.state().error).toBeTruthy()
    expect(f.state().error).not.toContain('secret exception'); expect(f.files).toEqual([])
  })
})
