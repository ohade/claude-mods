// Compiler gate: on 2026-11-03 a connected MCP tool hid Track's registered
// names from the SDK union. This file is compiled, never run as a native test.
import type { McpToolInputs, ToolCallArgs, ToolCallInput } from 'claude-code'
import { toolContracts } from '../hooks/tool-contracts'

type Assert<Condition extends true> = Condition
type Contracts = ReturnType<typeof toolContracts>
type TrackName = `mcp__track__${keyof Contracts}`
export type EveryTrackToolIsDeclared = Assert<TrackName extends keyof McpToolInputs ? true : false>
export type NoCatchAllToolDeclaration = Assert<string extends keyof McpToolInputs ? false : true>
type MatchingKeys = {
  [Name in keyof Contracts]: `mcp__track__${Name}` extends keyof McpToolInputs
    ? keyof McpToolInputs[`mcp__track__${Name}`] extends keyof Contracts[Name]['inputSchema']['properties']
      ? keyof Contracts[Name]['inputSchema']['properties'] extends keyof McpToolInputs[`mcp__track__${Name}`]
        ? true : false
      : false
    : false
}
export type DeclaredKeysMatchRuntimeSchemas = Assert<MatchingKeys[keyof Contracts] extends true ? true : false>

export const validTrackInputs: ToolCallArgs[] = [
  { tool: 'mcp__track__track_question', summary: 'A question' },
  { tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: '4' },
  { tool: 'mcp__track__track_steps', steps: ['A step'], after: 'last' },
  { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed', result_text: '4' },
  { tool: 'mcp__track__restore_tracker', from_session: 'source', expected_checkpoint: { v: 1 } },
  { tool: 'mcp__track__checkpoint', expected_session: 'source' },
  { tool: 'mcp__track__lookup_rows', references: ['Q1'] },
  { tool: 'mcp__track__reorder_steps', ids: ['plan:1'] },
  { tool: 'mcp__track__diagnose' },
]

// @ts-expect-error Track has no tool with this name; an open string map is wrong.
export const inventedTrackTool: ToolCallArgs = { tool: 'mcp__track__invented' }

// Hook-side arguments retain their declared types. The SDK's call-side Omit
// loses argument precision; its separate frozen failing witness stays private.
export const questionSummary = (event: ToolCallInput): string | undefined => {
  if (event.tool === 'mcp__track__track_question') {
    const summary: string = event.summary
    return summary
  }
  return undefined
}
