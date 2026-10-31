// Ported from: internal/runtime/executor/helps/responses_tool_search_test.go
// Skipped cases: none (the unchanged-payload case checks string identity instead of slice aliasing)
import { describe, expect, test } from "bun:test";
import { responsesHasToolSearch, stripResponsesToolSearch } from "../../src/util/responses_tool_search.ts";

describe("responsesHasToolSearch", () => {
  const cases: { name: string; payload: string; want: boolean }[] = [
    { name: "top-level client declaration", payload: `{"tools":[{"type":"tool_search","execution":"client"}],"input":"hi"}`, want: true },
    {
      name: "additional_tools client declaration",
      payload: `{"input":[{"type":"additional_tools","tools":[{"type":"tool_search","execution":" client "}]}]}`,
      want: true,
    },
    { name: "tool_search_call history only", payload: `{"input":[{"type":"tool_search_call","call_id":"c1","execution":"client","arguments":{}}]}`, want: true },
    { name: "tool_search_output history only", payload: `{"input":[{"type":"tool_search_output","call_id":"c1","tools":[]}]}`, want: true },
    { name: "hosted declaration only", payload: `{"tools":[{"type":"tool_search"}],"input":"hi"}`, want: false },
    {
      name: "plain request",
      payload: `{"tools":[{"type":"function","name":"a"}],"input":[{"type":"message","role":"user","content":"hi"}]}`,
      want: false,
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(responsesHasToolSearch(tc.payload)).toBe(tc.want);
    });
  }
});

describe("stripResponsesToolSearch", () => {
  const cases: { name: string; payload: string; wantTools?: string; wantInput: string }[] = [
    {
      name: "client declaration removed",
      payload: `{"tools":[{"type":"function","name":"a"},{"type":"tool_search","execution":"client"}],"input":"hi"}`,
      wantTools: `[{"type":"function","name":"a"}]`,
      wantInput: `"hi"`,
    },
    {
      name: "only client declaration keeps empty tools",
      payload: `{"tools":[{"type":"tool_search","execution":"client"}],"input":"hi"}`,
      wantTools: `[]`,
      wantInput: `"hi"`,
    },
    {
      name: "hosted declaration kept",
      payload: `{"tools":[{"type":"tool_search","name":"ToolSearch"},{"type":"tool_search","execution":"client"}],"input":"hi"}`,
      wantTools: `[{"type":"tool_search","name":"ToolSearch"}]`,
      wantInput: `"hi"`,
    },
    {
      name: "input items and additional_tools cleaned",
      payload:
        `{"input":[` +
        `{"type":"additional_tools","tools":[{"type":"tool_search","execution":"client"},{"type":"function","name":"b"}]},` +
        `{"type":"message","role":"user","content":"hi"},` +
        `{"type":"tool_search_call","call_id":"c1","execution":"client","arguments":{"query":"x"}},` +
        `{"type":"tool_search_output","call_id":"c1","execution":"client","tools":[]}` +
        `]}`,
      wantInput: `[{"type":"additional_tools","tools":[{"type":"function","name":"b"}]},{"type":"message","role":"user","content":"hi"}]`,
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const got = JSON.parse(stripResponsesToolSearch(tc.payload)) as Record<string, unknown>;
      if (tc.wantTools !== undefined) expect(JSON.stringify(got.tools)).toBe(tc.wantTools);
      expect(JSON.stringify(got.input)).toBe(tc.wantInput);
    });
  }

  test("returns original when unchanged", () => {
    const payload = `{"tools":[{"type":"function","name":"a"},{"type":"tool_search"}],"input":[{"type":"message","role":"user","content":"hi"}]}`;
    expect(stripResponsesToolSearch(payload)).toBe(payload);
  });
});
