import type { EngineInterface, Register } from 'claude-code'

import type { Pasted, Shown, Thumb } from '../types'
import { freshNumbers, imageNumbers } from './numbers.ts'

const BY_IMAGE = { plugin: 'image-thumbs', key: 'byImage' } as const
const SHOWN = { plugin: 'image-thumbs', key: 'shown' } as const
const PASTED = { plugin: 'image-thumbs', key: 'pasted' } as const
const EXPANDED = { plugin: 'image-thumbs', key: 'expanded' } as const
const SENDS = { plugin: 'image-thumbs', key: 'sends' } as const

const PANE = 'image-view'

// The rows a pasted picture comes in on: a typed prompt, a slash command's
// expansion, and the attachment that folds a message sent mid-turn into it.
const PICTURE_DOORS = ['prompt', 'command', 'attachment'] as const

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

const isImageBlock = (block: { type: string; [field: string]: unknown }): block is ImageBlock => {
  const source = block.source as { type?: string; data?: unknown } | undefined

  return block.type === 'image' && source?.type === 'base64' && typeof source.data === 'string'
}

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

// The thumbnail's pixels in other bytes: sips rewrites the resolution tag.
// The engine sends a picture only when its bytes change, so drawing the twin
// sends the same pixels again. Undefined when sips fails: the thumbnail is
// then never sent again, which costs nothing else.
const makeTwin = async ($: EngineInterface, thumbPath: string, twinPath: string): Promise<string | undefined> => {
  try {
    await runOrThrow($, ['/usr/bin/sips', '-s', 'dpiWidth', '73', '-s', 'dpiHeight', '73', thumbPath, '--out', twinPath])

    return await takePng($, twinPath)
  } catch (error) {
    $.ui.log(`image-thumbs: no twin for ${thumbPath}: ${String(error)}`, { to: 'debug' })

    return undefined
  }
}

// Decodes one pasted image into a private folder of its own under $TMPDIR,
// kept for the session so the large view can be drawn from the original,
// and returns its thumbnail; undefined, with the reason in the debug log.
const makeThumb = async ($: EngineInterface, data: string, n: number): Promise<Thumb | undefined> => {
  const created = await $.process.run(['/usr/bin/mktemp', '-d', '-t', 'claude-image-thumbs'])
  const dir = created.stdout.trim()
  if (created.exitCode !== 0 || dir === '') {
    $.ui.log(`image-thumbs: no folder for image #${n}: mktemp exited ${created.exitCode}`, { to: 'debug' })

    return undefined
  }
  const originalPath = `${dir}/original`

  try {
    await runOrThrow($, ['/usr/bin/base64', '-D', '-o', originalPath], data)
    const thumbPath = `${dir}/thumb.png`
    const size = await writePng($, originalPath, thumbPath, { width: THUMB_MAX_WIDTH, height: THUMB_HEIGHT })
    const twin = await makeTwin($, thumbPath, `${dir}/twin.png`)

    return { png: await takePng($, thumbPath), ...(twin !== undefined && { twin }), ...size, n, originalPath }
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
    const text = e.message.content.map(block => (block.type === 'text' ? String(block.text) : '')).join('\n')
    const { value: pasted = [] } = await $.state.get(PASTED)
    const numbers = freshNumbers(text, Math.max(0, ...pasted.map(image => image.n)))
    const made = await Promise.all(
      numbers.slice(0, images.length).map((n, index) => makeThumb($, images[index]?.source.data ?? '', n)),
    )
    const thumbs = made.filter((thumb): thumb is Thumb => thumb !== undefined)
    if (thumbs.length > 0) {
      await Promise.all(thumbs.map(thumb => $.state.set({ ...BY_IMAGE, id: String(thumb.n) }, thumb)))
      const added: Pasted[] = thumbs.map(({ n, originalPath }) => ({ n, originalPath }))
      await $.state.set(PASTED, [...pasted, ...added])
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
    const data = e.data as { toggle?: unknown; resend?: unknown } | null
    // A click area asking, after its first drawing, for its picture to be
    // sent again (click-area.ts): the next drawing switches to the other bytes.
    if (typeof data?.resend === 'number') {
      const id = String(data.resend)
      const { value: sends = 0 } = await $.state.get({ ...SENDS, id })
      await $.state.set({ ...SENDS, id }, sends + 1)

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
    const sends = await Promise.all(
      thumbs.map(async thumb => (await $.state.get({ ...SENDS, id: String(thumb.n) })).value ?? 0),
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
            const isTwin = (sends[index] ?? 0) % 2 === 1 && thumb.twin !== undefined
            const png = expandedPicture !== null ? expandedPicture.png : isTwin ? (thumb.twin ?? thumb.png) : thumb.png

            return (
              <Box flexDirection="column" alignItems="flex-start">
                <Box borderStyle="round" borderDimColor>
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
