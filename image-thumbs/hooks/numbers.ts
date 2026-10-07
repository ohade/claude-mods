// Claude Code numbers the pictures pasted in a session (#1, #2, ...) and writes
// [Image #n] where each one sits in the prompt's text. The tag is what ties a
// picture to the rows that show it: the typed prompt, a slash command's row
// (its pictures arrive on the command's expansion, a row of their own), and a
// message sent while Claude works (they arrive on the attachment that folds it
// into the turn).
const TAG = /\[Image #(\d+)\]/g

// The picture numbers a text names, each once, in the order first written.
export const imageNumbers = (text: string): number[] => [
  ...new Set([...text.matchAll(TAG)].map(match => Number(match[1]))),
]

// The numbers of a row's own pictures, in order: those its text names past
// `last`, the newest number seen before. A number at or below it refers to an
// earlier picture again. A picture the text names nowhere (a file the prompt
// attached) has none.
export const freshNumbers = (text: string, last: number): number[] => imageNumbers(text).filter(n => n > last)
