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

// sips, base64, mktemp and rm: the size query answers 64x32, mktemp a folder,
// every other command succeeds silently; the PNG is read back as PNG.
const standInForDisk = (on: On) => {
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('-g')
        ? 'pixelWidth: 64\npixelHeight: 32\n'
        : e.argv[0] === '/usr/bin/mktemp'
          ? '/private/tmp/thumbs-test\n'
          : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.write', () => ({ value: undefined }))
}

test("a skill's slash command draws the picture its expansion brings in on a note row", async ($, on) => {
  standInForDisk(on)
  on('ui.render', engineRow, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))

  // A skill's expansion is a meta row of its own, by the note door; the
  // command's row before it carries the text alone. The kit cannot store the
  // row (nothing beneath the plugins answers session.append, and it skips a
  // test's own answer), so the append rejects; the mod has built the
  // thumbnail by then, before it hands the row on.
  const appended = $.session.append({
    door: 'note',
    origin: { kind: 'engine' },
    uuid: 'b0000000-0000-4000-8000-000000000001',
    message: {
      type: 'user',
      role: 'user',
      isMeta: true,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        { type: 'text', text: 'Base directory for this skill: /skills/recall\n\nARGUMENTS: look at this [Image #1]' },
      ],
    },
  })
  await expect(appended).rejects.toThrow('no implementation for session.append')
  const ui = await $.ui.mount(userMessage('/recall look at this [Image #1]'))

  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #1]' })
})

// Claude Code saves a pasted picture at paste time as
// $TMPDIR/clipboard-<local time>-<id>.png. A file name saved `secondsAgo` ago.
const savedName = (secondsAgo: number, id: string) => {
  const at = new Date(Date.now() - secondsAgo * 1000)
  const two = (part: number) => String(part).padStart(2, '0')
  const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`

  return `/private/tmp/tmpdir/clipboard-${day}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-${id}.png`
}

// The disk as standInForDisk has it, with these pasted pictures saved in the
// temp folder; the copies the mod makes of them are recorded in `copied`.
// The session's own folder is found, and holds images/<n>.png for `inFolder`.
const standInForSavedPictures = (on: On, saved: string[], copied: string[], inFolder: number[] = []) => {
  on('session.id', () => ({ value: 'session-folder' }))
  on('fs.stat', (_, e) => {
    const n = Number(/\/session-folder\/images\/(\d+)\.png$/.exec(e.path)?.[1])
    if (!inFolder.includes(n)) {
      throw new Error(`no such file: ${e.path}`)
    }

    return { value: { kind: 'file' as const, size: 1000, mtimeMs: 0, isLink: false } }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/cp') {
      copied.push(e.argv[1] ?? '')
    }
    const stdout =
      e.argv[0] === '/usr/bin/getconf'
        ? '/private/tmp/tmpdir/\n'
        : e.argv[0] === '/usr/bin/id'
          ? '501\n'
          : e.argv[0] === '/usr/bin/find' && e.argv.includes('clipboard-*')
            ? saved.map(path => `${path}\n`).join('')
            : e.argv[0] === '/usr/bin/find'
              ? '/private/tmp/claude-501/-Users-me-git/session-folder\n'
              : e.argv.includes('-g')
            ? 'pixelWidth: 64\npixelHeight: 32\n'
            : e.argv[0] === '/usr/bin/mktemp'
              ? '/private/tmp/thumbs-test\n'
              : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('ui.render', engineRow, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
}

// How a command is shown: the main screen, 100 columns.
const PRESENTATION = { isFullscreen: false, columns: 100 }

// The kit's engine raises prompt.edit, though its types leave that call out.
const promptEdit = ($: unknown, e: Record<string, unknown>) =>
  ($ as { prompt: { edit: (edit: Record<string, unknown>) => Promise<unknown> } }).prompt.edit(e)

// The kit has nothing beneath the plugins to run a command or enter a prompt,
// so the call may reject once the mod's hook has handed it on.
const settle = async (call: Promise<unknown>) => {
  await call.catch(() => undefined)
}

test("a slash command's row draws the picture pasted into it, before any row brings the picture's bytes", async ($, on) => {
  const copied: string[] = []
  standInForSavedPictures(on, [savedName(2, '6524ECCF')], copied)

  // Live, the command's row is printed before the row carrying the picture
  // arrives, and a printed row is not drawn again: the thumbnail must exist
  // when the command runs.
  await settle($.command.run({ command: 'recall', args: 'look at this [Image #1]', origin: { kind: 'composer' }, presentation: PRESENTATION }))
  const ui = await $.ui.mount(userMessage('/recall look at this [Image #1]'))

  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #1]' })
  expect(copied).toEqual([savedName(2, '6524ECCF')])
})

test("a picture pasted from the clipboard is drawn from the session's images folder, by its number", async ($, on) => {
  const copied: string[] = []
  // A clipboard paste is saved as <session folder>/images/<n>.png; no
  // clipboard-* file is written for it.
  standInForSavedPictures(on, [], copied, [5])

  await settle(
    $.command.run({ command: 'recall', args: 'test [Image #5]', origin: { kind: 'composer' }, presentation: PRESENTATION }),
  )
  const ui = await $.ui.mount(userMessage('/recall test [Image #5]'))

  expect(copied).toEqual(['/private/tmp/claude-501/-Users-me-git/session-folder/images/5.png'])
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #5]' })
})

const assistantMessage = (text: string, requestId: string) => ({
  plugin: 'image-thumbs',
  surface: 'terminal' as const,
  component: 'AssistantMessage' as const,
  requestId,
  viewport: { columns: 100, rows: 40 },
  props: { text, isFirstOfReply: true },
})

test("a slash command's pictures are drawn above the first text of Claude's reply", async ($, on) => {
  standInForSavedPictures(on, [], [], [5])
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))

  // Live, the command's own row is drawn by the engine with no render hook,
  // so its pictures go on the first row of the reply that has text.
  await settle(
    $.command.run({ command: 'recall', args: 'test [Image #5]', origin: { kind: 'composer' }, presentation: PRESENTATION }),
  )
  await settle(
    $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'claude-test' },
      uuid: 'd0000000-0000-4000-8000-000000000001',
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Image #5 arrived.' }] },
    }),
  )
  const reply = await $.ui.mount(assistantMessage('Image #5 arrived.', 'd0000000-0000-4000-8000-000000000000'))
  const earlier = await $.ui.mount(assistantMessage('An earlier reply.', 'e0000000-0000-4000-8000-000000000000'))

  expect((await reply.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #5]' })
  expect(await earlier.findAll({ type: 'Image' })).toHaveLength(0)
})

test('a prompt sent while Claude works draws its picture from the file saved when it was pasted', async ($, on) => {
  standInForSavedPictures(on, [savedName(1, 'A1B2C3D4')], [])

  await settle($.prompt.submit({ text: 'why is it blank? [Image #4]', attachments: [{ type: 'image', mediaType: 'image/png' }], wait: false, origin: { kind: 'composer' } }))
  const ui = await $.ui.mount(userMessage('why is it blank? [Image #4]', '8a8b0111-01c9-465e-9864-e5453358cf5d'))

  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #4]' })
})

test('the file saved nearest the paste is the one drawn', async ($, on) => {
  const copied: string[] = []
  standInForSavedPictures(on, [savedName(40, '0000000A'), savedName(0, '0000000B')], copied)

  await settle(promptEdit($, { origin: { kind: 'composer' }, text: 'look ', cursor: 5, start: 5, end: 5, inputText: ' [Image #2]' }))
  await settle($.command.run({ command: 'recall', args: 'look [Image #2]', origin: { kind: 'composer' }, presentation: PRESENTATION }))

  expect(copied).toEqual([savedName(0, '0000000B')])
})

test('with no paste seen and two files saved since the last prompt, neither is taken', async ($, on) => {
  const copied: string[] = []
  // One may be another session's paste: drawing it under this prompt would show the wrong picture.
  standInForSavedPictures(on, [savedName(5, '0000000C'), savedName(3, '0000000D')], copied)

  await settle($.command.run({ command: 'recall', args: 'look [Image #3]', origin: { kind: 'composer' }, presentation: PRESENTATION }))
  const ui = await $.ui.mount(userMessage('/recall look [Image #3]'))

  expect(copied).toEqual([])
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(0)
})

test('a message sent while Claude works draws its thumbnail', async ($, on) => {
  // The picture came in on the attachment that folds the message into the turn.
  storeThumbs(on, [4])

  const ui = await $.ui.mount(userMessage('why is it blank? [Image #4]', '8a8b0111-01c9-465e-9864-e5453358cf5d'))

  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #4]' })
})

test('a thumbnail is drawn again as a new picture once, shortly after it first draws', async ($, on) => {
  storeThumbs(on, [1])

  const ui = await $.ui.mount(userMessage('look at this [Image #1]'))
  const first = await ui.find({ type: 'Image' })

  // Live, a thumbnail's first drawing can stay blank until a window resize,
  // which sends every picture again and writes its cells again. A new key
  // does that for this picture alone: a new image id, sent, new cells.
  await ui.advance(300)
  const second = await ui.find({ type: 'Image' })
  expect(second?.key).not.toEqual(first?.key)
  expect(second?.props.source).toEqual({ png: PNG })

  // Once: later frames keep it.
  await ui.advance(1000)
  expect((await ui.find({ type: 'Image' }))?.key).toEqual(second?.key)
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
