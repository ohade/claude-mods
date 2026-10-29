import { columnsOf, fitLines } from './terminal-text'

export type BannerCount = { kind: 'agents' | 'tasks'; n: number }
export type BannerParts = { label: string; brief: string; questions: string[]; steps: string[]; counts: BannerCount[] }
export type BannerRow = { key: string; glyph: string; words: string; background: string; glyphColor: string; parts: BannerParts }

// A row is parts, not a sentence to parse. The glyph counts toward the width, in terminal columns.
// Narrowing order: the shorter label (keeps the step ids), a labelled step count, then no label
// (the glyph and color still name the row) with ids, then with the count. The shortest form is cut.
const composeBanner = (label: string, steps: string[], parts: BannerParts): string => {
  const { questions, counts } = parts
  if (questions.length === 0 && steps.length === 0 && counts.length === 1 && ((counts[0]?.kind === 'tasks' && label === 'Tasks') || (counts[0]?.kind === 'agents' && label === 'Agents'))) {
    return `${label} ${counts[0]!.n}`
  }

  return [label, ...questions, ...steps, ...counts.map(count => `${count.kind} ${count.n}`)].filter(part => part !== '').join(' · ')
}
const bannerFits = (glyph: string, body: string, width: number): boolean =>
  columnsOf(glyph === '' ? body : `${glyph} ${body}`) <= width
const stepCount = (steps: string[]): string[] => (steps.length > 0 ? [`steps ${steps.length}`] : steps)
const bannerWords = (glyph: string, body: string): string => (glyph === '' ? body : ` ${body}`)
export const bannerLine = (glyph: string, parts: BannerParts, width: number): { glyph: string; words: string } => {
  const full = composeBanner(parts.label, parts.steps, parts)
  const brief = composeBanner(parts.brief, parts.steps, parts)
  const counted = composeBanner(parts.brief, stepCount(parts.steps), parts)
  const candidates = [full, brief, counted]
  if (glyph !== '' && (parts.questions.length > 0 || parts.steps.length > 0 || parts.counts.length > 0)) {
    candidates.push(composeBanner('', parts.steps, parts), composeBanner('', stepCount(parts.steps), parts))
  }
  const forms = candidates.filter((body, index) => body !== '' && candidates.indexOf(body) === index)
  for (const body of forms) {
    if (bannerFits(glyph, body, width)) return { glyph, words: bannerWords(glyph, body) }
  }
  const glyphCols = glyph === '' ? 0 : columnsOf(glyph) + 1
  const shortest = forms.reduce((best, body) => (columnsOf(body) < columnsOf(best) ? body : best), full)

  return { glyph, words: bannerWords(glyph, fitLines(shortest, Math.max(1, width - glyphCols), 1)) }
}
const collapseBrief = (row: BannerRow): string =>
  row.key === 'banner-unsaved' ? 'Unsaved' : row.key === 'banner-unknown' ? 'Unknown' : row.parts.brief
const collapseSegment = (row: BannerRow, mode: 'full' | 'brief' | 'count' | 'label'): string => {
  const label = mode === 'full' ? row.parts.label : collapseBrief(row)
  const steps = mode === 'count' ? stepCount(row.parts.steps) : row.parts.steps
  const body = mode === 'label' ? label : composeBanner(label, steps, row.parts)

  return row.glyph === '' ? body : `${row.glyph} ${body}`
}
// One line, priority unsaved, you, unknown, working, agents, paused. Shorten a label before
// dropping its step ids. Then every state by its label alone, before any state is dropped; then
// drop the lowest-priority segment behind a +n, never Unsaved or You.
// Widths are terminal columns.
export const collapseLine = (rows: BannerRow[], width: number): BannerRow => {
  const order = ['banner-unsaved', 'banner-you', 'banner-unknown', 'banner-working', 'banner-agents', 'banner-paused']
  const ordered = [...rows].filter(row => row.key !== 'banner-idle').sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  const first = ordered[0]
  const empty: BannerParts = { label: '', brief: '', questions: [], steps: [], counts: [] }
  if (first === undefined) return { key: 'banner-line', glyph: '', words: '', background: 'success', glyphColor: 'inverseText', parts: empty }
  const asLine = (text: string, row: BannerRow): BannerRow => ({ ...row, key: 'banner-line', glyph: '', words: text, glyphColor: 'inverseText' })
  const modes: Array<'full' | 'brief' | 'count'> = ordered.map(() => 'full')
  const joined = () => ordered.map((row, index) => collapseSegment(row, modes[index] ?? 'full')).join(' · ')
  let text = joined()
  while (columnsOf(text) > width) {
    const briefAt = modes.findIndex((mode, index) => mode === 'full' && collapseSegment(ordered[index]!, 'brief') !== collapseSegment(ordered[index]!, 'full'))
    if (briefAt >= 0) {
      modes[briefAt] = 'brief'
      text = joined()
      continue
    }
    const countAt = modes.findIndex((mode, index) => mode !== 'count' && (ordered[index]?.parts.steps.length ?? 0) > 0)
    if (countAt >= 0) {
      modes[countAt] = 'count'
      text = joined()
      continue
    }
    break
  }
  if (columnsOf(text) <= width) return asLine(text, first)
  const kept = [...ordered]
  let dropped = 0
  const lineOf = (mode: 'count' | 'label') => [...kept.map(row => collapseSegment(row, mode)), ...(dropped > 0 ? [`+${dropped}`] : [])].join(' · ')
  for (;;) {
    for (const mode of ['count', 'label'] as const) {
      if (columnsOf(lineOf(mode)) <= width) return asLine(lineOf(mode), kept[0] ?? first)
    }
    const victim = kept.length > 1 ? [...kept].reverse().find(row => row.key !== 'banner-you' && row.key !== 'banner-unsaved') : undefined
    if (victim === undefined) break
    kept.splice(kept.indexOf(victim), 1)
    dropped += 1
  }
  const suffix = dropped > 0 ? ` · +${dropped}` : ''
  const body = kept.map(row => collapseSegment(row, 'label')).join(' · ')
  const room = width - columnsOf(suffix)

  return asLine(room >= 1 ? `${fitLines(body, room, 1)}${suffix}` : fitLines(`+${dropped}`, width, 1), kept[0] ?? first)
}
