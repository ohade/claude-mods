// FIXTURE: real plugin render hooks with a native-row stand-in. This checks
// continuation and props, not a person's expansion gesture in a live terminal.
import { expect, test } from 'claude-code/testing'
import { atomStore, EMPTY } from './kit'

const TOOLS = [
  { tool: 'mcp__track__track_question', input: { summary: 'An expanded question' } },
  { tool: 'mcp__track__mark_answered', input: { id: 1, status: 'answered' } },
  { tool: 'mcp__track__track_steps', input: { titles: ['An expanded step'] } },
  { tool: 'mcp__track__mark_step', input: { id: 'plan:1', status: 'pending' } },
  { tool: 'mcp__track__restore_tracker', input: { from_session: '11111111-2222-4333-8444-555555555555' } },
]

for (const component of ['ToolUse', 'ToolResult'] as const) {
  for (const { tool, input } of TOOLS) {
    test(`UI-4 expanded ${component} for ${tool} returns the native row`, async ($, on) => {
      atomStore(on, 'ledger', EMPTY)
      const nativeProps: unknown[] = []
      const nativeText = `Native ${component}: ${tool}`
      on('ui.render', { component }, (_, e) => {
        nativeProps.push(e.props)
        return { type: 'Text', props: {}, children: [nativeText] }
      })
      const props = {
        tool, tool_use_id: 'expanded-call', isExpanded: true,
        ...(component === 'ToolUse'
          ? { input, isRunning: false, isErrored: false, isInterrupted: false }
          : { output: 'Native result details', isErrored: false }),
      }

      const ui = await $.ui.mount({
        plugin: 'track', surface: 'terminal', component, requestId: 'expanded-row', props,
      } as never)

      expect(nativeProps).toHaveLength(1)
      expect(nativeProps[0]).toMatchObject(props)
      expect((await ui.findAll({ type: 'Text' })).map(row => row.text)).toEqual([nativeText])
    })

    test(`UI-4 collapsed ${component} for ${tool} keeps Track rendering`, async ($, on) => {
      atomStore(on, 'ledger', EMPTY)
      const nativeCalls: unknown[] = []
      on('ui.render', { component }, (_, e) => {
        nativeCalls.push(e.props)
        return { type: 'Text', props: {}, children: ['Native details must stay folded'] }
      })

      const ui = await $.ui.mount({
        plugin: 'track', surface: 'terminal', component, requestId: 'collapsed-row',
        props: {
          tool, tool_use_id: 'collapsed-call', isExpanded: false,
          ...(component === 'ToolUse'
            ? { input, isRunning: false, isErrored: false, isInterrupted: false }
            : { output: 'Native result details', isErrored: false }),
        },
      } as never)

      expect(nativeCalls).toHaveLength(0)
      expect(await ui.find({ type: 'Text', text: 'Native details must stay folded' })).toBeUndefined()
    })
  }
}
