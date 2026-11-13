// TRACK-35 (2026-10-22): write-once, content-addressed blob files. A blob's
// name is the SHA-256 of its UTF-8 text, so a reader can prove what it got.
export type BlobFs = {
  read: (path: string) => Promise<string | undefined>
}
export type BlobRef = { checksum: string; bytes: number }

const CHECKSUM = /^[0-9a-f]{64}$/

const isChecksum = (value: unknown): value is string => typeof value === 'string' && CHECKSUM.test(value)
const isByteCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

// Each field is read once and only the validated copy is used, so a getter
// cannot pass validation and then traverse out of dir.
const copyBlobRef = (ref: unknown): BlobRef | undefined => {
  if (typeof ref !== 'object' || ref === null) return undefined
  const { checksum, bytes } = ref as Record<string, unknown>
  return isChecksum(checksum) && isByteCount(bytes) ? { checksum, bytes } : undefined
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
