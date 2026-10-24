// TRACK-42: which blob checksums do store values still reference? The blob
// sweep (blob-fs.py sweep) deletes every other old blob, so this collector
// must over-collect rather than miss one.
export const BLOB_MIN_AGE_SECONDS = 7 * 24 * 60 * 60

// A maximal run: exactly 64 lowercase hex characters, with no hex digit on either side.
const CHECKSUM_RUN = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g

export const referencedChecksums = (values: Iterable<unknown>): Set<string> => {
  const found = new Set<string>()
  const seen = new Set<object>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(CHECKSUM_RUN)) found.add(match[0])
      return
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      collect(key)
      collect(item)
    }
  }
  for (const value of values) collect(value)
  return found
}
