import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The kit cannot raise session.append in this build (2.1.292): it skips any
// session.append answer that does not call next, the test's own included, and
// nothing sits beneath the test. So these tests start from a stored thumbnail,
// answered by the test's state.get hook, and stand in for sips and the disk;
// a stand-in answers an operation as { value: <its result> }. What a row's
// pictures are numbered is tested in numbers.test.ts.

// A 4x2 PNG: what the Image draws, whatever size the record says.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGM4kWIERwzIHACS+grxS06IwAAAAABJRU5ErkJggg=='

// A 64x32 picture: 5 rows in a 94-column room are 21 columns wide.
const thumb = (n: number) => ({ png: PNG, width: 64, height: 32, n, originalPath: `/private/tmp/thumbs-test/${n}` })

// Rows drawn under ids the mod never saw: it finds a picture by the number
// the row's text names, not by the row.
const userMessage = (text: string, requestId = 'a2e93b95-8f6e-4224-ae43-000000000000') => ({
  plugin: 'image-thumbs',
  surface: 'terminal' as const,
  component: 'UserMessage' as const,
  requestId,
  viewport: { columns: 100, rows: 40 },
  props: { text, origin: { kind: 'composer' as const }, isExpanded: false },
})

const engineRow = { component: 'UserMessage' } as const

// Thumbnails stored under these image numbers.
const storeThumbs = (on: On, numbers: number[]) => {
  on('state.get', { plugin: 'image-thumbs', key: 'byImage' }, (_, e, next) =>
    numbers.includes(Number(e.id)) ? { value: { value: thumb(Number(e.id)), version: 1 } } : next(e),
  )
  on('ui.render', engineRow, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
}

test('a stored thumbnail draws framed under the prompt row that names it, 5 rows tall', async ($, on) => {
  storeThumbs(on, [1])

  const ui = await $.ui.mount(userMessage('look at this [Image #1]'))

  const images = await ui.findAll({ type: 'Image' })
  expect(images).toHaveLength(1)
  expect(images[0]?.props).toMatchObject({ rows: 5, columns: 21, alt: '[Image #1]' })
  expect((await ui.find({ type: 'Text', text: /click the picture to expand/ }))?.text).toContain('#1')
  expect((await ui.find({ type: 'Text' }))?.text).toBe('look at this [Image #1]')
})

test('a row that names no stored picture draws as the engine draws it', async ($, on) => {
  storeThumbs(on, [1])

  const untagged = await $.ui.mount(userMessage('no picture here', 'c1000000-0000-4000-8000-000000000000'))
  const unknown = await $.ui.mount(userMessage('an unknown [Image #9]', 'c2000000-0000-4000-8000-000000000000'))

  expect(await untagged.findAll({ type: 'Image' })).toHaveLength(0)
  expect(await unknown.findAll({ type: 'Image' })).toHaveLength(0)
})

test('a slash command row draws the thumbnails its [Image #n] tags name', async ($, on) => {
  // The pictures came in on the command's expansion, a row of their own.
  storeThumbs(on, [2, 3])

  const ui = await $.ui.mount(userMessage('/recall look at these [Image #2] [Image #3]'))

  const images = await ui.findAll({ type: 'Image' })
  expect(images.map(image => image.props.alt)).toEqual(['[Image #2]', '[Image #3]'])
})

test('a message sent while Claude works draws its thumbnail', async ($, on) => {
  // The picture came in on the attachment that folds the message into the turn.
  storeThumbs(on, [4])

  const ui = await $.ui.mount(userMessage('why is it blank? [Image #4]', '8a8b0111-01c9-465e-9864-e5453358cf5d'))

  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #4]' })
})

test('a thumbnail frame lights up once shortly after it first draws, and the picture is not sent again', async ($, on) => {
  storeThumbs(on, [1])

  const ui = await $.ui.mount(userMessage('look at this [Image #1]'))
  const frame = async () => (await ui.findAll({ type: 'Box' })).find(box => box.props.borderStyle === 'round')?.props
  expect(await frame()).toMatchObject({ borderDimColor: true })

  // The border cells on the picture's rows change, so the terminal paints those rows again.
  await ui.advance(300)
  expect(await frame()).toMatchObject({ borderDimColor: false })

  await ui.advance(300)
  expect(await frame()).toMatchObject({ borderDimColor: true })

  // Once, and the picture's bytes never change: sending them again is what can blank it.
  await ui.advance(1000)
  expect(await frame()).toMatchObject({ borderDimColor: true })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
})

test('a click on the picture expands it in place and a second click shrinks it', async ($, on) => {
  storeThumbs(on, [1])
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

  const ui = await $.ui.mount(userMessage('look at this [Image #1]'))
  // A left click released over the picture's click area (click-area.ts).
  const click = { type: 'up' as const, x: 2, y: 1, button: 'left' as const, in: 'click-1' }

  // 64x32 is never scaled up: 24 rows of a 94-column room fit 94 columns by 22 rows.
  await ui.pointer(click)
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 94, rows: 22 })
  expect(await ui.find({ type: 'Text', text: /click the picture to shrink/ })).toBeDefined()

  await ui.pointer(click)
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 21, rows: 5 })
})
