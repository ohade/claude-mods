// Lines `text` takes word-wrapped at `width` columns, as the terminal wraps it: a word that does
// not fit starts a new line, and a word longer than a line is broken.
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
const graphemesOf = (text: string): string[] => Array.from(segmenter.segment(text), part => part.segment)
// Conservative terminal widths: emoji clusters and East Asian wide glyphs use
// two columns. Combining marks stay with their base through Intl.Segmenter.
export const columnsOf = (text: string): number => graphemesOf(text).reduce((sum, cluster) => sum + (
  /^[\p{Mark}\p{Cf}]+$/u.test(cluster) ? 0
    : /[\p{Extended_Pictographic}\p{Regional_Indicator}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(cluster) ? 2 : 1
), 0)
export const wrappedLines = (text: string, width: number): number => {
  let lines = 1
  let used = 0
  for (const word of text.split(' ')) {
    const columns = columnsOf(word)
    if (used > 0 && used + 1 + columns <= width) {
      used += 1 + columns
    } else if (columns > 0) {
      const extra = Math.floor((columns - 1) / width)
      lines += (used > 0 ? 1 : 0) + extra
      used = columns - extra * width
    }
  }

  return lines
}

// A row's text, cut with an ellipsis to the lines it may take: for a row taller than its whole
// region, whose last lines no scroll could reach.
export const fitLines = (text: string, width: number, lines: number): string => {
  const most = Math.max(1, lines)
  if (wrappedLines(text, width) <= most) {
    return text
  }
  const clusters = graphemesOf(text)
  let cut = Math.min(clusters.length, Math.max(1, width * most - 1))
  while (cut > 0 && wrappedLines(`${clusters.slice(0, cut).join('').trimEnd()}…`, width) > most) {
    cut--
  }

  return `${clusters.slice(0, cut).join('').trimEnd()}…`
}
