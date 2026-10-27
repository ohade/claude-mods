// Failure-intake D2/I4: what the statically imported build identity says about the executing module.
// Pure: no disk, git or engine value is ever an input, so a bad module reads as unknown, never as a fallback.
export type LoadedIdentity = { loaded: string } | { loaded: 'unknown'; reason: string }

export const identityOf = (module: unknown): LoadedIdentity => {
  if (module === null || typeof module !== 'object') return { loaded: 'unknown', reason: 'identity module exports no object' }
  const { v, source_fingerprint: fingerprint, source_base: base, generated_at: generatedAt } = module as Record<string, unknown>
  if (v !== 1) return { loaded: 'unknown', reason: 'identity metadata version is not 1' }
  if (typeof fingerprint !== 'string') return { loaded: 'unknown', reason: 'source_fingerprint is not a string' }
  if (fingerprint === 'unknown') return { loaded: 'unknown', reason: 'identity module is the placeholder' }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) return { loaded: 'unknown', reason: 'source_fingerprint is not 64 lowercase hex' }
  if (typeof base !== 'string') return { loaded: 'unknown', reason: 'source_base is not a string' }
  if (typeof generatedAt !== 'string') return { loaded: 'unknown', reason: 'generated_at is not a string' }
  return { loaded: fingerprint }
}
