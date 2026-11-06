import type { ReportElements } from './pane-elements'
import type { ReportForm } from './report-flow'

export type ReportFrame = {
  form: ReportForm
  width: number
  onNote: (value: string) => void
  onPreview: (value: string) => void
  onFile: () => void
  onClose: () => void
  onCopySession: () => void
}

export const reportView = ({ Box, Button, Text, Input }: ReportElements, frame: ReportFrame): JSX.Element => {
  const { form } = frame
  const canEdit = form.phase === 'editing' || form.phase === 'preview'
  return (
    <Box flexDirection="column" width={frame.width}>
      <Text wrap="wrap">Report a Track issue</Text>
      <Text wrap="wrap">{form.owner ? `Session: ${form.owner.session}` : 'Session unavailable'}</Text>
      {form.owner && <Button key="report-copy" label="Copy session" onPress={frame.onCopySession} />}
      {canEdit && <Input key="report-note" label="What went wrong?" value={form.note} rows={3} submitLabel="preview" onInput={frame.onNote} onSubmit={frame.onPreview} />}
      {canEdit && <Text wrap="wrap">4000 characters maximum. Preview before filing.</Text>}
      {canEdit && <Button key="report-preview" label="Preview" onPress={() => frame.onPreview(form.note)} />}
      {form.phase === 'preview' && <Text wrap="wrap">Will be sent:</Text>}
      {form.phase === 'preview' && <Text wrap="wrap">{form.noteOut}</Text>}
      {form.phase === 'preview' && form.scope?.map((entry, index) => <Text key={`report-scope-${index}`} wrap="wrap">{entry}</Text>)}
      {form.phase === 'preview' && form.noteChanged && <Text wrap="wrap">The preview note was redacted. Your original stays on this Mac.</Text>}
      {form.phase === 'preview' && form.draftId && <Button key="report-file" label="File report" onPress={frame.onFile} />}
      {form.phase === 'previewing' && <Text wrap="wrap">Preparing preview…</Text>}
      {form.phase === 'filing' && <Text wrap="wrap">Submitting report…</Text>}
      {form.phase === 'filed' && <Text wrap="wrap">{'Created ' + form.ticket}</Text>}
      {form.phase === 'ambiguous' && <Text wrap="wrap">Check Plane before filing another report; do not retry this draft.</Text>}
      {form.error && <Text color="error" wrap="wrap">{form.error}</Text>}
      <Button key="report-close" label="Close" onPress={frame.onClose} />
    </Box>
  )
}
