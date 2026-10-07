import type { EngineInterface, Register } from 'claude-code'

import type { Pasted, Shown, Thumb } from '../types'
import { freshNumbers, imageNumbers } from './numbers.ts'

const BY_IMAGE = { plugin: 'image-thumbs', key: 'byImage' } as const
const SHOWN = { plugin: 'image-thumbs', key: 'shown' } as const
const PASTED = { plugin: 'image-thumbs', key: 'pasted' } as const
const EXPANDED = { plugin: 'image-thumbs', key: 'expanded' } as const
const REPAINTS = { plugin: 'image-thumbs', key: 'repaints' } as const
const CLAIMED = { plugin: 'image-thumbs', key: 'claimed' } as const
const PASTED_AT = { plugin: 'image-thumbs', key: 'pastedAt' } as const
const USED = { plugin: 'image-thumbs', key: 'used' } as const
const SUBMITTED = { plugin: 'image-thumbs', key: 'submittedAt' } as const

const PANE = 'image-view'

// The rows that carry a pasted picture among their blocks: a typed prompt and
// a slash command's expansion. A skill's expansion (/recall ...) is a meta row
// of its own by the note door; the command's row before it has the text alone.
// A message sent mid-turn comes in by the delivery door with its text alone.
// Most thumbnails are built at submit from the saved files; these rows build
// the rest from their own bytes.
const PICTURE_DOORS = ['prompt', 'command', 'attachment', 'note'] as const

// Thumbnail height in terminal rows; the width follows the picture's aspect.
const ROWS = 5
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2.1
// An expanded picture's height cap in rows, so one never fills the screen.
const EXPANDED_ROWS = 24
// Docked beside a fullscreen transcript the pane asks for this many columns;
// seated inline above the prompt (main screen, narrow terminal), this many rows.
const PANE_COLUMNS = 100
const PANE_ROWS = 40

type ImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type?: string; data: string }
}

type Block = { type: string; [field: string]: unknown }

const isImageBlock = (block: Block): block is ImageBlock => {
  const source = block.source as { type?: string; data?: unknown } | undefined

  return block.type === 'image' && source?.type === 'base64' && typeof source.data === 'string'
}

const textOf = (blocks: Block[]): string => blocks.map(block => (block.type === 'text' ? String(block.text) : '')).join('\n')

// Pictures: decoding pasted bytes to disk, resizing with macOS sips, and
// deleting what is no longer needed. They stay in this file because the
// engine follows $ only into functions declared in the hooks module itself.

// Thumbnail pixels: 240 tall covers 5 rows of a Retina cell (about 40 px)
// with room to spare; the width cap only bites on very wide pictures.
const THUMB_HEIGHT = 240
const THUMB_MAX_WIDTH = 1600
// The large view's longest side, tried in order while the PNG is over the
// 2 MiB an Image takes as bytes.
const VIEW_SIDES = [2048, 1600, 1200, 900]
const MAX_PNG_BYTES = 2 * 1024 * 1024

type Size = { width: number; height: number }

const runOrThrow = async ($: EngineInterface, argv: string[], stdin?: string): Promise<string> => {
  const result = await $.process.run(argv, stdin === undefined ? undefined : { stdin })
  if (result.exitCode !== 0) {
    throw new Error(`${argv[0]} exited ${result.exitCode}: ${result.stderr.trim()}`)
  }

  return result.stdout
}

const pixelSize = async ($: EngineInterface, path: string): Promise<Size> => {
  const out = await runOrThrow($, ['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
  const width = Number(/pixelWidth: (\d+)/.exec(out)?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(out)?.[1])
  if (!(width > 0 && height > 0)) {
    throw new Error(`sips gave no size for ${path}`)
  }

  return { width, height }
}

// Writes `from` as a PNG at `to`, scaled down (never up) to fit the box, with
// macOS sips, which also reads JPEG, GIF and WebP; an Image draws PNG only.
const writePng = async ($: EngineInterface, from: string, to: string, box: Size): Promise<Size> => {
  const size = await pixelSize($, from)
  const scale = Math.min(1, box.width / size.width, box.height / size.height)
  const out = {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
  const resample = scale < 1 ? ['-z', String(out.height), String(out.width)] : []
  await runOrThrow($, ['/usr/bin/sips', '-s', 'format', 'png', ...resample, from, '--out', to])

  return out
}

// Reads a PNG as base64 and deletes the file. The delete is best effort: a
// leftover stays in the private $TMPDIR folder, which macOS clears itself.
const takePng = async ($: EngineInterface, path: string): Promise<string> => {
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  await $.process.run(['/bin/rm', '-f', path])

  return base64
}

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

// Best effort, as in takePng: the folder stays when something is left in it.
const deleteOriginal = async ($: EngineInterface, originalPath: string): Promise<void> => {
  await $.process.run(['/bin/rm', '-f', originalPath])
  await $.process.run(['/bin/rmdir', folderOf(originalPath)])
}

// Where a picture's bytes are: base64 from a row, or the file Claude Code
// saved when it was pasted.
type Source = { data: string } | { file: string }

// Copies one pasted image into a private folder of its own under $TMPDIR,
// kept for the session so the large view can be drawn from the original,
// and returns its thumbnail; undefined, with the reason in the debug log.
const makeThumb = async ($: EngineInterface, source: Source, n: number): Promise<Thumb | undefined> => {
  const created = await $.process.run(['/usr/bin/mktemp', '-d', '-t', 'claude-image-thumbs'])
  const dir = created.stdout.trim()
  if (created.exitCode !== 0 || dir === '') {
    $.ui.log(`image-thumbs: no folder for image #${n}: mktemp exited ${created.exitCode}`, { to: 'debug' })

    return undefined
  }
  const originalPath = `${dir}/original`

  try {
    if ('file' in source) {
      await runOrThrow($, ['/bin/cp', source.file, originalPath])
    } else {
      await runOrThrow($, ['/usr/bin/base64', '-D', '-o', originalPath], source.data)
    }
    const thumbPath = `${dir}/thumb.png`
    const size = await writePng($, originalPath, thumbPath, { width: THUMB_MAX_WIDTH, height: THUMB_HEIGHT })

    return { png: await takePng($, thumbPath), ...size, n, originalPath }
  } catch (error) {
    $.ui.log(`image-thumbs: no thumbnail for image #${n}: ${String(error)}`, { to: 'debug' })
    await deleteOriginal($, originalPath)

    return undefined
  }
}

// The original as the largest PNG under 2 MiB that VIEW_SIDES allows.
const largeView = async ($: EngineInterface, originalPath: string, n: number): Promise<Shown> => {
  const viewPath = `${folderOf(originalPath)}/view.png`
  for (const side of VIEW_SIDES) {
    const size = await writePng($, originalPath, viewPath, { width: side, height: side })
    const { size: bytes } = await $.fs.stat(viewPath)
    if (bytes <= MAX_PNG_BYTES) {
      return { png: await takePng($, viewPath), ...size, n }
    }
  }
  await $.process.run(['/bin/rm', '-f', viewPath])
  throw new Error(`image #${n} is over ${MAX_PNG_BYTES} bytes even at ${VIEW_SIDES.at(-1)} px`)
}

const openImage = async ($: EngineInterface, n: number, originalPath: string): Promise<void> => {
  try {
    await $.state.set(SHOWN, await largeView($, originalPath, n))
  } catch (error) {
    $.ui.toast(`image-thumbs: cannot open image #${n}: ${String(error)}`)

    return
  }
  const opened = await $.ui.open({
    id: PANE,
    title: `Image #${n}`,
    focus: true,
    closeOnEscape: true,
    columns: PANE_COLUMNS,
    rows: PANE_ROWS,
  })
  if (!opened.isPlaced) {
    $.ui.toast(`image-thumbs: the image pane did not open: ${opened.reason}`)
  }
}

const isThumb = (thumb: Thumb | undefined): thumb is Thumb => thumb !== undefined

const isStored = async ($: EngineInterface, n: number): Promise<boolean> =>
  (await $.state.get({ ...BY_IMAGE, id: String(n) })).value !== undefined

const keepThumbs = async ($: EngineInterface, thumbs: Thumb[]): Promise<void> => {
  if (thumbs.length === 0) {
    return
  }
  await Promise.all(thumbs.map(thumb => $.state.set({ ...BY_IMAGE, id: String(thumb.n) }, thumb)))
  const { value: pasted = [] } = await $.state.get(PASTED)
  const added: Pasted[] = thumbs.map(({ n, originalPath }) => ({ n, originalPath }))
  await $.state.set(PASTED, [...pasted, ...added])
}

// A text's own pictures: the numbers it names past the newest one claimed.
const freshOf = async ($: EngineInterface, text: string): Promise<number[]> => {
  const { value: claimed = 0 } = await $.state.get(CLAIMED)

  return freshNumbers(text, claimed)
}

const claim = async ($: EngineInterface, numbers: number[]): Promise<void> => {
  const { value: claimed = 0 } = await $.state.get(CLAIMED)
  await $.state.set(CLAIMED, Math.max(claimed, ...numbers))
}

// Builds and stores the thumbnails of a row's own pictures not built yet,
// matched to `images` in order.
const storeThumbs = async ($: EngineInterface, text: string, images: ImageBlock[]): Promise<void> => {
  const numbers = (await freshOf($, text)).slice(0, images.length)
  const made = await Promise.all(
    numbers.map(async (n, index) =>
      (await isStored($, n)) ? undefined : makeThumb($, { data: images[index]?.source.data ?? '' }, n),
    ),
  )
  await keepThumbs($, made.filter(isThumb))
  await claim($, numbers)
}

// Claude Code saves each pasted picture when it is pasted, as
// $TMPDIR/clipboard-YYYY-MM-DD-HHMMSS-<id>.png (local time). A slash
// command's row, and a message sent mid-turn, are printed before any row
// carrying the picture's bytes, and a printed row is not drawn again; so when
// a prompt is submitted its thumbnails are built from these files.
const SAVED_NAME = /\/clipboard-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9A-Za-z]+\.\w+$/
// How far a file's name time may be from its paste: the name keeps whole
// seconds, and the file is written as the paste lands.
const PASTE_SLACK_MS = 3000

type Saved = { path: string; at: number }

const savedAt = (path: string): number | undefined => {
  const parts = SAVED_NAME.exec(path)?.slice(1).map(Number)
  if (parts === undefined) {
    return undefined
  }
  const [year = 0, month = 1, day = 1, hours = 0, minutes = 0, seconds = 0] = parts

  return new Date(year, month - 1, day, hours, minutes, seconds).getTime()
}

// The pictures Claude Code saved in the last two hours, oldest first.
const savedPictures = async ($: EngineInterface): Promise<Saved[]> => {
  const dir = (await runOrThrow($, ['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'])).trim().replace(/\/$/, '')
  const found = await runOrThrow($, ['/usr/bin/find', dir, '-maxdepth', '1', '-name', 'clipboard-*', '-mmin', '-120'])

  return found
    .split('\n')
    .flatMap(path => {
      const at = savedAt(path)

      return at === undefined ? [] : [{ path, at }]
    })
    .sort((one, other) => one.at - other.at)
}

// The saved file of each wanted picture: the one saved nearest its paste,
// when the paste was seen. Pictures left over take the files saved since the
// last prompt only when there are exactly as many: one more may be another
// session's paste, and drawing it here would show the wrong picture.
const pickFiles = (pastedAt: (number | undefined)[], saved: Saved[], since: number): (string | undefined)[] => {
  const taken = new Set<string>()
  const picked = pastedAt.map(at => {
    if (at === undefined) {
      return undefined
    }
    const [nearest] = saved
      .filter(file => !taken.has(file.path) && Math.abs(file.at - at) <= PASTE_SLACK_MS)
      .sort((one, other) => Math.abs(one.at - at) - Math.abs(other.at - at))
    if (nearest !== undefined) {
      taken.add(nearest.path)
    }

    return nearest?.path
  })
  const missing = picked.flatMap((path, index) => (path === undefined ? [index] : []))
  const sinceLast = saved.filter(file => !taken.has(file.path) && file.at >= since - PASTE_SLACK_MS)
  if (missing.length > 0 && sinceLast.length === missing.length) {
    missing.forEach((index, order) => {
      picked[index] = sinceLast[order]?.path
    })
  }

  return picked
}

// At submit, before any row of the prompt exists: builds the thumbnails of
// the pictures `text` names that are not built yet, from their saved files.
const storeSavedThumbs = async ($: EngineInterface, text: string): Promise<void> => {
  const submittedAt = Date.now()
  const { value: since = 0 } = await $.state.get(SUBMITTED)
  await $.state.set(SUBMITTED, submittedAt)
  const numbers = await freshOf($, text)
  const wanted = (await Promise.all(numbers.map(async n => ((await isStored($, n)) ? [] : [n])))).flat()
  if (wanted.length === 0) {
    return
  }
  let saved: Saved[]
  try {
    saved = await savedPictures($)
  } catch (error) {
    $.ui.log(`image-thumbs: no saved pictures listed: ${String(error)}`, { to: 'debug' })

    return
  }
  const { value: used = [] } = await $.state.get(USED)
  const pastedAt = await Promise.all(wanted.map(async n => (await $.state.get({ ...PASTED_AT, id: String(n) })).value))
  const files = pickFiles(
    pastedAt,
    saved.filter(file => !used.includes(file.path)),
    since,
  )
  const made = await Promise.all(
    wanted.map((n, index) => {
      const file = files[index]

      return file === undefined ? undefined : makeThumb($, { file }, n)
    }),
  )
  const thumbs = made.filter(isThumb)
  await keepThumbs($, thumbs)
  await $.state.set(USED, [...used, ...files.filter((file): file is string => file !== undefined)])
  // Claimed only when every picture was built: a row then builds the rest
  // from its own bytes, where it carries them.
  if (thumbs.length === wanted.length) {
    await claim($, numbers)
  }
}

// The largest box of cells inside `room` that keeps the picture's aspect.
const fitCells = (size: Size, room: { columns: number; rows: number }): { columns: number; rows: number } => {
  const columns = Math.min(room.columns, Math.round((room.rows * CELL_ASPECT * size.width) / size.height), 255)
  const rows = Math.min(room.rows, Math.round((columns * size.height) / size.width / CELL_ASPECT), 255)

  return { columns: Math.max(2, columns), rows: Math.max(1, rows) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A pane asked for by code below 144 columns waits unseen; drop any such
    // leftover so it does not appear later when the terminal widens.
    await $.ui.close({ id: PANE })
    await $.command.register({
      name: 'image',
      description: 'Open a pasted image large in a pane',
      argumentHint: '[image number]',
    })

    return next(e)
  })

  // Build the thumbnails before the row is stored, so the row's first drawing
  // already has them: a row printed to the terminal's scrollback is not redrawn.
  on('session.append', { door: PICTURE_DOORS }, async ($, e, next) => {
    const images = e.message.content.filter(isImageBlock)
    if (images.length === 0) {
      return next(e)
    }
    // Claude Code's own numbers, in order, from the row's [Image #n] tags.
    await storeThumbs($, textOf(e.message.content), images)

    return next(e)
  })

  // A paste puts [Image #n] in the prompt box: when it landed tells which
  // saved file is that picture's.
  on('prompt.edit', async ($, e, next) => {
    const numbers = imageNumbers(e.inputText)
    if (numbers.length > 0) {
      const at = Date.now()
      await Promise.all(numbers.map(n => $.state.set({ ...PASTED_AT, id: String(n) }, at)))
    }

    return next(e)
  })

  // A prompt typed at the prompt or sent while Claude works, before its rows
  // exist.
  on('prompt.submit', async ($, e, next) => {
    if (e.attachments?.some(attachment => attachment.type === 'image') === true) {
      await storeSavedThumbs($, e.text)
    }

    return next(e)
  })

  // A slash command's pictures are in its arguments.
  on('command.run', async ($, e, next) => {
    if (imageNumbers(e.args).length > 0) {
      await storeSavedThumbs($, e.args)
    }

    return next(e)
  })

  // A /clear ends the session too, and the next one may number its pictures
  // from #1 again.
  on('session.end', async ($, e, next) => {
    const { value: pasted = [] } = await $.state.get(PASTED)
    await Promise.all(pasted.map(image => deleteOriginal($, image.originalPath)))
    await $.state.set(PASTED, [])

    return next(e)
  })

  on('command.run', { command: 'image' }, async ($, e) => {
    const { value: pasted = [] } = await $.state.get(PASTED)
    const asked = e.args.trim().replace(/^#/, '')
    const image = asked === '' ? pasted.at(-1) : pasted.find(one => String(one.n) === asked)
    if (image === undefined) {
      const known = pasted.map(one => `#${one.n}`).join(', ')

      return { text: known === '' ? 'No pasted images yet.' : `No image #${asked}. Pasted so far: ${known}.` }
    }
    await openImage($, image.n, image.originalPath)

    return { text: `Opened image #${image.n}.` }
  })

  // A click on a picture, posted by its click area (click-area.ts), expands
  // the thumbnail in place or shrinks it back. In place rather than in a
  // pane: a click a Client posts counts as code, and the engine seats a pane
  // code opens only from 144 columns.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { toggle?: unknown; repaint?: unknown } | null
    // A click area asking, after its first drawing, for its frame to light up
    // or go back (click-area.ts): an odd count draws the border lit.
    if (typeof data?.repaint === 'number') {
      const id = String(data.repaint)
      const { value: repaints = 0 } = await $.state.get({ ...REPAINTS, id })
      await $.state.set({ ...REPAINTS, id }, repaints + 1)

      return {}
    }
    if (typeof data?.toggle !== 'number') {
      return next(e)
    }
    const n = data.toggle
    const id = String(n)
    const { value: expandedPicture } = await $.state.get({ ...EXPANDED, id })
    if (expandedPicture !== undefined && expandedPicture !== null) {
      await $.state.set({ ...EXPANDED, id }, null)

      return {}
    }
    const { value: thumb } = await $.state.get({ ...BY_IMAGE, id })
    if (thumb === undefined) {
      return {}
    }
    try {
      await $.state.set({ ...EXPANDED, id }, await largeView($, thumb.originalPath, n))
    } catch (error) {
      $.ui.toast(`image-thumbs: cannot expand image #${n}: ${String(error)}`)
    }

    return {}
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }
    // By the numbers the row names, not by the row: a slash command's row and
    // a message sent mid-turn are drawn under ids other than the rows their
    // pictures came in on. A slash command's row draws before its expansion
    // brings the pictures; its read here subscribes it, so it redraws when
    // they are stored.
    const numbers = imageNumbers(e.props.text)
    if (numbers.length === 0) {
      return next(e)
    }
    const stored = await Promise.all(numbers.map(async n => (await $.state.get({ ...BY_IMAGE, id: String(n) })).value))
    const thumbs = stored.filter((thumb): thumb is Thumb => thumb !== undefined)
    if (thumbs.length === 0) {
      return next(e)
    }
    const expanded = await Promise.all(
      thumbs.map(async thumb => (await $.state.get({ ...EXPANDED, id: String(thumb.n) })).value ?? null),
    )
    const repaints = await Promise.all(
      thumbs.map(async thumb => (await $.state.get({ ...REPAINTS, id: String(thumb.n) })).value ?? 0),
    )
    const row = await next(e)
    const { Box, Button, Client, Image, Text } = $.ui.resolve(e)
    // Less the row's indent and the frame's two border columns.
    const columns = (e.viewport?.columns ?? 80) - 6
    const room = { columns, rows: ROWS }
    const roomExpanded = { columns, rows: Math.max(ROWS, Math.min(EXPANDED_ROWS, (e.viewport?.rows ?? 40) - 10)) }

    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginLeft={2}>
          {thumbs.map((thumb, index) => {
            const { n, originalPath } = thumb
            const expandedPicture = expanded[index] ?? null
            const cells = expandedPicture === null ? fitCells(thumb, room) : fitCells(expandedPicture, roomExpanded)
            const png = expandedPicture === null ? thumb.png : expandedPicture.png
            // Lit for a moment after the first drawing: the border's cells on
            // the picture's rows change, so the terminal paints them again.
            const isLit = (repaints[index] ?? 0) % 2 === 1

            return (
              <Box flexDirection="column" alignItems="flex-start">
                <Box borderStyle="round" borderDimColor={!isLit}>
                  <Box>
                    <Image key={`thumb-${n}`} source={{ png }} {...cells} alt={`[Image #${n}]`} />
                    <Box position="absolute" top={0} left={0}>
                      <Client
                        key={`click-${n}`}
                        module="./click-area.ts"
                        props={{ n }}
                        width={cells.columns}
                        height={cells.rows}
                      />
                    </Box>
                  </Box>
                </Box>
                <Box flexDirection="row">
                  <Text dimColor>
                    #{n} · click the picture to {expandedPicture === null ? 'expand' : 'shrink'} ·{' '}
                  </Text>
                  <Button
                    key={`open-${n}`}
                    label="open in pane"
                    plain
                    dimColor
                    onPress={() => openImage($, n, originalPath)}
                  />
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { value: shown } = await $.state.get(SHOWN)
    if (e.surface !== 'terminal' || shown === undefined || shown === null) {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>No image open. Type /image to open the latest one.</Text>
    }
    const { Box, Image, Text } = $.ui.resolve(e)
    const room = { columns: e.props.bodyColumns, rows: Math.max(2, e.props.scroll.bodyRows - 1) }

    return (
      <Box flexDirection="column">
        <Image key="view" source={{ png: shown.png }} {...fitCells(shown, room)} alt={`[Image #${shown.n}]`} />
        <Text dimColor>
          {shown.width}×{shown.height} px · Esc closes
        </Text>
      </Box>
    )
  })
}
