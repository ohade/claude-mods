import { expect, test } from 'claude-code/testing'

// A 64x32 JPEG: the thumbnail must convert it to PNG and keep the 2:1 aspect.
const JPEG = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAIAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAIABAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQABP/aAAwDAQACEQMRAD8A/Iy08KdPkrprTwp0+SvcLTwp0+SumtPCnT5K/pzGcYeZ+XcN8e7e8eIWnhTp8ldNaeFOnyV7haeFOnyV01p4U6fJ+lfKYzjHzP6A4b492948PtPCnT5P0rprTwp0+SvcLTwp0+SumtPCnT5K+UxnGHmf0Bw3x7t7x4faeFOnyV09p4U6fJXuFp4U6fJXTWnhTp8lfKYzjHzP6A4b49294//Q85tPCnT5K6a08KdPkr3C08KdPkrprTwp0+T9K4sZxj5n+bHDfHu3vHh9p4U6fJ+ldNaeFOnyV7haeFOnyV01p4U6fJXymM4w8z+gOG+PdvePD7Twp0+SuntPCnT5K9wtPCnT5K6a08KdPkr5PGcYeZ/QHDfHu3vHh9p4U6fJXTWnhTp8le4WnhTp8ldPaeFOnyV8pjOMfM/oDhvj3b3j/9k='

// The row as stored, and the id the transcript draws it under: the same
// first four groups, the last one zeroed.
const ROW_ID = 'b3bcd931-da69-4b4e-9d30-b3f428b5422e'
const DRAWN_ID = 'b3bcd931-da69-4b4e-9d30-000000000000'

const promptRow = (content: { type: string; [field: string]: unknown }[]) => ({
  door: 'prompt' as const,
  origin: { kind: 'composer' as const },
  uuid: ROW_ID,
  message: { type: 'user' as const, role: 'user' as const, content },
})

const userMessage = (requestId: string) => ({
  plugin: 'image-thumbs',
  surface: 'terminal' as const,
  component: 'UserMessage' as const,
  requestId,
  viewport: { columns: 100, rows: 40 },
  props: { text: 'look at this [Image #1]', origin: { kind: 'composer' as const }, isExpanded: false },
})

test('a pasted JPEG draws as a 5-row PNG thumbnail under its prompt row', { timeoutMs: 20000 }, async ($, on) => {
  on('session.append', (_, e) => ({ message: e.message, uuid: e.uuid }))
  on('ui.render', { component: 'UserMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))

  await $.session.append(promptRow([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
    { type: 'text', text: 'look at this [Image #1]' },
  ]))
  const ui = await $.ui.mount(userMessage(DRAWN_ID))

  const images = await ui.findAll({ type: 'Image' })
  expect(images).toHaveLength(1)
  expect(images[0]?.props).toMatchObject({ rows: 5, columns: 21, alt: '[Image #1]' })
  const source = images[0]?.props.source as { png: string }
  expect(source.png.startsWith('iVBORw0KGgo')).toBe(true)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('look at this [Image #1]')
})

test('a prompt row with no image draws as the engine draws it', async ($, on) => {
  on('session.append', (_, e) => ({ message: e.message, uuid: e.uuid }))
  on('ui.render', { component: 'UserMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))

  await $.session.append(promptRow([{ type: 'text', text: 'just words' }]))
  const ui = await $.ui.mount(userMessage(DRAWN_ID))

  expect(await ui.findAll({ type: 'Image' })).toHaveLength(0)
})

test('a click on the picture expands it in place and a second click shrinks it', { timeoutMs: 20000 }, async ($, on) => {
  on('session.append', (_, e) => ({ message: e.message, uuid: e.uuid }))
  on('ui.render', { component: 'UserMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))

  await $.session.append(promptRow([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
    { type: 'text', text: 'look at this [Image #1]' },
  ]))
  const ui = await $.ui.mount(userMessage(DRAWN_ID))
  // A left click released over the picture's click area (click-area.ts).
  const click = { type: 'up' as const, x: 2, y: 1, button: 'left' as const, in: 'click-b3bcd931-da69-4b4e-9d30-0' }

  // 64x32 is never scaled up: 24 rows of a 94-column room fit 94 columns by 22 rows.
  await ui.pointer(click)
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 94, rows: 22 })
  expect(await ui.find({ type: 'Text', text: /click the picture to shrink/ })).toBeDefined()

  await ui.pointer(click)
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 21, rows: 5 })
})
