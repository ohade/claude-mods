// FIXTURE: retention-marker handling must keep genuine durable history protected.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore, trackCommand } from './kit'

const OLD = '11111111-2222-4333-8444-555555555555'
const OTHER_GENERATION = '99999999-2222-4333-8444-555555555555'

for (const state of ['different-generation', 'missing-body', 'retention-marker'] as const) {
  test(`import reconciles head metadata without overwriting durable history: ${state}`, async ($, on) => {
    atomStore(on, 'ledger', EMPTY)
    const legacy = { v: 1, savedAt: 1, ledger: { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'Saved work', at: 1, turnId: 'old', status: 'deferred' }] } }
    const store = pluginStore(on, { [`s:${OLD}`]: legacy }, undefined, { guardStates: { [OLD]: 'closed' } })
    const files = new Map<string, string>()
    on('session.id', () => ({ value: SESSION }))
    on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
    on('fs.read', { path: /^(?!\/fixture\/config\/state\/track\/blobs\/[0-9a-f]{64}\.json$)/ }, (_, e) => ({ value: files.get(e.path) ?? '' }))
    blobPool(on)
    const exported = JSON.parse((await trackCommand($, 'export /backup.json')).text ?? '{}')
    expect(exported.ok).toBe(true)
    const source = files.get('/backup.json')
    store.held.delete(`s:${OLD}`)
    const imported = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
    expect(imported).toMatchObject({ ok: true, imported: [OLD], verified: [OLD] })
    const saved = store.held.get(`s:${OLD}`)
    const head = store.held.get(`h:${OLD}`) as object
    const protectedHead = state === 'retention-marker'
      ? { v: 1, session_id: OLD, retentionOnly: true, closedAt: 123 }
      : { ...head, generation: OTHER_GENERATION }
    store.held.set(`h:${OLD}`, protectedHead)
    if (state === 'missing-body') store.held.delete(`s:${OLD}`)

    const result = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
    if (state === 'retention-marker') {
      expect(result).toMatchObject({ ok: true, imported: [], verified: [OLD] })
      expect(store.held.get(`s:${OLD}`)).toEqual(saved)
      expect(store.held.get(`h:${OLD}`)).toEqual(head)
    } else {
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('has a durable head')
      expect(store.held.get(`s:${OLD}`)).toEqual(state === 'missing-body' ? undefined : saved)
      expect(store.held.get(`h:${OLD}`)).toEqual(protectedHead)
    }
    expect(files.get('/backup.json')).toBe(source)
  })
}
