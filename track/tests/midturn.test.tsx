import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, atomStore, pane } from './kit'
import type { Engine, On } from './kit'

// [ Q ] for a question typed while a turn runs. Such a message is not a new prompt: the engine
// folds it into the running turn as a `queued_command` attachment, appended by the `delivery`
// door. Questions asked that way anchored to an older row and showed only [ A ].

type Prompt = { rowKey: string; requestId?: string }
type Question = { id: number; rowKey?: string; askedRequestId?: string }
type Ledger = { prompts: Prompt[]; questions: Question[] }

const TYPED = 'a0000001-0000-4000-8000'
const MIDTURN = 'b0000002-0000-4000-8000'
const PEER = 'c0000003-0000-4000-8000'

// The kit stores no row (nothing beneath the plugins answers session.append), so the append
// rejects once the mod's hook has run.
const append = async ($: Engine, row: Record<string, unknown>) => {
  await $.session.append(row as never).catch(() => undefined)
}

const typed = (key: string, text: string) => ({
  door: 'prompt',
  origin: { kind: 'composer' },
  uuid: `${key}-000000000001`,
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
})

const midTurn = (key: string, text: string, origin: Record<string, unknown> = { kind: 'composer' }) => ({
  door: 'delivery',
  origin,
  uuid: `${key}-000000000001`,
  message: { type: 'attachment', name: 'queued_command', role: 'user', content: [{ type: 'text', text }] },
})

// The engine draws a row under its uuid with the last group zeroed; the timer writes the link.
const draw = async ($: Engine, clock: { advance: (ms: number) => Promise<unknown> }, key: string) => {
  const ui = await $.ui.mount({
    plugin: 'track',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: `${key}-000000000000`,
    props: { text: 'a row', origin: { kind: 'composer' }, isExpanded: false },
  } as never)
  await clock.advance(10)
  await ui.unmount()
}

const track = ($: Engine, summary: string, source = MIDTURN) => $.tool.call({ tool: 'mcp__track__track_question', tool_use_id: 'toolu_q', summary, source_request_id: `${source}-000000000000` } as never)

const setUp = (on: On) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'flash', 0)
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Text', props: {}, children: ['a row'] }))

  return { clock, ledger }
}

const qButton = async ($: Engine) => {
  const ui = await $.ui.mount(pane('dock'))

  return (await ui.findAll({ type: 'Button' })).find(b => b.key === 'q-1')
}

test('a question typed mid-turn links to that message row and draws [ Q ]', async ($, on) => {
  const { clock, ledger } = setUp(on)
  await append($, typed(TYPED, 'build the report'))
  await draw($, clock, TYPED)

  await append($, midTurn(MIDTURN, 'is the build green?'))
  await draw($, clock, MIDTURN)
  await track($, 'Is the build green?')

  expect(ledger.value.questions.at(-1)).toMatchObject({ rowKey: MIDTURN, askedRequestId: `${MIDTURN}-000000000000` })
  expect((await qButton($))?.props).toMatchObject({ label: 'Q' })
})

// The question is often tracked before the row is drawn; the draw then links it.
test('a mid-turn question tracked before its row is drawn is linked by the draw', async ($, on) => {
  const { clock, ledger } = setUp(on)
  await append($, midTurn(MIDTURN, 'is the build green?'))
  await track($, 'Is the build green?')

  await draw($, clock, MIDTURN)

  expect(ledger.value.questions.at(-1)).toMatchObject({ rowKey: MIDTURN, askedRequestId: `${MIDTURN}-000000000000` })
})

// A subagent's hand-back reaches the main loop by the prompt door under its sender's origin. It
// is not the person's message, and its row is never linked, so it must not take the anchor.
test('a hand-back folded in after the mid-turn message does not take its question', async ($, on) => {
  const { clock, ledger } = setUp(on)
  await append($, midTurn(MIDTURN, 'is the build green?'))
  await draw($, clock, MIDTURN)
  await append($, { ...typed(PEER, '<agent-message from="a1">the report</agent-message>'), origin: { kind: 'peer' } })

  await track($, 'Is the build green?')

  expect(ledger.value.questions.at(-1)).toMatchObject({ rowKey: MIDTURN, askedRequestId: `${MIDTURN}-000000000000` })
})

// A task notification is delivered by the same door, but it is no one's question.
test('a task notification delivered mid-turn is not recorded as a prompt', async ($, on) => {
  const { ledger } = setUp(on)

  await append($, midTurn(MIDTURN, '<task-notification><task-id>b1</task-id></task-notification>', { kind: 'task-notification' }))

  expect(ledger.value.prompts).toEqual([])
})

// A slash command typed mid-turn is still not a prompt, as at the prompt door.
test('a slash command typed mid-turn is not recorded as a prompt', async ($, on) => {
  const { ledger } = setUp(on)

  await append($, midTurn(MIDTURN, '/compact'))

  expect(ledger.value.prompts).toEqual([])
})

// No regression: a question in a normal prompt still links to that prompt's own row.
test('a question in a typed prompt links to its own prompt row', async ($, on) => {
  const { clock, ledger } = setUp(on)
  await append($, typed(TYPED, 'what is the capital of Australia?'))
  await draw($, clock, TYPED)

  await track($, 'What is the capital of Australia?', TYPED)

  expect(ledger.value.questions.at(-1)).toMatchObject({ rowKey: TYPED, askedRequestId: `${TYPED}-000000000000` })
  expect((await qButton($))?.props).toMatchObject({ label: 'Q' })
})
