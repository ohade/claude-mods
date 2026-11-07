// TRACK-54: the engine rejects a read or write over 4 MiB (d.ts EngineInterface.fs), and a decoded
// store can be far larger than the stored one. A bundle that fits is written as before, one v1 file.
// A larger one is written as part files beside `path`, then a v2 manifest at `path` that names them;
// no file passes the limit. Reading returns the same logical bundle for either form, so the import
// checks that follow (checksum, identities, conflicts) run unchanged.
import { checksumOf } from './checkpoint'

export const FILE_LIMIT = 4 * 1024 * 1024

export type BundleRecord = { key: string; value: unknown }
export type Bundle = { v: 1; source_identity: string; checksum: string; records: BundleRecord[] }
type BundleFs = { write: (path: string, text: string) => Promise<void>; read: (path: string) => Promise<unknown> }
type PartRef = { name: string; bytes: number; sha256: string; records: number }
type Manifest = { v: 2; source_identity: string; checksum: string; records: number; parts: PartRef[] }

const encoder = new TextEncoder()
const sizeOf = (text: string) => encoder.encode(text).length
const sha256Of = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2, '0')).join('')
const partPrefix = (index: number) => `{"v":2,"index":${index},"records":[`
const PART_SUFFIX = ']}'
// The longest prefix a part can have, so the limit check never depends on which part a record lands in.
const PREFIX_MAX = new TextEncoder().encode(partPrefix(999_999)).length
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
// A part sits beside its manifest: `/backup.json` -> `/backup.json.part-1`.
const partPath = (path: string, name: string) => `${dirOf(path)}/${name}`
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const readText = async (fs: BundleFs, path: string): Promise<string> => {
  const text = await fs.read(path)
  if (typeof text !== 'string') throw new Error(`migration file is not text: ${path}`)
  return text
}

// Each part holds whole records, packed in order; a record that cannot fit one file alone is refused.
const planParts = (records: readonly BundleRecord[]): string[][] => {
  const parts: string[][] = []
  let current: string[] = []
  let used = 0
  for (const record of records) {
    const text = JSON.stringify(record)
    const alone = PREFIX_MAX + sizeOf(text) + sizeOf(PART_SUFFIX)
    if (alone > FILE_LIMIT) throw new Error(`migration record ${record.key} is too large for one file (${sizeOf(text)} bytes; limit ${FILE_LIMIT})`)
    const added = sizeOf(text) + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && PREFIX_MAX + used + added + sizeOf(PART_SUFFIX) > FILE_LIMIT) {
      parts.push(current)
      current = []
      used = 0
    }
    used += sizeOf(text) + (current.length > 0 ? 1 : 0)
    current.push(text)
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/** Writes the bundle and reads every file back; throws, writing nothing, when a record is too large. */
export const writeBundle = async (fs: BundleFs, path: string, bundle: Bundle): Promise<void> => {
  const whole = JSON.stringify(bundle)
  if (sizeOf(whole) <= FILE_LIMIT) {
    await fs.write(path, whole)
  } else {
    const plan = planParts(bundle.records)
    const refs: PartRef[] = []
    // Part names carry the bundle checksum, so a new export never overwrites the parts an older
    // manifest at the same path still names; that manifest stays whole until the new one replaces it.
    for (const [n, texts] of plan.entries()) {
      const name = `${nameOf(path)}.${bundle.checksum.slice(0, 16)}.part-${n + 1}`
      const text = `${partPrefix(n + 1)}${texts.join(',')}${PART_SUFFIX}`
      await fs.write(partPath(path, name), text)
      refs.push({ name, bytes: sizeOf(text), sha256: await sha256Of(text), records: texts.length })
    }
    const manifest: Manifest = { v: 2, source_identity: bundle.source_identity, checksum: bundle.checksum, records: bundle.records.length, parts: refs }
    await fs.write(path, JSON.stringify(manifest))
  }
  const verified = await readBundle(fs, path)
  if (verified.checksum !== bundle.checksum || await checksumOf(verified.records) !== bundle.checksum) throw new Error('export read-back does not match')
}

/**
 * The logical bundle at `path`, from a v1 file or a v2 manifest and its parts. A missing, resized
 * or misnumbered part throws; the caller still compares the checksum against the records.
 */
export const readBundle = async (fs: BundleFs, path: string): Promise<{ v?: number; source_identity?: string; checksum?: string; records?: BundleRecord[] }> => {
  const top = JSON.parse(await readText(fs, path)) as { v?: number; source_identity?: string; checksum?: string; records?: unknown; parts?: unknown }
  if (top.v !== 2) return top as { v?: number; source_identity?: string; checksum?: string; records?: BundleRecord[] }
  if (!Array.isArray(top.parts) || typeof top.records !== 'number') throw new Error('migration manifest is corrupt or incompatible')
  const records: BundleRecord[] = []
  for (const [n, ref] of (top.parts as PartRef[]).entries()) {
    if (ref === null || typeof ref !== 'object' || typeof ref.name !== 'string' || ref.name.includes('/')) throw new Error('migration manifest is corrupt or incompatible')
    const where = partPath(path, ref.name)
    let text: string
    try { text = await readText(fs, where) }
    catch (error) { throw new Error(`migration part ${where} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`) }
    if (sizeOf(text) !== ref.bytes || await sha256Of(text) !== ref.sha256) throw new Error(`migration part ${ref.name} is corrupt or incompatible with its manifest`)
    const part = JSON.parse(text) as { v?: number; index?: number; records?: unknown }
    if (part.v !== 2 || part.index !== n + 1 || !Array.isArray(part.records) || part.records.length !== ref.records) throw new Error(`migration part ${ref.name} is corrupt or incompatible with its manifest`)
    records.push(...(part.records as BundleRecord[]))
  }
  if (records.length !== top.records) throw new Error('migration manifest record count does not match its parts')
  return { v: 1, source_identity: top.source_identity, checksum: top.checksum, records }
}
