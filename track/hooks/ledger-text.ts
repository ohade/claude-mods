// Caps: heads are short, lists are bounded, so the ledger stays small in $.state and $.store.
// Long enough to keep a question whole; the pane wraps it rather than cutting it.
export const HEAD_CHARS = 200

// An answer is kept for the next session to read, cut to this many characters. With
// MAX_QUESTIONS it bounds the answers in one register near 200 KB, well inside STORE_BUDGET.
export const ANSWER_CHARS = 1000

// Results use the same saved-text budget; the native source retains full words.
export const RESULT_CHARS = ANSWER_CHARS

export const truncate = (text: string, width: number): string => {
  const points = Array.from(text)
  return points.length > width ? `${points.slice(0, Math.max(1, width - 1)).join('')}…` : text
}

// The first line of a prompt, without image tags, cut to HEAD_CHARS.
export const headOf = (text: string): string => {
  const line = text.replace(/\[Image #\d+\]/g, '').trim().split('\n')[0] ?? ''

  return truncate(line, HEAD_CHARS)
}

// A title for matching: lowercase, without a leading number or checkbox, punctuation, or
// repeated spaces. A Task links to the plan step whose normalized title is the same.
export const norm = (title: string): string =>
  title
    .toLowerCase()
    .replace(/^\s*(?:\d+[.)]|[-*+]\s*\[[ x]\])\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
