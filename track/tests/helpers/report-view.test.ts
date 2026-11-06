// FIXTURE: exercises the actual pure view, not the native adapter.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

type Node = { type: string; props: Record<string, any>; children: any[] }
const h = (type: string, props: Record<string, any> | null, ...children: any[]): Node => ({
  type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== false && value != null),
})
const source = readFileSync(new URL('../../hooks/report-view.tsx', import.meta.url), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', target: ts.ScriptTarget.ES2023 } }).outputText
const exports: Record<string, any> = {}
new Function('h', 'exports', 'require', output)(h, exports, () => { throw new Error('view must have no runtime imports') })
const elements = { Box: 'Box', Button: 'Button', Text: 'Text', Input: 'Input' }
const walk = (node: any): Node[] => node && typeof node === 'object' && typeof node.type === 'string' ? [node, ...node.children.flatMap(walk)] : []
const key = (root: Node, name: string) => walk(root).find(node => node.props.key === name)
const textNodes = (root: Node) => walk(root).filter(node => node.type === 'Text')
const content = (node: Node) => node.children.join('')
const make = (overrides: Record<string, any> = {}) => {
  const calls: any[] = []
  const frame = {
    form: { owner: { session: 'session-full-123', epoch: 1 }, revision: 1, note: 'raw secret', phase: 'editing', ...overrides }, width: 42,
    onNote: (value: string) => calls.push(['note', value]), onPreview: (value: string) => calls.push(['preview', value]),
    onFile: () => calls.push(['file']), onClose: () => calls.push(['close']), onCopySession: () => calls.push(['copy']),
  }
  return { frame, calls, root: exports.reportView(elements, frame) as Node }
}
const requireKey = (root: Node, name: string): Node => {
  const found = key(root, name)
  expect(found, `${name} exists`).toBeDefined()
  return found!
}

describe('report view fixture', () => {
  test('editing controls preserve exact text and callbacks without filing', () => {
    const { root, frame, calls } = make()
    expect(root.type).toBe('Box')
    expect(root.props.flexDirection).toBe('column')
    expect(root.props.width).toBe(42)
    expect(textNodes(root).map(content)).toContain('Report a Track issue')
    expect(textNodes(root).some(node => content(node).includes('session-full-123'))).toBe(true)
    expect(textNodes(root).map(content)).toContain('4000 characters maximum. Preview before filing.')
    const input = requireKey(root, 'report-note')
    expect(input.type).toBe('Input')
    expect([input.props.label, input.props.value, input.props.rows, input.props.submitLabel]).toEqual(['What went wrong?', 'raw secret', 3, 'preview'])
    expect(input.props.onInput).toBe(frame.onNote)
    expect(input.props.onSubmit).toBe(frame.onPreview)
    input.props.onInput('changed\nexactly')
    input.props.onSubmit('entered text')
    const preview = requireKey(root, 'report-preview')
    expect(preview.props.label).toBe('Preview')
    preview.props.onPress()
    expect(key(root, 'report-file')).toBeUndefined()
    expect(calls).toEqual([['note', 'changed\nexactly'], ['preview', 'entered text'], ['preview', 'raw secret']])
  })

  test('preview shows only scrubbed output and scope, then files only on explicit press', () => {
    const { root, frame, calls } = make({ phase: 'preview', draftId: 'draft-1', noteOut: 'safe [redacted]', scope: ['session metadata', 'debug summary'], noteChanged: true, error: 'Preview warning' })
    const texts = textNodes(root)
    expect(texts.map(content)).toContain('Will be sent:')
    expect(texts.map(content)).toContain('safe [redacted]')
    expect(texts.map(content)).not.toContain('raw secret')
    expect(texts.map(content)).toContain('session metadata')
    expect(texts.map(content)).toContain('debug summary')
    expect(texts.map(content)).toContain('The preview note was redacted. Your original stays on this Mac.')
    expect(texts.find(node => content(node) === 'Preview warning')?.props.color).toBe('error')
    expect(texts.every(node => node.props.wrap === 'wrap')).toBe(true)
    requireKey(root, 'report-note').props.onSubmit('current value')
    requireKey(root, 'report-preview').props.onPress()
    expect(calls).toEqual([['preview', 'current value'], ['preview', 'raw secret']])
    const file = requireKey(root, 'report-file')
    expect(file.props.label).toBe('File report')
    expect(file.props.onPress).toBe(frame.onFile)
    file.props.onPress()
    expect(calls).toEqual([['preview', 'current value'], ['preview', 'raw secret'], ['file']])
  })

  test('preview without draft cannot file and unchanged note has no redaction notice', () => {
    const { root } = make({ phase: 'preview', noteOut: 'safe', scope: [], noteChanged: false })
    expect(key(root, 'report-file')).toBeUndefined()
    expect(key(root, 'report-note')).toBeDefined()
    expect(key(root, 'report-preview')).toBeDefined()
    expect(textNodes(root).map(content)).not.toContain('The preview note was redacted. Your original stays on this Mac.')
  })

  for (const [phase, expected] of [
    ['previewing', 'Preparing preview…'], ['filing', 'Submitting report…'], ['filed', 'Created TRACK-123'],
    ['ambiguous', 'Check Plane before filing another report; do not retry this draft.'],
  ] as const) test(`${phase} cannot edit, preview or file`, () => {
    const { root } = make({ phase, ticket: 'TRACK-123', draftId: 'stale', error: phase === 'ambiguous' ? 'unknown outcome' : undefined })
    expect(textNodes(root).map(content)).toContain(expected)
    for (const name of ['report-note', 'report-preview', 'report-file']) expect(key(root, name)).toBeUndefined()
    if (phase === 'ambiguous') expect(textNodes(root).some(node => content(node).startsWith('Created '))).toBe(false)
  })

  for (const phase of ['editing', 'previewing', 'preview', 'filing', 'filed', 'ambiguous']) test(`${phase} retains close and owner copy callbacks`, () => {
    const { root, frame, calls } = make({ phase })
    const close = requireKey(root, 'report-close'), copy = requireKey(root, 'report-copy')
    expect(close.props.label).toBe('Close')
    expect(copy.props.label).toBe('Copy session')
    expect(close.props.onPress).toBe(frame.onClose)
    expect(copy.props.onPress).toBe(frame.onCopySession)
    copy.props.onPress(); close.props.onPress()
    expect(calls).toEqual([['copy'], ['close']])
  })

  test('missing owner is honestly shown and cannot copy', () => {
    const { root } = make({ owner: undefined })
    expect(key(root, 'report-copy')).toBeUndefined()
    expect(textNodes(root).some(node => /session.*unavailable/i.test(content(node)))).toBe(true)
  })
})
