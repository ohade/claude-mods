import { expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const DRAWN = '5e5e5e5e-1111-4222-8333-444444444444'
const ROW = '5e5e5e5e-1111-4222-8333'
const PROMPT = '9d9d9d9d-6666-4777-8888-999999999999'
const A1 = `${ROW}:A1`
const A2 = `${ROW}:A2`
const TEXT = `Intro line.\n<!-- A1:start -->\nFirst answer.\n<!-- A1:end -->\nMiddle line.\n<!-- A2:start -->\nSecond answer.\n<!-- A2:end -->\nOutro line.`
const answered = (id: number, answerKey: string) => ({ id, head: `Question ${id}?`, at: id, turnId: 't1', status: 'answered', answerText: `Answer ${id}.`, answerRequestId: DRAWN, answerKey, session_id: SESSION })
const asked = { id: 1, head: 'Where was it asked?', at: 1, turnId: 't1', status: 'answered', askedRequestId: PROMPT, rowKey: '9d9d9d9d-6666-4777-8888', answerText: 'Here.', answerKey: A1, answerRequestId: DRAWN, session_id: SESSION }

const stubRegister: Plugin['register'] = on => {
  on('engine.create', async (_$, e, next) => ({ ...(await next(e)), prismantis: { markdown: async () => undefined, reply: async () => undefined, tint: async () => undefined } }))
  on('prismantis.reply', async ($, e) => {
    const { Box, Text } = $.ui.resolve({ surface: e.surface, component: 'AssistantMessage' })
    $.ui.log(`stub-reply ${e.requestId} ${JSON.stringify(e.segments.map(segment => [segment.kind, segment.key, segment.text]))}`, { to: 'debug' })
    return { value: <Box key="stub-frame" flexDirection="column">{e.segments.map(segment => <Text key={segment.key}>{segment.text}</Text>)}</Box> }
  })
  on('prismantis.tint', async ($, e) => {
    $.ui.log(`stub-tint ${e.key} ${e.color ?? 'null'}`, { to: 'debug' })
    return { value: undefined }
  })
}

const outer: Plugin = { name: 'prismantis', tier: 'prepend', register: stubRegister }
const inner: Plugin = { name: 'prismantis', tier: 'append', register: stubRegister }

const prepare = (on: On, held: object) => {
  const clock = mock.clock(on)
  const pool = blobPool(on)
  const ledgerAtom = atomStore(on, 'ledger', held)
  const rendersAtom = atomStore(on, 'renders', { session: null, rows: [] } as { session: string | null; rows: [string, string][] })
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, savedAt: 1, ledger: held } })
  on('session.id', () => ({ value: SESSION }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  on('ui.render', { component: 'UserMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  return { clock, pool, store, ledgerAtom, rendersAtom, lines: logs(on) }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const drawReply = ($: Engine, text = TEXT) => $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, viewport: { columns: 100, rows: 40 }, props: { text, isFirstOfReply: true, onScreen: null } } as never)
const tints = (lines: string[]) => lines.filter(line => line.startsWith('stub-tint ')).map(line => line.slice('stub-tint '.length).split(' ') as [string, string])
const replies = (lines: string[]) => lines.filter(line => line.startsWith('stub-reply '))

for (const stub of [outer, inner]) {
  const order = stub.tier === 'prepend' ? 'outer' : 'inner'

  test(`a reply with answer blocks is drawn by Prismantis with Track's exact segments, keys and acknowledgements (${order} Prismantis)`, { plugins: [stub] }, async ($, on) => {
    const fixture = prepare(on, { ...EMPTY, nextQuestionId: 3, questions: [answered(1, A1), answered(2, A2)], session_id: SESSION })
    await start($)
    const ui = await drawReply($)
    await fixture.clock.settle()
    expect(await ui.find({ key: 'stub-frame' })).toBeDefined()
    const sent = replies(fixture.lines)
    expect(sent.length).toBeGreaterThan(0)
    const [requestId, json] = [sent.at(-1)!.split(' ')[1], sent.at(-1)!.split(' ').slice(2).join(' ')]
    expect(requestId).toBe(DRAWN)
    const segments = JSON.parse(json!) as [string, string, string][]
    expect(segments.map(([kind]) => kind)).toEqual(['markdown', 'markdown', 'note', 'markdown', 'markdown', 'note', 'markdown'])
    expect(segments[0]![1]!.startsWith('before:')).toBe(true)
    expect(segments.slice(1, 3).map(([, key]) => key)).toEqual([`answer:${A1}`, `ack:${A1}`])
    expect(segments[3]![1]!.startsWith('before:')).toBe(true)
    expect(segments.slice(4, 6).map(([, key]) => key)).toEqual([`answer:${A2}`, `ack:${A2}`])
    expect(segments[6]![1]).toBe('after-answers')
    expect(segments.map(([, , text]) => text)).toEqual(['Intro line.', 'First answer.', '✓ Q1. answered', 'Middle line.', 'Second answer.', '✓ Q2. answered', 'Outro line.'])
  })

  test(`[ A ] tints exactly the answer segment through Prismantis and clears it when the fade ends (${order} Prismantis)`, { plugins: [stub] }, async ($, on) => {
    const fixture = prepare(on, { ...EMPTY, nextQuestionId: 3, questions: [answered(1, A1), answered(2, A2)], session_id: SESSION })
    await start($)
    await drawReply($)
    await fixture.clock.settle()
    const ui = await $.ui.mount(pane('dock'))
    await ui.press({ key: 'a-2' })
    await fixture.clock.advance(5000)
    await fixture.clock.settle()
    const calls = tints(fixture.lines)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every(([key]) => key === `answer:${A2}`)).toBe(true)
    expect(calls.some(([, color]) => color !== 'null')).toBe(true)
    expect(calls.at(-1)).toEqual([`answer:${A2}`, 'null'])
    expect(calls.some(([key]) => key === DRAWN || key === ROW || key === A2)).toBe(false)
  })

  test(`a quick [ A ] on Q1 then Q2 leaves Q1 cleared and never relights it (${order} Prismantis)`, { plugins: [stub] }, async ($, on) => {
    const fixture = prepare(on, { ...EMPTY, nextQuestionId: 3, questions: [answered(1, A1), answered(2, A2)], session_id: SESSION })
    await start($)
    await drawReply($)
    await fixture.clock.settle()
    const ui = await $.ui.mount(pane('dock'))
    await ui.press({ key: 'a-1' })
    await ui.press({ key: 'a-2' })
    await fixture.clock.advance(5000)
    await fixture.clock.settle()
    const calls = tints(fixture.lines)
    const firstSecond = calls.findIndex(([key, color]) => key === `answer:${A2}` && color !== 'null')
    expect(firstSecond).toBeGreaterThan(0)
    expect(calls.slice(firstSecond).some(([key, color]) => key === `answer:${A1}` && color !== 'null')).toBe(false)
    expect(calls.filter(([key]) => key === `answer:${A1}`).at(-1)).toEqual([`answer:${A1}`, 'null'])
    expect(calls.at(-1)).toEqual([`answer:${A2}`, 'null'])
  })

  test(`[ Q ] tints the prompt's full request id through Prismantis (${order} Prismantis)`, { plugins: [stub] }, async ($, on) => {
    const fixture = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [asked], session_id: SESSION })
    await start($)
    const ui = await $.ui.mount(pane('dock'))
    await ui.press({ key: 'q-1' })
    await fixture.clock.advance(5000)
    await fixture.clock.settle()
    const calls = tints(fixture.lines)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every(([key]) => key === PROMPT)).toBe(true)
    expect(calls.some(([, color]) => color !== 'null')).toBe(true)
    expect(calls.at(-1)).toEqual([PROMPT, 'null'])
  })

  test(`after a cold resume with an empty render map, [ A ] still tints answer:<answerKey>, never the host (${order} Prismantis)`, { plugins: [stub] }, async ($, on) => {
    const fixture = prepare(on, { ...EMPTY, nextQuestionId: 3, questions: [answered(1, A1), answered(2, A2)], session_id: SESSION })
    await start($)
    await drawReply($)
    await fixture.clock.settle()
    fixture.ledgerAtom.value = EMPTY
    fixture.ledgerAtom.version += 1
    fixture.rendersAtom.value = { session: null, rows: [] }
    fixture.rendersAtom.version += 1
    await start($)
    await fixture.clock.settle()
    const before = tints(fixture.lines).length
    const ui = await $.ui.mount(pane('dock'))
    await ui.press({ key: 'a-1' })
    await fixture.clock.advance(5000)
    await fixture.clock.settle()
    const calls = tints(fixture.lines).slice(before)
    expect(calls.some(([key, color]) => key === `answer:${A1}` && color !== 'null')).toBe(true)
    expect(calls.every(([key]) => key === `answer:${A1}`)).toBe(true)
  })
}

test('without Prismantis, an answer reply keeps Track\'s own tree and [ A ] still lights it with no error', async ($, on) => {
  const fixture = prepare(on, { ...EMPTY, nextQuestionId: 3, questions: [answered(1, A1), answered(2, A2)], session_id: SESSION })
  await start($)
  const reply = await drawReply($)
  await fixture.clock.settle()
  expect(await reply.find({ key: `answer:${A2}` })).toBeDefined()
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-2' })
  expect((await reply.find({ key: `answer:${A2}` }))?.props.backgroundColor).toBeDefined()
  await fixture.clock.settle()
  expect(fixture.lines.some(line => /prismantis|tint failed/i.test(line))).toBe(false)
})
