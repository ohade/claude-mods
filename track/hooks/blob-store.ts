// TRACK-35 (2026-10-22): write-once, content-addressed blob files. A blob's
// name is the SHA-256 of its UTF-8 text, so a reader can prove what it got.
export type BlobFs = {
  read: (path: string) => Promise<string | undefined>
  write: (path: string, text: string) => Promise<void>
  list: (dir: string) => Promise<string[]>
  remove: (path: string) => Promise<void>
}
export type BlobRef = { checksum: string; bytes: number }
export type BlobPointer = { v: 1; checksum: string; bytes: number; savedAt: number; closedAt?: number; imported?: boolean }

const CHECKSUM = /^[0-9a-f]{64}$/
const BLOB_NAME = /^([0-9a-f]{64})\.json$/
const POINTER_KEYS = new Set(['v', 'checksum', 'bytes', 'savedAt', 'closedAt', 'imported'])

const isChecksum = (value: unknown): value is string => typeof value === 'string' && CHECKSUM.test(value)
const isByteCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

// Each field is read once and only the validated copy is used, so a getter
// cannot pass validation and then traverse out of dir.
const copyBlobRef = (ref: unknown): BlobRef | undefined => {
  if (typeof ref !== 'object' || ref === null) return undefined
  const { checksum, bytes } = ref as Record<string, unknown>
  return isChecksum(checksum) && isByteCount(bytes) ? { checksum, bytes } : undefined
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const blobPath = (dir: string, checksum: string): string => `${dir}/${checksum}.json`

const refOf = async (text: string): Promise<BlobRef> => {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return { checksum: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join(''), bytes: bytes.length }
}

const matches = async (text: string | undefined, ref: BlobRef): Promise<boolean> => {
  if (text === undefined) return false
  const actual = await refOf(text)
  return actual.checksum === ref.checksum && actual.bytes === ref.bytes
}

// Returns the text only when the file's content still matches its name and size.
export const readBlob = async (fs: BlobFs, dir: string, ref: BlobRef): Promise<string | undefined> => {
  const copy = copyBlobRef(ref)
  if (copy === undefined) return undefined
  const text = await fs.read(blobPath(dir, copy.checksum))
  return await matches(text, copy) ? text : undefined
}

// An existing verified blob is left alone. A missing or damaged one is written
// with the content its name stands for, then read back before the ref is returned.
export const writeBlob = async (fs: BlobFs, dir: string, text: string): Promise<BlobRef> => {
  const ref = await refOf(text)
  const path = blobPath(dir, ref.checksum)
  if (await matches(await fs.read(path), ref)) return ref
  await fs.write(path, text)
  if (!await matches(await fs.read(path), ref)) throw new Error(`blob read-back mismatch: ${path}`)
  return ref
}

// The caller must hold Track's writer lock: a concurrent save writes its blob
// before it publishes the pointer, so an unlocked sweep could delete it.
export const sweepBlobs = async (fs: BlobFs, dir: string, referenced: ReadonlySet<string>): Promise<string[]> => {
  const removed = (await fs.list(dir)).filter(name => {
    const checksum = BLOB_NAME.exec(name)?.[1]
    return checksum !== undefined && !referenced.has(checksum)
  }).sort()
  for (const name of removed) await fs.remove(`${dir}/${name}`)
  return removed
}

// Only own keys of a plain object count, each read once into a local, so an
// inherited, polluted or changing field cannot pass validation.
export const parseBlobPointer = (value: unknown): BlobPointer | undefined => {
  if (!isPlainObject(value) || !Object.keys(value).every(key => POINTER_KEYS.has(key))) return undefined
  const own = (key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined
  const [v, checksum, bytes, savedAt, closedAt, imported] = ['v', 'checksum', 'bytes', 'savedAt', 'closedAt', 'imported'].map(own)
  const hasClosedAt = Object.hasOwn(value, 'closedAt')
  const hasImported = Object.hasOwn(value, 'imported')
  if (v !== 1 || !isChecksum(checksum) || !isByteCount(bytes) || !isTime(savedAt)) return undefined
  if (hasClosedAt && !isTime(closedAt)) return undefined
  if (hasImported && typeof imported !== 'boolean') return undefined
  return {
    v: 1, checksum, bytes, savedAt,
    ...(hasClosedAt && { closedAt: closedAt as number }),
    ...(hasImported && { imported: imported as boolean }),
  }
}
