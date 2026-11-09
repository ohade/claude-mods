// SOURCE/FIXTURE: the oracle is actual base JSX, never the async native handler.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import ts from 'typescript'

export const W = resolve(import.meta.dir, '../../..')

export const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const baseRun = spawnSync('git', ['show', '0c14bba9505e266d2efcf8d31ab07d49d0f44020:track/hooks/register.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(baseRun.status, 0, 'immutable original source must exist')
export const original = baseRun.stdout
const tree = (source: string) => ts.createSourceFile('register.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const nodes = (root: ts.Node): ts.Node[] => { const all: ts.Node[] = []; const visit = (node: ts.Node) => { all.push(node); ts.forEachChild(node, visit) }; visit(root); return all }
const printer = ts.createPrinter({ removeComments: true })
const norm = (node: ts.Node, file: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, file)
const variable = (file: ts.SourceFile, name: string) => {
  const found = nodes(file).filter(ts.isVariableDeclaration).filter(node => node.name.getText(file) === name)
  assert.equal(found.length, 1, `one native ${name} initializer`)
  return found[0]!
}
const rowMap = (file: ts.SourceFile, kind: 'questions' | 'steps') => {
  const found = nodes(file).filter(ts.isCallExpression).find(node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map' && node.expression.expression.getText(file).startsWith(`${kind}.slice(`))
  assert.ok(found, `original ${kind} row map`)
  return found
}
const control = (file: ts.SourceFile, name: string) => {
  const found = nodes(file).filter(ts.isJsxExpression).find(node => {
    const value = node.expression?.getText(file) ?? ''
    return name === 'questionClear' ? value.startsWith("l.questions.length > 0 && item('questions-clear',")
      : name === 'answeredClear' ? value.startsWith("l.questions.length > 0 && item('questions-clear-answered',")
      : name === 'stepHeaderControls' ? value === "l.steps.length > 0 && clearButtons('')" : value === "clearButtons('-bottom')"
  })
  assert.ok(found?.expression, `actual original ${name} subtree`)
  return found.expression
}
const base = tree(original)
const shellReturn = nodes(base).filter(ts.isReturnStatement).find(node => node.expression?.getText(base).startsWith('(\n      <Box flexDirection="column" height={bodyRows}'))
assert.ok(shellReturn?.expression, 'actual final Pane returned shell')
const shell = shellReturn.expression
const names = ['questionClear', 'answeredClear', 'stepHeaderControls', 'bottomControls'] as const
const baseControls = Object.fromEntries(names.map(name => [name, norm(control(base, name), base)]))
const replaceSpans = (source: string, edits: Array<{ start: number; end: number; text: string }>) => {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source
}
const replacements = [
  ...(['questions', 'steps'] as const).map(kind => ({ node: rowMap(base, kind), text: kind === 'questions' ? 'questionRows' : 'stepRows' })),
  ...names.map(name => ({ node: control(base, name), text: name })),
]
export const shellText = replaceSpans(shell.getText(base), replacements.map(({ node, text }) => ({ start: node.getStart(base) - shell.getStart(base), end: node.end - shell.getStart(base), text })))
const displayNames = 'width, bodyRows, roomy, titleLabel, titleSide, qDone, qTotal, qRing, qHidden, qRows, qEmpty, sDone, sTotal, sRing, sHidden, sRows, sEmpty, questionClear, answeredClear, stepHeaderControls, bottomControls, questionRows, stepRows, hints, bannerRows'
const originalItem = variable(base, 'item').initializer!.getText(base)
const oracleModule = `export const paneItem = (elements, key, child) => { const { Box } = elements; return (${originalItem})(key, child) }\nexport const paneRootView = (elements, frame) => { const { Box, Button, Text } = elements; const { ${displayNames} } = frame; const questions = { length: qTotal }, steps = { length: sTotal }; const item = (key, child) => paneItem(elements, key, child); return ${shellText} }`

type Node = { type: string; props: Record<string, any>; children: any[] }
const flatten = (children: any[]): any[] => children.flat(Infinity).filter(value => value !== false && value !== null && value !== undefined)
const h = (type: string, props: Record<string, any> | null, ...children: any[]): Node => ({ type, props: props ?? {}, children: flatten(children) })
type View = { paneRootView: (elements: any, frame: any) => Node; paneItem: (elements: any, key: string, child: any) => Node }
export const loadTreeModule = (source: string): View => {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', target: ts.ScriptTarget.ES2023 } }).outputText
  const exports: Record<string, unknown> = {}
  new Function('h', 'exports', 'require', output)(h, exports, (name: string) => { assert.equal(name, './pane-layout', 'pure JSX oracle dependency'); return { HEADER_GAP: 2 } })
  return exports as unknown as View
}
export const originalView = loadTreeModule('const HEADER_GAP = 2;\n' + oracleModule)
const walk = (node: any): Node[] => typeof node === 'object' && node !== null && typeof node.type === 'string' ? [node, ...node.children.flatMap(walk)] : []
const atKey = (root: Node, key: string) => walk(root).find(node => node.props.key === key)
const elements = { Box: 'Box', Button: 'Button', Text: 'Text' }
export const checkFrame = (view: View): void => {
  for (const width of [39, 40, 80]) for (const bodyRows of [15, 16]) for (const kind of ['empty', 'all-cleared', 'mixed', 'confirm']) {
    const log: string[] = []
    const callbacks = Object.fromEntries(['q-clear', 'q-answered', 's-clear', 's-completed'].map(name => [name, () => { log.push(name) }]))
    const compact = width < 40
    const allLabel = compact ? 'all' : 'clear all', doneLabel = compact ? 'done' : 'clear completed'
    const hasQ = kind !== 'empty', hasS = kind === 'mixed' || kind === 'confirm'
    const qTotal = kind === 'mixed' ? 1 : 0, sTotal = hasS ? 1 : 0
    const item = (key: string, child: Node) => originalView.paneItem(elements, key, child)
    const questionClear = hasQ && item('questions-clear', h('Button', { key: 'clear-questions', plain: true, dimColor: true, hotkey: 'q', label: allLabel, onPress: callbacks['q-clear'] }))
    const answeredClear = hasQ && item('questions-clear-answered', h('Button', { key: 'clear-answered', plain: true, dimColor: true, hotkey: 'a', label: doneLabel, onPress: callbacks['q-answered'] }))
    const controls = (suffix: string) => [
      ...(hasS ? [item(`item-clear-steps${suffix}`, h('Button', { key: `clear-steps${suffix}`, plain: true, dimColor: kind !== 'confirm', hotkey: 's', label: kind === 'confirm' ? (compact ? 'confirm' : 'confirm — clear 1 unfinished step') : allLabel, onPress: callbacks['s-clear'] }, kind === 'confirm' ? h('Text', { color: 'error' }, compact ? 'confirm' : 'confirm — clear 1 unfinished step') : allLabel))] : []),
      item(`item-clear-completed${suffix}`, h('Button', { key: `clear-completed${suffix}`, plain: true, dimColor: true, hotkey: 'c', label: doneLabel, onPress: callbacks['s-completed'] })),
    ]
    const questionRows = qTotal ? [h('Opaque', { key: 'question-row' })] : [], stepRows = sTotal ? [h('Opaque', { key: 'step-row' })] : []
    const frame = { width, bodyRows, roomy: bodyRows >= 16, titleLabel: ' TRACK 界 ', titleSide: 2, qDone: 0, qTotal, qRing: '○ 0/1', qHidden: '↑2', qRows: 3, qEmpty: hasQ ? '  all cleared' : '  None yet.', sDone: sTotal, sTotal, sRing: '● 1/1', sHidden: '↓1', sRows: 4, sEmpty: '  None yet.', questionClear, answeredClear, stepHeaderControls: hasS && controls(''), bottomControls: controls('-bottom'), questionRows, stepRows, hints: compact ? [{ key: 'hint-hide', text: '/track hide' }, { key: 'hint-close', text: 'ctrl+x x close' }] : [{ key: 'hint', text: '/track hides · ctrl+x x closes for good' }], bannerRows: kind === 'empty' ? [] : [{ key: 'banner-unsaved', glyph: '', words: 'Unsaved', background: 'warning', glyphColor: 'inverseText' }, { key: 'banner-you', glyph: '◆', words: ' Waiting on you', background: '#1a73e8', glyphColor: 'inverseText' }] }
    const actual = view.paneRootView(elements, frame)
    assert.ok(atKey(actual, 'clear-completed-bottom'), 'bottom c exists even without guarded step header controls')
    const qHeader = atKey(actual, 'questions-header')!
    const qKeys = walk(qHeader).filter(node => node.type === 'Button').map(node => node.props.key)
    if (kind === 'all-cleared') assert.deepEqual(qKeys, ['clear-questions', 'clear-answered'], 'all-cleared questions retain q/a controls despite visible total zero')
    if (hasQ) assert.deepEqual(qKeys, ['clear-questions', 'clear-answered'], 'opaque question controls keep original order')
    assert.equal(walk(actual).filter(node => node.type === 'Box' && node.props.flexGrow === 1).length, 1, 'frame retains flexGrow spacer')
    assert.deepEqual(actual.children.map(node => node.props.key ?? node.type), ['title', 'questions-header', 'questions', 'Text', 'steps-header', 'steps', 'Box', 'bottom-bar', 'banner'], 'frame preserves divider/spacer/bottom order')
    assert.deepEqual(actual.children[3], h('Text', { dimColor: true }, '─'.repeat(width)), 'divider retains dim color and full width')
    if (kind === 'confirm') { const button = atKey(actual, 'clear-steps-bottom')!; assert.equal(button.props.label, compact ? 'confirm' : 'confirm — clear 1 unfinished step'); assert.equal(button.children[0].props.color, 'error') }
    assert.equal(walk(atKey(actual, 'steps-header')).filter(node => node.type === 'Button').length, hasS ? 2 : 0)
    const buttons = walk(actual).filter(node => node.type === 'Button')
    if (hasS) assert.deepEqual(buttons.filter(node => node.props.hotkey === 's' || node.props.hotkey === 'c').map(node => node.props.key).slice(-2), ['clear-steps-bottom', 'clear-completed-bottom'], 'last duplicate step hotkeys belong to bottom controls')
    for (const [key, callback] of [['clear-questions', 'q-clear'], ['clear-answered', 'q-answered'], ['clear-steps-bottom', 's-clear'], ['clear-completed-bottom', 's-completed']]) {
      const button = atKey(actual, key!)
      if (button) { assert.equal(button.props.onPress, callbacks[callback!], 'opaque callbacks retain exact identity'); const onPress = button.props.onPress; assert.ok(onPress, 'fixture callback must be present'); onPress(); assert.equal(log.at(-1), callback, 'callback dispatch reaches its distinct sentinel') }
    }
    for (const opaque of [...questionRows, ...stepRows, ...frame.bottomControls, ...(questionClear ? [questionClear] : []), ...(answeredClear ? [answeredClear] : []), ...(frame.stepHeaderControls || [])]) assert.ok(walk(actual).includes(opaque), 'prepared node retains exact identity')
    assert.deepEqual(actual, originalView.paneRootView(elements, frame), 'full original shell tree type/key/props/text/order/callback parity')
    assert.deepEqual(view.paneItem(elements, 'item', h('Text', {}, 'child')), originalView.paneItem(elements, 'item', h('Text', {}, 'child')), 'single original item wrapper rule')
  }
}

const region = (file: ts.SourceFile) => nodes(file).filter(ts.isCallExpression).find(node => node.expression.getText(file) === 'Object.assign' && node.arguments[0]?.getText(file) === 'regions')!
const invariantNodes = (file: ts.SourceFile) => nodes(file).flatMap(node => {
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return [`type:${node.name.text}:${digest(norm(node, file))}`]
  if (ts.isVariableDeclaration(node) && node.initializer && !['register', 'item', 'questionRows', 'stepRows', ...names].includes(node.name.getText(file))) return [`init:${node.name.getText(file)}:${digest(norm(node.initializer, file))}`]
  return []
}).sort()
// questionsArrow: the exact questions row-map arrow digest the checked source must have. Accepted
// sources keep the 0c14bba arrow; the live caller pins the reviewed cold-resume arrow.
// stepsArrow: left out, the steps arrow must equal 0c14bba's; given, it is the exact digest the
// checked source must have (2026-11-09, Ohad approved: the number column and one-line rows).
export const assertPaneNative = (source: string, questionsArrow: string = 'a401635d03b4ae327dd451756c14009e34ef9430e551e6125c4604088918e0d2', stepsArrow?: string): void => {
  const current = tree(source)
  for (const name of names) assert.equal(norm(variable(current, name).initializer!, current), baseControls[name], `native ${name} equals actual original control expression`)
  const call = nodes(current).filter(ts.isCallExpression).find(node => node.expression.getText(current) === 'paneRootView')
  assert.ok(call && call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1]), 'native frame production caller')
  for (const name of names) {
    const field: ts.ObjectLiteralElementLike | undefined = call.arguments[1].properties.find(prop => prop.name?.getText(current) === name)
    assert.ok(field && (ts.isShorthandPropertyAssignment(field) && field.name.text === name || ts.isPropertyAssignment(field) && field.initializer.getText(current) === name), `native frame field ${name} passes its matching prepared node`)
  }
  assert.equal(digest(norm(rowMap(current, 'steps').arguments[0]!, current)), stepsArrow ?? digest(norm(rowMap(base, 'steps').arguments[0]!, base)), stepsArrow === undefined ? 'native steps full row-map arrow unchanged' : 'native steps row-map arrow is the exact expected arrow')
  assert.equal(digest(norm(rowMap(base, 'questions').arguments[0]!, base)), 'a401635d03b4ae327dd451756c14009e34ef9430e551e6125c4604088918e0d2', 'accepted 0c14bba questions row-map arrow proof retained')
  assert.equal(digest(norm(rowMap(current, 'questions').arguments[0]!, current)), questionsArrow, 'native questions row-map arrow is the exact expected arrow')
  assert.equal(digest(norm(variable(current, 'clearButtons').initializer!, current)), digest(norm(variable(base, 'clearButtons').initializer!, base)), 'native clearButtons AST unchanged')
  assert.equal(digest(norm(region(current), current)), digest(norm(region(base), base)), 'native region assignment AST unchanged')
}
export const assertNative = (source: string): void => {
  assertPaneNative(source)
  assert.deepEqual(invariantNodes(tree(source)), invariantNodes(base), 'all unaffected native initializers and types retain original AST hashes')
}
