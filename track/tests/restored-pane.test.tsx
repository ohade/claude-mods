// FIXTURE: a restored row has no scrollable notice, so Q/A show the saved
// text in the pane. A button with nothing saved stays dim and never toasts.
// A question drawn in this session still jumps to its own row.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, logs, pane } from './kit'

const FROM = '11111111-2222-4333-8444-555555555555'
const BY = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const LIVE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

test('a restored question with no saved text does not toast', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: ' ', at: 1, turnId: 'restored', status: 'open', restoredFrom: FROM, restoredBy: BY }] })
  const debug = logs(on)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'q-1' })
  expect(debug.some(line => line.includes('cannot jump'))).toBe(false)
  expect(debug.filter(line => line.startsWith('track: jump'))).toEqual([])
})

test('a question drawn in this session still jumps to its row', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Live question', at: 1, turnId: 't1', status: 'open', rowKey: LIVE.split('-').slice(0, 4).join('-'), askedRequestId: LIVE }] })
  const debug = logs(on)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'q-1' })
  expect(debug.filter(line => line.startsWith('track: jump'))).toEqual([`track: jump {"to":{"requestId":"${LIVE}"},"block":"start"}`])
})
