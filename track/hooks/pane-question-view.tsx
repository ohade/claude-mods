// One question row. Native code supplies display values and the captured button callbacks.
import type { PaneElements } from './pane-elements'

type Control = { onPress: () => unknown; hotkey?: string; dimColor?: true; variant?: 'primary' }
export type QuestionRow = {
  id: number
  glyph: string
  color: 'success' | undefined
  dim: boolean
  compact: boolean
  rowIndent: number
  width: number
  headShown: string
  reveal: { side: 'q' | 'a' | undefined; text: string } | undefined
  question: Control | undefined
  answer: Control | undefined
  onWithdraw: () => unknown
}

export const questionView = ({ Box, Button, Text }: PaneElements, row: QuestionRow): JSX.Element => {
  const { id, glyph, color, dim, compact, rowIndent, width, headShown, reveal, question, answer, onWithdraw } = row
  const dot = <Text color={color} dimColor={dim}>{glyph}</Text>
  const markers = (
    <Box key={`q-markers-${id}`} width={13} flexShrink={0} flexDirection="row" columnGap={1}>
      <Box key={`q-question-slot-${id}`} width={6} flexShrink={0}>
        {question === undefined ? <Text dimColor>[ Q ]</Text> : <Button key={`q-${id}`} label="Q" {...question} />}
      </Box>
      <Box key={`q-answer-slot-${id}`} width={6} flexShrink={0}>
        {answer === undefined ? <Text color="subtle" dimColor>[ A ]</Text> : <Button key={`a-${id}`} label="A" {...answer} />}
      </Box>
    </Box>
  )
  const text = (
    <Box key={`q-text-${id}`} flexDirection="column" flexShrink={1} width={width}>
      <Text color={color} dimColor={dim} wrap="wrap">{headShown}</Text>
      {reveal !== undefined && <Box key={`reveal-${reveal.side}-${id}`}><Text>{reveal.text}</Text></Box>}
    </Box>
  )
  const remove = <Button key={`del-${id}`} plain dimColor label="✕" onPress={onWithdraw} />

  // The text gets the pane's width when its fixed control column would crowd it out.
  // Both layouts use the same controls and sources; the extra row is budgeted natively.
  return (
    <Box key={`row-q-${id}`} flexDirection={compact ? 'column' : 'row'} flexShrink={0} columnGap={1} marginLeft={rowIndent}>
      {/* Native Fragment is a column Box, so arrays keep row children flat. */}
      {compact ? [
        <Box flexDirection="row" columnGap={1}>{dot}{text}</Box>,
        <Box flexDirection="row" columnGap={1}>{markers}{remove}</Box>,
      ] : [dot, markers, text, remove]}
    </Box>
  )
}
