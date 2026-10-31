// Codex tool_search fixtures shared by the tool_search tests (Go: constants and
// helpers of claude_openai-responses_tool_search_test.go).
export const codexToolSearchDeclaration =
  `{"type":"tool_search","execution":"client","description":"# Tool discovery\\n\\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\\n\\nSome of the tools may not have been provided to you upfront, and you should use this tool (` +
  "`tool_search`" +
  `) to search for the required tools.","parameters":{"type":"object","properties":{"limit":{"type":"number","description":"Maximum number of tools to return. Defaults to 8."},"query":{"type":"string","description":"Search query for deferred tools."}},"required":["query"],"additionalProperties":false}}`;
export const codexExecCommandTool = `{"type":"function","name":"exec_command","description":"Run a command.","strict":false,"parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}`;
export const codexDeferredTool = `{"type":"function","name":"lookup_order","description":"Look up an order.","strict":false,"defer_loading":true,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}`;
export const codexDeferredNSTool = `{"type":"namespace","name":"mcp__node_repl__","description":"Node REPL.","tools":[{"type":"function","name":"js","description":"Run JavaScript.","strict":false,"defer_loading":true,"parameters":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]}}]}`;
export const codexUserTurn = `{"type":"message","role":"user","content":[{"type":"input_text","text":"create a calendar event"}]}`;
export const codexCalendarNamespace = `{"type":"namespace","name":"mcp__codex_apps__","description":"Tools in the mcp__codex_apps__ namespace.","tools":[{"type":"function","name":"calendar_create_event","description":"Create a calendar event.","strict":false,"defer_loading":true,"parameters":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}}]}`;
export const codexSearchCall1 = `{"type":"tool_search_call","call_id":"call_search_1","status":"completed","execution":"client","arguments":{"query":"calendar create","limit":8}}`;
export const codexSearchOutput1 = `{"type":"tool_search_output","call_id":"call_search_1","status":"completed","execution":"client","tools":[{"type":"namespace","name":"mcp__codex_apps__","description":"Tools in the mcp__codex_apps__ namespace.","tools":[{"type":"function","name":"calendar_create_event","description":"Create a calendar event.","strict":false,"defer_loading":true,"parameters":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}}]},{"type":"function","name":"lookup_order","description":"Look up an order.","strict":false,"defer_loading":true,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}]}`;
export const codexNSCall = `{"type":"function_call","call_id":"call_cal_1","name":"calendar_create_event","namespace":"mcp__codex_apps__","arguments":"{\\"title\\":\\"Standup\\"}"}`;
export const codexNSCallOutput = `{"type":"function_call_output","call_id":"call_cal_1","output":"created"}`;
export const codexSearchCall2 = `{"type":"tool_search_call","call_id":"call_search_2","status":"completed","execution":"client","arguments":{"query":"javascript"}}`;
export const codexSearchOutput2 = `{"type":"tool_search_output","call_id":"call_search_2","status":"completed","execution":"client","tools":[{"type":"namespace","name":"mcp__node_repl__","description":"Node REPL.","tools":[{"type":"function","name":"js","description":"Run JavaScript.","strict":false,"defer_loading":true,"parameters":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]}}]}]}`;

export function codexToolSearchRequest(...items: string[]): string {
  return (
    `{"model":"claude-sonnet-4-5","instructions":"You are Codex.","input":[${items.join(",")}],"tools":[` +
    [codexExecCommandTool, codexToolSearchDeclaration, codexDeferredTool, codexDeferredNSTool].join(",") +
    `],"tool_choice":"auto","stream":true}`
  );
}
