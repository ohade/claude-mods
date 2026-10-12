// 2026-10-12: Q15's tracking paragraph duplicated its formatted native answer.
// A blocks identify completed answer regions without generating a second copy.
export type AnswerBlock = { id: number; start: number; end: number; text: string }

export const answerBlockKey = (row: string, id: number): string => `${row}:A${id}`

// Only standalone markers outside fenced/indented code and block quotes count.
// A malformed sequence invalidates the message, rather than completing a subset.
export const answerBlocks = (text: string): AnswerBlock[] => {
  const blocks: AnswerBlock[] = []
  const seen = new Set<number>()
  let open: { id: number; start: number; body: number } | undefined
  let fence: { char: string; size: number } | undefined
  let offset = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const end = Math.min(text.length, offset + raw.length + 1)
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence !== undefined) {
      if (boundary?.[1]?.[0] === fence.char && boundary[1].length >= fence.size && boundary[2]?.trim() === '') fence = undefined
    } else if (boundary !== null && !(boundary[1]![0] === '`' && boundary[2]!.includes('`'))) {
      fence = { char: boundary[1]![0]!, size: boundary[1]!.length }
    } else {
      const marker = /^ {0,3}<!-- A([1-9]\d*):(start|end) -->[ \t]*$/.exec(line)
      if (marker !== null) {
        const id = Number(marker[1])
        if (!Number.isSafeInteger(id)) return []
        if (marker[2] === 'start') {
          if (open !== undefined || seen.has(id)) return []
          open = { id, start: offset, body: end }
        } else {
          if (open === undefined || open.id !== id) return []
          const words = text.slice(open.body, offset).trim()
          if (words === '') return []
          blocks.push({ id, start: open.start, end, text: words })
          seen.add(id)
          open = undefined
        }
      }
    }
    offset = end
  }
  return open === undefined ? blocks : []
}
