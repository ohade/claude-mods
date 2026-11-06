// FIXTURE: pure flow and transpiled view; no native adapter or external filing.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { editReport, fileReport, newReport, openReport, previewReport } from '../../hooks/report-flow'
import type { ReportForm, ReportOwner, ReportPhase, ReportPorts } from '../../hooks/report-flow'

const owner = { session: 'A', epoch: 1 }
const other = { session: 'B', epoch: 1 }
const nextEpoch = { session: 'A', epoch: 2 }
function fixture(initial: ReportForm, current: ReportOwner = owner) {
  let state = initial
  const previews: string[] = []
  const files: string[] = []
  const ports: ReportPorts = {
    owner: async () => current,
    isCurrent: async candidate => candidate.session === current.session && candidate.epoch === current.epoch,
    read: async () => state,
    update: async change => { state = change(state) },
    preview: async (_owner, note) => {
      previews.push(note)
      return { ok: true, draft_id: 'draft-2', scope: ['new scope'], note_out: 'new output', note_changed: false }
    },
    file: async draft => { files.push(draft); return { ok: true, ticket: 'SECOND-1' } },
  }
  return { ports, previews, files, state: () => state }
}

for (const phase of ['filed', 'ambiguous'] as const) {
  test(`${phase} stays on reopen and explicit new report requires a fresh preview and file`, async () => {
    const terminal: ReportForm = { owner, revision: 8, note: 'old', phase, draftId: 'draft-1', scope: ['old'], noteOut: 'old output', noteChanged: true, ticket: 'FIRST-1', error: 'old warning' }
    const f = fixture(terminal)
    await openReport(f.ports)
    expect(f.state()).toEqual(terminal)
    await newReport(f.ports, owner)
    expect(f.state()).toEqual({ owner, revision: 9, note: '', phase: 'editing' })
    expect(f.previews).toEqual([]); expect(f.files).toEqual([])
    await fileReport(f.ports, owner)
    expect(f.files).toEqual([])
    await editReport(f.ports, owner, 'second note')
    await previewReport(f.ports, owner)
    expect(f.previews).toEqual(['second note'])
    expect(f.state()).toMatchObject({ phase: 'preview', draftId: 'draft-2' })
    expect(f.files).toEqual([])
    await fileReport(f.ports, owner); await fileReport(f.ports, owner)
    expect(f.files).toEqual(['draft-2'])
    expect(f.state()).toMatchObject({ phase: 'filed', ticket: 'SECOND-1' })
  })
}

describe('new report fences', () => {
  for (const phase of ['editing', 'previewing', 'preview', 'filing'] as const) {
    test(`${phase} cannot reset`, async () => {
      const initial: ReportForm = { owner, revision: 4, note: 'keep', phase, draftId: 'draft-1' }
      const f = fixture(initial)
      await newReport(f.ports, owner)
      expect(f.state()).toEqual(initial)
      expect(f.previews).toEqual([]); expect(f.files).toEqual([])
    })
  }
  for (const stale of [other, nextEpoch] as const) {
    test(`rejects stale owner ${stale.session}/${stale.epoch}`, async () => {
      const initial: ReportForm = { owner, revision: 4, note: 'keep', phase: 'filed', draftId: 'draft-1' }
      const f = fixture(initial)
      await newReport(f.ports, stale)
      expect(f.state()).toEqual(initial)
    })
    test(`rejects mismatched stored owner ${stale.session}/${stale.epoch} inside update`, async () => {
      const initial: ReportForm = { owner: stale, revision: 4, note: 'keep', phase: 'ambiguous', draftId: 'draft-1' }
      const f = fixture(initial)
      await newReport(f.ports, owner)
      expect(f.state()).toEqual(initial)
    })
  }
})

type Node = { type: string; props: Record<string, any>; children: any[] }
const h = (type: string, props: Record<string, any> | null, ...children: any[]): Node => ({
  type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== false && value != null),
})
const source = readFileSync(new URL('../../hooks/report-view.tsx', import.meta.url), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', target: ts.ScriptTarget.ES2023 } }).outputText
const viewExports: Record<string, any> = {}
new Function('h', 'exports', 'require', output)(h, viewExports, () => { throw new Error('view must have no runtime imports') })
const elements = { Box: 'Box', Button: 'Button', Text: 'Text', Input: 'Input' }
const walk = (node: any): Node[] => node && typeof node === 'object' && typeof node.type === 'string' ? [node, ...node.children.flatMap(walk)] : []

for (const phase of ['editing', 'previewing', 'preview', 'filing', 'filed', 'ambiguous'] as const satisfies readonly ReportPhase[]) {
  test(`view exposes New report only in terminal phase: ${phase}`, () => {
    let calls = 0
    const onNewReport = () => { calls++ }
    const frame = { form: { owner, revision: 8, note: 'old', phase, ticket: 'FIRST-1' }, width: 42,
      onNote: () => {}, onPreview: () => {}, onFile: () => {}, onNewReport, onClose: () => {}, onCopySession: () => {} }
    const nodes = walk(viewExports.reportView(elements, frame))
    const button = nodes.find(node => node.props.key === 'report-new')
    if (phase === 'filed' || phase === 'ambiguous') {
      expect(button).toBeDefined()
      expect(button?.props.label).toBe('New report')
      expect(button?.props.onPress).toBe(onNewReport)
      if (phase === 'ambiguous') expect(nodes.some(node => node.type === 'Text' && node.children.join('').includes('Check Plane before filing another report; do not retry this draft.'))).toBe(true)
      button?.props.onPress()
      expect(calls).toBe(1)
    } else {
      expect(button).toBeUndefined()
      expect(calls).toBe(0)
    }
  })
}
