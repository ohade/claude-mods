// FIXTURE: 2026-10-08 an existing session retained old instruction metadata.
// A boolean composeSeen cannot establish that the current rule reached Claude.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore } from './kit'

for (const origin of [{ kind: 'composer' }, { kind: 'plugin', name: 'peer-fixture' }, { kind: 'task-notification' }]) {
  test(`a legacy compose flag cannot suppress the current rule for ${origin.kind}`, async ($, on) => {
    atomStore(on, 'ledger', EMPTY)
    atomStore(on, 'turn', { currentId: 'old', gatedTurnId: null, composeSeen: true })
    let context: readonly string[] = []
    on('prompt.submit', (_, e) => { context = e.context ?? []; return { text: e.text } })
    await $.prompt.submit({ text: 'A substantive request from this sender', origin } as never)
    expect(context.filter(line => line.includes('For meaningful work or substantive questions'))).toHaveLength(1)
    expect(context.join('\n')).toContain('regardless of sender')
    expect(context.join('\n')).toContain('later content in this turn')
  })
}
