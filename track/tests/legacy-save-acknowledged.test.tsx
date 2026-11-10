// FIXTURE: a legacy save counts as saved once its writes are acknowledged, even if the closing durability write then fails. Real mod handlers, in-memory kit storage/locks.
import { expect, test } from 'claude-code/testing'
import { atomStore, blobPool, pluginStore } from './kit'
import { LEGACY_SESSION as ID, legacyLedger } from './helpers/legacy_save_cases'

test('a checkpoint whose closing durability write fails still reports the acknowledged save, with the ledger flagged unsaved', async ($, on) => {
  let refused = false
  on('state.set', { plugin: 'track', key: ['durability'] }, (_, event, next) => {
    const value = event.value as { baseline?: unknown }
    if (!refused && value.baseline !== undefined) {
      refused = true
      return { deny: 'durability write refused' }
    }

    return next(event)
  })
  atomStore(on, 'ledger', legacyLedger())
  const state = atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: ID })
  atomStore(on, 'turn', { currentId: 'save-turn', gatedTurnId: null })
  on('session.id', () => ({ value: ID }))
  const store = pluginStore(on)
  const pool = blobPool(on)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: ID } as never)).result))
  expect(refused, 'FIXTURE control: the closing durability write was refused').toBe(true)
  expect((await pool.logical(store, `s:${ID}`) as { ledger: unknown }).ledger).toEqual(legacyLedger())
  expect(state.value.isUnsaved).toBe(true)
  expect(state.value.reason).toContain('durability write refused')
  expect(receipt.ok).toBe(true)
})
