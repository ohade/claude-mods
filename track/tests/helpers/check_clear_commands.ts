// SOURCE/FIXTURE: the bulk-clear extraction keeps repaired 95249cf behavior and native effects.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { Ledger, Step } from '../../types'
import { clearQuestionRows, hideAnsweredQuestions } from '../../hooks/question-commands'
import { planStepClear, hideCompletedSteps } from '../../hooks/clear-commands'

type Commands = { clearQuestionRows: typeof clearQuestionRows; hideAnsweredQuestions: typeof hideAnsweredQuestions; planStepClear: typeof planStepClear; hideCompletedSteps: typeof hideCompletedSteps }
const commands: Commands = { clearQuestionRows, hideAnsweredQuestions, planStepClear, hideCompletedSteps }
const freeze = <T,>(value: T): T => {
  if (value !== null && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
  return value
}
const empty = (): Ledger => ({ v: 1, nextQuestionId: 90, prompts: [], questions: [], steps: [] })
const step = (status: Step['status'], index: number): Step => ({ id: `plan:${index}`, source: 'plan', subject: status, status, note: 'keep note', taskId: `worker:${index}`, ...(index === 2 && { cleared: true }) })
const mixed = freeze<Ledger>({
  ...empty(), session_id: 'owner', prompts: [{ rowKey: 'source-row', head: 'Source', at: 1, turnId: 't1' }],
  questions: [
    { id: 1, head: 'Open', at: 1, turnId: 't1', status: 'open' },
    { id: 2, head: 'Deferred', at: 2, turnId: 't1', status: 'deferred', cleared: true },
    { id: 3, head: 'Answered', at: 3, turnId: 't1', status: 'answered', answerText: 'Saved answer', answeredAt: 4 },
  ],
  steps: (['pending', 'in_progress', 'paused', 'waiting', 'completed'] as const).map(step),
  withdrawn: [{ id: 0, head: 'Earlier question' }], clearedSteps: [{ id: 'plan:old', head: 'Earlier step' }],
})

const checkCases = (reader: Commands): void => {
  const before = JSON.stringify(mixed)
  assert.deepEqual(reader.clearQuestionRows(mixed), { ...mixed, questions: [], withdrawn: [...mixed.withdrawn!, { id: 1, head: 'Open' }, { id: 2, head: 'Deferred' }] }, 'hard question clear withdraws only unanswered rows and preserves prior notices')
  assert.deepEqual(reader.hideAnsweredQuestions(mixed), { ...mixed, questions: [mixed.questions[0], mixed.questions[1], { ...mixed.questions[2]!, cleared: true }] }, 'soft question clear hides only answered rows and retains their saved answers')
  const arming = reader.planStepClear(mixed, false)
  assert.equal(arming.arming, true, 'unfinished steps need confirmation')
  assert.strictEqual(arming.ledger, mixed, 'arming preserves the SAME ledger object')
  assert.deepEqual(reader.planStepClear(mixed, true), { arming: false, ledger: { ...mixed, steps: [], clearedSteps: [...mixed.clearedSteps!, ...mixed.steps.slice(0, 4).map(row => ({ id: row.id, head: row.subject }))] } }, 'confirmed clear removes all rows and reports exactly the unfinished ones')
  assert.deepEqual(reader.hideCompletedSteps(mixed), { ...mixed, steps: [...mixed.steps.slice(0, 4), { ...mixed.steps[4]!, cleared: true }] }, 'soft step clear hides completed rows and retains unfinished rows and all fields')
  const completed = freeze({ ...empty(), steps: [step('completed', 5)] })
  assert.deepEqual(reader.planStepClear(completed, false), { ledger: { ...completed, steps: [] }, arming: false }, 'completed-only clear needs no arm and does not invent notices')
  assert.deepEqual(reader.clearQuestionRows(empty()), { ...empty(), withdrawn: [] }, 'empty question clear has the original explicit empty queue')
  assert.equal(JSON.stringify(mixed), before, 'commands never mutate the input ledger')
}
checkCases(commands)
const mutants: Commands[] = [
  { ...commands, clearQuestionRows: ledger => ({ ...ledger, questions: [], withdrawn: [...(ledger.withdrawn ?? []), ...ledger.questions.map(q => ({ id: q.id, head: q.head }))] }) },
  { ...commands, planStepClear: (ledger, armed) => { const result = planStepClear(ledger, armed); return { ...result, ledger: { ...result.ledger } } } },
  { ...commands, planStepClear: (ledger, armed) => { const result = planStepClear(ledger, armed); return armed ? { ...result, ledger: { ...result.ledger, clearedSteps: ledger.clearedSteps } } : result } },
  { ...commands, hideCompletedSteps: ledger => ({ ...ledger, steps: ledger.steps.map(row => ({ ...row, cleared: true })) }) },
]
for (const mutant of mutants) assert.throws(() => checkCases(mutant), assert.AssertionError, 'literal cases reject wrong behavior at an assertion')

// Frozen 95249cf callback bodies, with the native arming result made explicit for comparison.
const originalQuestions = (cur: Ledger): Ledger => ({ ...cur, questions: [], withdrawn: [...(cur.withdrawn ?? []), ...cur.questions.filter(q => q.status !== 'answered').map(q => ({ id: q.id, head: q.head }))] })
const originalAnswers = (cur: Ledger): Ledger => ({ ...cur, questions: cur.questions.map(q => (q.status === 'answered' ? { ...q, cleared: true as const } : q)) })
const originalSteps = (cur: Ledger, armed: boolean) => {
  const removed = cur.steps.filter(s => s.status !== 'completed').map(s => ({ id: s.id, head: s.subject }))
  const arming = removed.length > 0 && !armed
  return { ledger: arming ? cur : { ...cur, steps: [], ...(removed.length > 0 && { clearedSteps: [...(cur.clearedSteps ?? []), ...removed] }) }, arming }
}
const originalCompleted = (cur: Ledger): Ledger => ({ ...cur, steps: cur.steps.map(s => (s.status === 'completed' ? { ...s, cleared: true as const } : s)) })
for (const ledger of [mixed, freeze(empty()), freeze({ ...mixed, withdrawn: undefined, clearedSteps: undefined, steps: mixed.steps.slice(-1) })]) {
  assert.deepEqual(clearQuestionRows(ledger), originalQuestions(ledger))
  assert.deepEqual(hideAnsweredQuestions(ledger), originalAnswers(ledger))
  assert.deepEqual(hideCompletedSteps(ledger), originalCompleted(ledger))
  for (const armed of [false, true]) assert.deepEqual(planStepClear(ledger, armed), originalSteps(ledger, armed))
}
const source = readFileSync(new URL('../../hooks/clear-commands.ts', import.meta.url), 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100, 'clear decision owner stays small')
assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:Date|crypto|Promise|async|EngineInterface|setTimeout|setInterval|Runtime)\b|\$(?!\{)/, 'clear decisions have no native capabilities or samplers')

const parse = (text: string) => ts.createSourceFile('register.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const all = (root: ts.Node): ts.Node[] => { const nodes: ts.Node[] = []; const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit) }; visit(root); return nodes }
const callName = (node: ts.Node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined
// TRACK-46 slice 7 (2026-11-09, Ohad's standing approval): clearQuestions and clearSteps moved to
// pane-actions.tsx as function declarations whose body returns the same pressOwned call; the inline
// presses stay in register.tsx. Each file is parsed on its own; a name must occur in exactly one.
// TRACK-46 slice 11 (2026-11-09, Ohad's standing approval): the pane and transcript UI handler bodies
// moved to ui-render.tsx, a native adapter file; the pane drawing is checked there.
const NATIVE = ['register.tsx', 'pane-actions.tsx', 'ui-render.tsx'].map(file => parse(readFileSync(new URL(`../../hooks/${file}`, import.meta.url), 'utf8')))
const ownerOf = (name: string): ts.SourceFile => {
  const files = NATIVE.filter(file => all(file).some(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(file) === name))
  assert.equal(files.length, 1, `${name} is declared in exactly one native file`)
  return files[0]!
}
for (const name of Object.keys(commands)) {
  const found = NATIVE.flatMap(file => (all(file).filter(node => callName(node) === name) as ts.CallExpression[]).map(call => ({ file, call })))
  assert.equal(found.length, 1, `native delegates ${name} once`)
  const { file: current, call } = found[0]!
  let callback: ts.ArrowFunction | undefined
  for (let parent = call.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isArrowFunction(parent) && callName(parent.parent) === 'updateLedger' && (parent.parent as ts.CallExpression).arguments[1] === parent) { callback = parent; break }
  }
  assert.ok(callback, `${name} decides INSIDE the native retry callback`)
  assert.equal(call.arguments[0]!.getText(current), callback.parameters[0]!.name.getText(current), `${name} receives the CURRENT retry ledger`)
  if (name === 'planStepClear') {
    assert.ok(ts.isVariableDeclaration(call.parent), 'the planner returns its decision inside retry')
    const result = call.parent.name.getText(current)
    const code = callback.getText(current)
    assert.match(code, new RegExp(`arming = ${result}\\.arming`), 'arming follows the decision on every retry')
    assert.match(code, new RegExp(`return ${result}\\.ledger`), 'the same decision supplies the written ledger')
  }
}
const baseline = spawnSync('git', ['show', '95249cfaca36afe9e9ca3b72ffe4f6dad20ba724:track/hooks/register.tsx'], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
assert.equal(baseline.status, 0, 'repaired baseline exists')
assert.equal(createHash('sha256').update(baseline.stdout).digest('hex'), '715775a1b94fa1e0443bfdb34726a9a47405905440fdc1e762a1436701e81889')
const printer = ts.createPrinter({ removeComments: true })
// Prints one press body with its single ledger writer's callback reduced to `cur => cur`.
const blockWiring = (file: ts.SourceFile, name: string, block: ts.Node): string => {
  const writers = all(block).filter(node => callName(node) === 'updateLedger') as ts.CallExpression[]
  assert.equal(writers.length, 1, `${name} retains one native writer`)
  const callback = writers[0]!.arguments[1]!
  const start = block.getStart(file)
  const text = block.getText(file)
  const normalized = text.slice(0, callback.getStart(file) - start) + 'cur => cur' + text.slice(callback.end - start)
  return printer.printFile(parse(`const effect = async () => ${normalized}`))
}
const initializer = (file: ts.SourceFile, name: string): { body: ts.Node } => {
  const declarations = all(file).filter(ts.isVariableDeclaration).filter(node => node.name.getText(file) === name)
  const functions = all(file).filter(ts.isFunctionDeclaration).filter(node => node.name?.getText(file) === name)
  assert.equal(declarations.length + functions.length, 1, `one native ${name} owner`)
  if (functions.length === 1) {
    // A function declaration (the engine follows $ across an import only into one) must be exactly
    // `{ return <the arrow's former concise body> }`.
    const statements = functions[0]!.body?.statements ?? []
    assert.ok(statements.length === 1 && ts.isReturnStatement(statements[0]!) && statements[0]!.expression !== undefined, `${name} only returns its press`)
    return { body: (statements[0] as ts.ReturnStatement).expression! }
  }
  const init = declarations[0]!.initializer!
  assert.ok(ts.isArrowFunction(init), `${name} is an arrow function`)
  return init
}
// TRACK-46 A1/C1 (Ohad's fix list; 742ea67 admission, then the owner token as a write fence):
// every pane press runs inside pressOwned, which admits the current owner first. Its token
// fences the ledger write as the callback's first statement and goes to every gate and save.
// With the token arguments removed, every other effect is compared to the 95249cf baseline.
const FENCED = new Set(['publishGate', 'saveLedger'])
const admittedBody = (file: ts.SourceFile, name: string): string => {
  const outer = initializer(file, name)
  const call = outer.body
  assert.ok(ts.isCallExpression(call) && callName(call) === 'pressOwned' && call.arguments[0]?.getText(file) === '$', `${name}: every effect runs inside pressOwned($, ...)`)
  const press = call.arguments[1]
  assert.ok(press !== undefined && ts.isArrowFunction(press) && press.parameters.length === 1 && press.parameters[0]!.name.getText(file) === 'token', `${name}: the press receives the owner token`)
  const fenced = all(press.body).filter(node => FENCED.has(callName(node) ?? '')) as ts.CallExpression[]
  assert.ok(fenced.length > 0, `${name}: the press publishes or saves`)
  for (const one of fenced) assert.ok(one.arguments.length === 2 && one.arguments[1]!.getText(file) === 'token', `${name}: ${callName(one)} carries the owner token`)
  const writer = (all(press.body).filter(node => callName(node) === 'updateLedger') as ts.CallExpression[])[0]!
  const callback = writer.arguments[1]!
  assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body), `${name}: the ledger writer's callback is a block`)
  const parameter = callback.parameters[0]!.name.getText(file)
  assert.equal(callback.body.statements[0]?.getText(file), `assertOwner(token, ${parameter})`, `${name}: the ledger write is fenced before its decision`)
  const start = press.body.getStart(file)
  let text = press.body.getText(file)
  for (const one of [...fenced].sort((x, y) => y.getStart(file) - x.getStart(file))) {
    const comma = one.arguments[0]!.end - start
    text = text.slice(0, comma) + text.slice(one.arguments[1]!.end - start)
  }
  const unit = parse(`const effect = async () => ${text}`)
  return blockWiring(unit, name, (initializer(unit, 'effect').body))
}
const baselineBody = (file: ts.SourceFile, name: string): string => blockWiring(file, name, initializer(file, name).body)
const baselineFile = parse(baseline.stdout)
for (const name of ['clearQuestions', 'clearSteps', 'clearAnsweredQuestions', 'clearCompletedSteps']) assert.equal(admittedBody(ownerOf(name), name), baselineBody(baselineFile, name), `${name}: all native effects, lifetimes and ordering remain unchanged`)
console.log('bulk clear: literal cases, same-reference arming, 4 wrong implementations rejected, frozen parity, owner-token fencing and native retry/effect placement pass (SOURCE/FIXTURE)')
