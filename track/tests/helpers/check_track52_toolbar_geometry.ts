import assert from 'node:assert/strict'
import { paneRowMetrics } from '../../hooks/pane-row-metrics'

const base: Parameters<typeof paneRowMetrics>[0] = {
  width: 48,
  bodyRows: 20,
  compact: false,
  rowIndent: 0,
  clearWidths: [18],
  hints: [],
  hasQuestions: false,
  hasSteps: true,
  allLabel: 'All',
  doneLabel: 'Done',
  questions: [],
  steps: [],
  opened: {},
  resultReveals: new Map(),
  qEmpty: 'No questions',
  sEmpty: 'No steps',
  questionLabel: id => String(id),
  clockOf: () => '',
}

const sessionLabel = 'Session: 1355713e-de79-46f3-b633-f005c3226af0'
const cases = [
  { width: 48, bottomRows: 3 },
  { width: 24, bottomRows: 6 },
  { width: 80, bottomRows: 2 },
]

for (const { width, bottomRows } of cases) {
  const legacy = paneRowMetrics({ ...base, width })
  assert.equal(legacy.bottomRows, 1, `legacy footer at width ${width}`)
  assert.deepEqual(legacy.sButtons, [18], `legacy Steps controls at width ${width}`)

  // A variable permits the prospective optional fields before the selector accepts them.
  const input = { ...base, width, sessionLabel, bottomWidths: [18, 15, 15] }
  const metrics = paneRowMetrics(input)
  assert.equal(metrics.bottomRows, bottomRows, `session and footer rows at width ${width}`)
  assert.deepEqual(metrics.sButtons, [18], `Steps controls remain unchanged at width ${width}`)
}
