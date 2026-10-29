import type { Step } from '../types'

// The transcript sentence for a tool the user cancelled by sending a message, and the two
// refusal sentences a permission prompt writes. On an error, the model-read text carries the
// sentence; the stored result is checked when the text does not start with one. A deny can carry
// a refusal with no error flag. Only a leading BOM or whitespace is ignored. A sentence after
// other text is not a cancel.
const USER_CANCEL = "The user doesn't want to take this action right now"
const USER_REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected"
const PERMISSION_DENIED = /^Permission to use \S+ has been denied\b/
const withoutLeadingSpace = (text: string): string => text.replace(/^(?:\uFEFF|\s)+/, '')
const reasonAtStart = (raw: unknown): 'cancelled by you' | 'refused' | undefined => {
  if (typeof raw !== 'string') return undefined
  const text = withoutLeadingSpace(raw)
  if (text.startsWith(USER_CANCEL)) return 'cancelled by you'
  if (text.startsWith(USER_REJECT) || PERMISSION_DENIED.test(text)) return 'refused'
  return undefined
}
export const cancelReasonOf = (ran: { result?: unknown; deny?: unknown; text?: unknown; isError?: boolean }): 'cancelled by you' | 'refused' | undefined => {
  if (reasonAtStart(ran.deny) === 'refused') return 'refused'
  if (ran.isError !== true) return undefined
  return reasonAtStart(ran.text) ?? reasonAtStart(ran.result)
}
// The one in-progress step of this turn that can own a cancel. Two or none means no change.
// A restored step has no turn id, so it never owns a cancel. An Agent launch may belong to the
// delegated step that started it this turn; every other tool belongs only to non-delegated work.
export const cancelOwner = (steps: Step[], tool: string, currentId: string | null): string | undefined => {
  if (currentId === null) return undefined
  const candidates = steps.filter(s => s.cleared !== true && s.status === 'in_progress' && s.activeTurnId === currentId && (tool === 'Agent' || s.delegated !== true))
  return candidates.length === 1 ? candidates[0]?.id : undefined
}
