// The pane shell consumes display values and opaque native-prepared nodes.
import type { PaneElements } from './pane-elements'
import type { BannerRow } from './banner-layout'
import { HEADER_GAP } from './pane-layout'

export type PaneFrame = {
  width: number; bodyRows: number; roomy: boolean; titleLabel: string; titleSide: number
  qDone: number; qTotal: number; qRing: string; qHidden: string; qRows: number; qEmpty: string
  sDone: number; sTotal: number; sRing: string; sHidden: string; sRows: number; sEmpty: string
  questionClear: JSX.Element | false; answeredClear: JSX.Element | false
  stepHeaderControls: JSX.Element[] | false; bottomControls: JSX.Element[]
  questionRows: JSX.Element[]; stepRows: JSX.Element[]; hints: { key: string; text: string }[]; bannerRows: BannerRow[]
}

export const paneItem = ({ Box }: PaneElements, key: string, child: JSX.Element): JSX.Element => (
      <Box key={key} flexShrink={0}>
        {child}
      </Box>
    )

export const paneRootView = (elements: PaneElements, frame: PaneFrame): JSX.Element => {
  const { Box, Text } = elements
  const { width, bodyRows, roomy, titleLabel, titleSide, qDone, qTotal, qRing, qHidden, qRows, qEmpty, sDone, sTotal, sRing, sHidden, sRows, sEmpty, questionClear, answeredClear, stepHeaderControls, bottomControls, questionRows, stepRows, hints, bannerRows } = frame
  const item = (key: string, child: JSX.Element) => paneItem(elements, key, child)
  return (
      <Box flexDirection="column" height={bodyRows} overflow="hidden">
        {/* The title as a centered header bar, rules filling the width. */}
        <Box key="title" flexDirection="row" justifyContent="center" marginBottom={roomy ? 1 : 0}>
          <Text dimColor>{'─'.repeat(titleSide)}</Text>
          <Text bold color="claude">
            {titleLabel}
          </Text>
          <Text dimColor>{'─'.repeat(Math.max(0, width - titleLabel.length - titleSide))}</Text>
        </Box>
        <Box key="questions-header" flexDirection="row" flexWrap="wrap" columnGap={HEADER_GAP}>
          {item('questions-word', <Text bold>Questions</Text>)}
          {item('questions-ring', <Text color={qDone === qTotal && qTotal > 0 ? 'success' : 'warning'}>{qRing}</Text>)}
          {/* The engine draws "q: label", so the gap is the header's, not padding in the label. */}
          {questionClear}
          {answeredClear}
          {qHidden !== '' && item('questions-hidden', <Text dimColor>{qHidden}</Text>)}
        </Box>
        <Box key="questions" flexDirection="column" height={qRows} overflow="hidden">
        {qTotal === 0 && (
          <Text dimColor wrap="wrap">
            {qEmpty}
          </Text>
        )}
        {questionRows}
        </Box>
        <Text dimColor>{'─'.repeat(width)}</Text>
        <Box key="steps-header" flexDirection="row" flexWrap="wrap" columnGap={HEADER_GAP}>
          {item('steps-word', <Text bold>Steps</Text>)}
          {item('steps-ring', <Text color={sDone === sTotal && sTotal > 0 ? 'success' : 'warning'}>{sRing}</Text>)}
          {stepHeaderControls}
          {sHidden !== '' && item('steps-hidden', <Text dimColor>{sHidden}</Text>)}
        </Box>
        <Box key="steps" flexDirection="column" height={sRows} overflow="hidden">
        {sTotal === 0 && (
          <Text dimColor wrap="wrap">
            {sEmpty}
          </Text>
        )}
        {/* Steps read like questions: the same dots (○ pending, ◐ in progress, ● done), the
            same left edge, a number S<n> by position, and green once done. */}
        {stepRows}
        </Box>
        <Box flexGrow={1} />
        <Box key="bottom-bar" flexDirection="row" flexWrap="wrap" columnGap={HEADER_GAP} marginTop={roomy ? 1 : 0}>
          {bottomControls}
          {hints.map(hint => item(hint.key, <Text dimColor>{hint.text}</Text>))}
        </Box>
        {/* One row per active state. The wrapper keeps the old banner seat; only the amber glyph pulses. */}
        <Box key="banner" width={width} flexDirection="column" justifyContent="center" backgroundColor={bannerRows.at(-1)?.background ?? 'success'}>
          {bannerRows.map(row => (
            <Box key={row.key} width={width} justifyContent="center" backgroundColor={row.background}>
              {row.glyph !== '' && <Text key={`${row.key}-glyph`} color={row.glyphColor} bold>{row.glyph}</Text>}
              <Text key={`${row.key}-words`} color="inverseText" bold>{row.words}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
}
