// 2026-10-26: a compaction that sends no session.compact callback looked like a rewind and
// cleared acknowledged rows. These pure helpers compare a transcript read with the last one.

// One cheap fingerprint per message: equal messages give equal strings. It is never persisted.
const messagePrint = (role: string, text: string, ids: string[]): string => {
  const s = `${role}\u0000${text}\u0000${ids.join(',')}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `${role}:${s.length}:${(h >>> 0).toString(16)}`
}

const hasPrefix = (whole: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= whole.length && prefix.every((p, i) => p === whole[i])

export const printsOf = (messages: readonly { role: string; text: string; toolUses: readonly { tool_use_id: string }[] }[]): string[] =>
  messages.map(m => messagePrint(m.role, m.text, m.toolUses.map(u => u.tool_use_id)))

// What a read means against the baseline: judge it for rewound rows (no baseline, growth, a rewound
// prefix, or that prefix plus exactly the prompt being sent), decide nothing (no prompt text to
// tell a rewind plus its prompt apart), or a compaction that sent no callback.
export const classifyTranscriptChange = (base: readonly string[] | undefined, prints: readonly string[],
  last: { role: string; text: string } | undefined, submitted: string | undefined): 'judge' | 'undecided' | 'compacted' => {
  if (base === undefined || hasPrefix(prints, base) || hasPrefix(base, prints)) return 'judge'
  if (submitted !== undefined && last?.role === 'user' && last.text.trim() === submitted.trim() &&
    hasPrefix(base, prints.slice(0, -1))) return 'judge'
  return submitted === undefined ? 'undecided' : 'compacted'
}
