// FIXTURE data shared by the original/native workflow and independent port runner.
import type { Ledger } from '../../types'

export const LEGACY_SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
export const legacyLedger = (): Ledger => ({ v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [], session_id: LEGACY_SESSION })
export const legacyLateStep = { id: 'plan:late', source: 'plan' as const, subject: 'Arrived after snapshot', status: 'pending' as const, session_id: LEGACY_SESSION }
export const legacyCommitOrder = [`set:s:${LEGACY_SESSION}`, `set:h:${LEGACY_SESSION}`, 'set:saved']
export const missingBodyError = 'stale writer revision; newer durable head was kept; its missing body needs recovery'
export const legacyFallback = 'fixture publication unavailable'
