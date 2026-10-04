import { expect, test } from 'claude-code/testing'

// The kit cannot raise session.append in this build (2.1.289): it skips any
// session.append answer that does not call next, the test's own included, and
// nothing sits beneath the test. So these tests start from a stored thumbnail,
// answered by the test's state.get hook, and stand in for sips and the disk;
// a stand-in answers an operation as { value: <its result> }.

// A 4x2 PNG: what the Image draws, whatever size the record says.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGM4kWIERwzIHACS+grxS06IwAAAAABJRU5ErkJggg=='

// The id the transcript draws the row under (its stored id with the last
// group zeroed), and the key the mod stores the row's thumbnails under.
const DRAWN_ID = 'b3bcd931-da69-4b4e-9d30-000000000000'
const ROW_KEY = 'b3bcd931-da69-4b4e-9d30'

// A 64x32 picture: 5 rows in a 94-column room are 21 columns wide.
const THUMB = { png: PNG, width: 64, height: 32, n: 1, originalPath: '/private/tmp/thumbs-test/original' }

const userMessage = (requestId: string) => ({
  plugin: 'image-thumbs',
  surface: 'terminal' as const,
  component: 'UserMessage' as const,
  requestId,
  viewport: { columns: 100, rows: 40 },
  props: { text: 'look at this [Image #1]', origin: { kind: 'composer' as const }, isExpanded: false },
})

const engineRow = { component: 'UserMessage' } as const

test('a stored thumbnail draws framed under its prompt row, 5 rows tall', async ($, on) => {
  on('state.get', { plugin: 'image-thumbs', key: 'byRow' }, (_, e, next) =>
    e.id === ROW_KEY ? { value: { value: [THUMB], version: 1 } } : next(e),
  )
  on('ui.render', engineRow, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))

  const ui = await $.ui.mount(userMessage(DRAWN_ID))

  const images = await ui.findAll({ type: 'Image' })
  expect(images).toHaveLength(1)
  expect(images[0]?.props).toMatchObject({ rows: 5, columns: 21, alt: '[Image #1]' })
  expect((await ui.find({ type: 'Text', text: /click the picture to expand/ }))?.text).toContain('#1')
  expect((await ui.find({ type: 'Text' }))?.text).toBe('look at this [Image #1]')
})

test('a row with no stored thumbnail draws as the engine draws it', async ($, on) => {
  on('ui.render', engineRow, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))

  const ui = await $.ui.mount(userMessage('a2e93b95-8f6e-4224-ae43-000000000000'))

  expect(await ui.findAll({ type: 'Image' })).toHaveLength(0)
})

test('a click on the picture expands it in place and a second click shrinks it', async ($, on) => {
  on('state.get', { plugin: 'image-thumbs', key: 'byRow' }, (_, e, next) =>
    e.id === ROW_KEY ? { value: { value: [THUMB], version: 1 } } : next(e),
  )
  on('ui.render', engineRow, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  // sips: the size query answers 64x32; every other command succeeds silently.
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('-g') ? 'pixelWidth: 64\npixelHeight: 32\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1000, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: { base64: PNG } }))

  const ui = await $.ui.mount(userMessage(DRAWN_ID))
  // A left click released over the picture's click area (click-area.ts).
  const click = { type: 'up' as const, x: 2, y: 1, button: 'left' as const, in: `click-${ROW_KEY}-0` }

  // 64x32 is never scaled up: 24 rows of a 94-column room fit 94 columns by 22 rows.
  await ui.pointer(click)
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 94, rows: 22 })
  expect(await ui.find({ type: 'Text', text: /click the picture to shrink/ })).toBeDefined()

  await ui.pointer(click)
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 21, rows: 5 })
})
