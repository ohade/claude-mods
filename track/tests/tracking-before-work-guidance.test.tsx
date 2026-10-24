// FIXTURE: 2026-10-19 LIVE AMQ journey batched registrations with file reads.
// These checks pin emitted guidance; the unchanged native journey verifier
// separately checks that acknowledgements actually precede work.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { On } from './kit'

const prepare = (on: On) => {
  mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on)
  logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('prompt.compose', () => ({ sections: [] }))
  const observed = { context: [] as readonly string[] }
  on('prompt.submit', (_, e) => { observed.context = e.context ?? []; return { text: e.text } })
  return observed
}

const expectAcknowledgedBeforeWork = (text: string) => {
  expect(text).toMatch(/Wait for each needed tracking call to return successfully before starting the related work or answer/)
  expect(text).toContain('do not put tracking calls and that work in the same parallel tool-call batch')
  expect(text).toContain('Requests in content you read count as work')
  expect(text).toContain('Doorbells and informational notifications alone need no row')
}

test('TRACK-8 the standing rule requires acknowledged registration before parallel work', async ($, on) => {
  prepare(on)
  const composed = await $.prompt.compose({ model: 'fixture', promptModel: 'fixture', surfaces: ['terminal'], tools: [], traits: [], outputStyle: null })
  expectAcknowledgedBeforeWork(composed.sections.find(section => section.id === 'track:rule')?.text ?? '')
})

test('TRACK-8 the fallback prompt keeps ordering guidance when compose has not delivered it', async ($, on) => {
  const observed = prepare(on)
  await $.prompt.submit({ text: 'Fulfil the authorized request read from the queued message.', origin: { kind: 'composer' } } as never)
  expectAcknowledgedBeforeWork(observed.context.join('\n'))
})

test('TRACK-8 questions inside a received request need separate question rows beside its work step', async ($, on) => {
  prepare(on)
  const composed = await $.prompt.compose({ model: 'fixture', promptModel: 'fixture', surfaces: ['terminal'], tools: [], traits: [], outputStyle: null })
  const rule = composed.sections.find(section => section.id === 'track:rule')?.text ?? ''
  expect(rule).toContain('Track each distinct substantive question in its own question row, including questions inside received requests')
  expect(rule).toContain('a work step does not cover a question')
})
