export type HistoryRun = { kind: 'ok'; response: Record<string, unknown> } | { kind: 'refused'; reason: string } | { kind: 'pending'; cause: string }
export type HistoryOp = 'bind' | 'read' | 'save' | 'resolve' | 'collect'

type HistoryProcessResult = { stdout: string; exitCode: number | null; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }

export const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isRootSeq = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 1
const isRootHash = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
// The fields a mutating op's ok receipt must carry: a save names the root it
// wrote; a resolve names the current root, or nulls both when there is none.
// A mutation that exits 0 without them may still have committed, so it is
// pending rather than ok. Bind and read keep their own checks.
const okReceiptValid = (op: HistoryOp, response: Record<string, unknown>): boolean => {
  if (op === 'save') return isRootSeq(response.seq) && isRootHash(response.root_sha256)
  if (op === 'resolve') {
    return 'seq' in response && 'root_sha256' in response &&
      ((response.seq === null && response.root_sha256 === null) || (isRootSeq(response.seq) && isRootHash(response.root_sha256)))
  }
  return true
}

export const classifyHistoryReceipt = (op: HistoryOp, request: Record<string, unknown>, result: HistoryProcessResult): HistoryRun => {
  if (result.isStdoutTruncated === true) return { kind: 'pending', cause: `history ${op} receipt was truncated` }
  if (result.isStderrTruncated === true) return { kind: 'pending', cause: `history ${op} stderr was truncated` }
  let response: unknown
  try { response = result.stdout.endsWith('\n') && !result.stdout.slice(0, -1).includes('\n') ? JSON.parse(result.stdout) : undefined }
  catch { response = undefined }
  if (!isPlainObject(response) || response.protocol !== 3 || response.op !== op ||
      ('request_id' in request && response.request_id !== request.request_id)) return { kind: 'pending', cause: `history ${op} receipt is incompatible (exit ${result.exitCode})` }
  if (result.exitCode === 0 && response.ok === true) {
    return okReceiptValid(op, response) ? { kind: 'ok', response } : { kind: 'pending', cause: `history ${op} receipt is incompatible (exit 0)` }
  }
  if (result.exitCode === 1 && response.ok === false && response.phase === 'precommit' && typeof response.reason === 'string') return { kind: 'refused', reason: response.reason }
  return { kind: 'pending', cause: typeof response.reason === 'string' ? response.reason : `history ${op} exit ${result.exitCode}` }
}
