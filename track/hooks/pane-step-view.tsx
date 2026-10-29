// One step row of the pane, drawn with the constructors the native pane resolved. Sizes, the
// wrapped text and the clock arrive computed; presses go back through the native callbacks.
import type { Step } from '../types'
import type { PaneElements } from './pane-elements'
import { stepLook } from './work-appearance'
import type { WorkState } from './work-appearance'

export type StepRow = {
  step: Step
  // The row's position in the whole list, not in the shown window.
  index: number
  // The paused step's note when it is a lifecycle note (a cancel or a refusal), else undefined.
  lifecycle: string | undefined
  phase: number
  work: WorkState
  compact: boolean
  rowIndent: number
  // The acknowledged completed step whose result this row may show or jump to.
  result: Step | undefined
  headShown: string
  resultShown: string | undefined
  width: number
  subjectWidth: number
  // Present only for a step with a clock.
  clockLabel: string | undefined
  follow: JSX.Element | false
  onToggleResult: (result: Step, index: number) => unknown
  onJumpResult: (key: string) => unknown
}

export const stepView = ({ Box, Button, Text }: PaneElements, row: StepRow): JSX.Element => {
  const { step: s, index, lifecycle, phase, work, compact, rowIndent, result, headShown, resultShown, width, subjectWidth, clockLabel, follow, onToggleResult, onJumpResult } = row
  const look = stepLook(s, lifecycle, work, phase)

  const dot = <Box key={`s-status-${s.id}`} width={2} flexShrink={0}><Text color={look.glyphColor}>{look.glyph}</Text></Box>
  const resultKey = result?.resultRequestId === undefined ? undefined : `result:${result.resultRequestId}`
  const resultControl = s.status === 'completed' && <Box key={`s-result-slot-${s.id}`} width={6} flexShrink={0}>
    {result?.resultText === undefined ? <Text dimColor>[ R ]</Text> : <Button key={`r-${s.id}`} variant="primary" label="R" onPress={() => resultKey === undefined
      ? onToggleResult(result, index)
      : onJumpResult(resultKey)} />}
  </Box>
  const text = (
    <Box key={`s-text-${s.id}`} flexDirection="column" flexShrink={1} flexGrow={1} width={width}>
      <Box flexDirection="row" columnGap={1}>
        {!compact && resultControl}
        <Box width={subjectWidth} flexShrink={1}><Text color={look.textColor} wrap="wrap">{headShown}</Text></Box>
      </Box>
      {resultShown !== undefined && <Text key={`s-result-text-${s.id}`} wrap="wrap">{resultShown}</Text>}
    </Box>
  )
  const clock = clockLabel !== undefined && (
    <Box key={`s-clock-${s.id}`} flexShrink={0} alignSelf={compact ? 'flex-end' : undefined}>
      <Text dimColor color={s.endedAt === undefined ? look.textColor : undefined}>
        {clockLabel}
      </Text>
    </Box>
  )

  const reason = lifecycle !== undefined && <Text key={`s-reason-${s.id}`} dimColor>{lifecycle}</Text>
  return (
    <Box key={`row-s-${s.id}`} flexDirection={compact ? 'column' : 'row'} flexShrink={0} columnGap={1} marginLeft={rowIndent}>
      {compact ? <Box flexDirection="row" columnGap={1}>{dot}{text}</Box> : [dot, text]}
      {reason}
      {follow}
      {compact ? <Box flexDirection="row" columnGap={1}>{resultControl}{clock}</Box> : clock}
    </Box>
  )
}
