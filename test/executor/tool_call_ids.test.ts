// Ported from: internal/runtime/executor/helps/tool_call_ids_test.go
// Ported from: internal/runtime/executor/issue6478_tool_ids_test.go
// Ported from: internal/runtime/executor/issue6478_tool_ids_edges_test.go
// Skipped cases: every TestIssue6478_Devin* case (Devin dropped); TestIssue6478_ClaudeToolIDRepairPrecedesPayloadRules and
//   the configured half of TestIssue6478_ClaudeUpstreamCountTokensRepairBeforePayload (payload config rules not ported);
//   the allocation bound of TestIssue6478_NormalizeLargeHistoryAllocation and BenchmarkNormalizeClaudeToolCallIDs
//   (Go allocation counting; the 5211-call correctness half is kept).
// Adapted: TestIssue6478_NormalizePreservesNonIDBytes compares values, not bytes: the TS normaliser re-serialises the
//   JSON (every executor stage does), so whitespace is not preserved; every non-ID value must stay unchanged and the
//   escaped "Bash:1#abc" ID must map to the same cpa_tid_v1_ value as the plain one.
import { describe, expect, test } from "bun:test";
import { normalizeClaudeToolCallIDs } from "../../src/executor/claude/request.ts";
import { newAuth } from "../../src/auth/types.ts";
import { ClaudeExecutor } from "../../src/executor/claude/executor.ts";
import { claudeCapturingFetch, executeClaudeRequest } from "./claude_helpers.ts";

const portable = /^[a-zA-Z0-9_-]+$/;

const issue6478Calls = [
  { id: "Write:1#e1f0da81143649f3a378d24af6fc3ec9", name: "Write" },
  { id: "PowerShell:66#cd50350578c34275a26a09a477a81ffb", name: "PowerShell" },
  // A lossy replacement would collide with the first call's already legal ID.
  { id: "Write_1_e1f0da81143649f3a378d24af6fc3ec9", name: "Read" },
  { id: "call_8jAZYBK5veMdr1DD2DqObARK", name: "Bash" },
];

function issue6478History(ids: string[]): string {
  const uses: string[] = [];
  const results: string[] = [];
  const tools: string[] = [];
  issue6478Calls.forEach((call, i) => {
    uses.push(`{"type":"tool_use","id":${JSON.stringify(ids[i])},"name":${JSON.stringify(call.name)},"input":{"literal_id":${JSON.stringify(call.id)}}}`);
    results.push(`{"type":"tool_result","tool_use_id":${JSON.stringify(ids[i])},"content":${JSON.stringify("result for " + call.id)}}`);
    tools.push(`{"name":${JSON.stringify(call.name)},"input_schema":{"type":"object","properties":{"literal_id":{"type":"string"}}}}`);
  });
  return `{"model":"claude-opus-5","max_tokens":64,"tools":[${tools.join(",")}],"messages":[{"role":"user","content":"run tools"},{"role":"assistant","content":[${uses.join(",")}]},{"role":"user","content":[${results.join(",")}]}]}`;
}

function assertPortableIDs(ids: string[]): void {
  expect(ids.length).toBe(issue6478Calls.length);
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    expect(id).toMatch(portable);
    expect(seen.has(id)).toBe(false);
    seen.add(id);
    if (i >= 2) expect(id).toBe(issue6478Calls[i]!.id);
  });
}

interface Block {
  type?: string;
  id?: string;
  tool_use_id?: string;
  input?: { literal_id?: string };
  content?: unknown;
}

function blocks(body: string, index: number): Block[] {
  return (JSON.parse(body).messages[index].content as Block[]) ?? [];
}

describe("NormalizeClaudeToolCallIDs", () => {
  test("large legacy history (Go: TestIssue6478_NormalizeLargeHistoryAllocation, correctness half)", () => {
    const callCount = 5211;
    const uses: string[] = [];
    const results: string[] = [];
    const text = "x".repeat(512);
    for (let i = 0; i < callCount; i++) {
      uses.push(`{"type":"tool_use","id":"Bash:${i}#abc","name":"Bash","input":{}}`);
      results.push(`{"type":"tool_result","tool_use_id":"Bash:${i}#abc","content":"${text}"}`);
    }
    const body = `{"messages":[{"role":"assistant","content":[${uses.join(",")}]},{"role":"user","content":[${results.join(",")}]}]}`;
    const normalized = normalizeClaudeToolCallIDs(body);
    const u = blocks(normalized, 0);
    const r = blocks(normalized, 1);
    expect(u.length).toBe(callCount);
    expect(r.length).toBe(callCount);
    const seen = new Set<string>();
    for (let i = 0; i < callCount; i++) {
      const id = u[i]!.id!;
      expect(portable.test(id) && !seen.has(id) && r[i]!.tool_use_id === id).toBe(true);
      seen.add(id);
      expect(r[i]!.content).toBe(text);
    }
  });

  test("only ID values change (Go: TestIssue6478_NormalizePreservesNonIDBytes)", () => {
    const body = `{ "messages": [ { "role":"assistant", "content": [{"type":"text","text":"Bash:1#abc"}, {"type":"tool_use","id":"Bash\\u003a1\\u0023abc","name":"Bash","input":{"id":"Bash:1#abc"}}]}, {"role":"user","content":[{"type":"tool_result","tool_use_id":"Bash:1#abc","content":"Bash:1#abc"}]} ], "metadata": {"id":"Bash:1#abc"} }`;
    const want = `{ "messages": [ { "role":"assistant", "content": [{"type":"text","text":"Bash:1#abc"}, {"type":"tool_use","id":"cpa_tid_v1_QmFzaDoxI2FiYw","name":"Bash","input":{"id":"Bash:1#abc"}}]}, {"role":"user","content":[{"type":"tool_result","tool_use_id":"cpa_tid_v1_QmFzaDoxI2FiYw","content":"Bash:1#abc"}]} ], "metadata": {"id":"Bash:1#abc"} }`;
    expect(JSON.parse(normalizeClaudeToolCallIDs(body))).toEqual(JSON.parse(want));
  });

  test("already portable IDs are returned unchanged", () => {
    const body = issue6478History(["a", "b", "c", "d"]);
    expect(normalizeClaudeToolCallIDs(body)).toBe(body);
  });
});

describe("Claude executor repairs legacy tool IDs", () => {
  const legacyIDs = issue6478Calls.map((c) => c.id);

  test("TestIssue6478_ClaudeReplaysLegacyToolIDs", async () => {
    const byMode: string[][] = [];
    for (const stream of [false, true]) {
      const body = await executeClaudeRequest(issue6478History(legacyIDs), stream);
      const useIDs: string[] = [];
      const resultIDs: string[] = [];
      for (const message of JSON.parse(body).messages as Array<{ content: unknown }>) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content as Block[]) {
          if (block.type === "tool_use") {
            const i = useIDs.length;
            useIDs.push(block.id!);
            if (i < issue6478Calls.length) expect(block.input?.literal_id).toBe(issue6478Calls[i]!.id);
          } else if (block.type === "tool_result") {
            const i = resultIDs.length;
            resultIDs.push(block.tool_use_id!);
            expect(block.tool_use_id!).toMatch(portable);
            if (i < issue6478Calls.length) expect(block.content).toBe("result for " + issue6478Calls[i]!.id);
          }
        }
      }
      assertPortableIDs(useIDs);
      expect(resultIDs).toEqual(useIDs);
      byMode.push(useIDs);
    }
    expect(byMode[1]).toEqual(byMode[0]!);
  });

  test("TestIssue6478_ClaudeLegacyEncodingCollision", async () => {
    const ids = [issue6478Calls[0]!.id, issue6478Calls[1]!.id, "cpa_tid_v1_V3JpdGU6MSNlMWYwZGE4MTE0MzY0OWYzYTM3OGQyNGFmNmZjM2VjOQ", "call_8jAZYBK5veMdr1DD2DqObARK"];
    for (const stream of [false, true]) {
      const body = await executeClaudeRequest(issue6478History(ids), stream);
      const uses = blocks(body, 1).filter((b) => b.type === "tool_use");
      const results = blocks(body, 2).filter((b) => b.type === "tool_result");
      expect(uses.length).toBe(4);
      expect(results.length).toBe(4);
      const seen = new Set<string>();
      uses.forEach((use, i) => {
        expect(use.id!).toMatch(portable);
        expect(seen.has(use.id!)).toBe(false);
        seen.add(use.id!);
        expect(results[i]!.tool_use_id).toBe(use.id);
        if (i >= 2) expect(use.id).toBe(ids[i]);
      });
      // Repairing a repaired transcript must be stable at schema ID fields.
      const again = await executeClaudeRequest(body, stream);
      expect(blocks(again, 1).filter((b) => b.type === "tool_use").map((b) => b.id)).toEqual(uses.map((b) => b.id));
    }
  });

  test("TestIssue6478_ClaudeUpstreamCountTokensRepairBeforePayload (unconfigured half)", async () => {
    const f = claudeCapturingFetch(false, true);
    const exec = new ClaudeExecutor({ fetch: f.fetch as never });
    const auth = newAuth({ id: "c", provider: "claude", attributes: { api_key: "test" } });
    await exec.countTokens(auth, { model: "claude-opus-5", payload: issue6478History(legacyIDs), format: "claude" }, { stream: false, sourceFormat: "claude" });
    expect(f.requests.length).toBe(1);
    const sent = f.requests[0]!;
    const url = new URL(sent.url);
    expect(url.host).toBe("api.anthropic.com");
    expect(url.pathname).toBe("/v1/messages/count_tokens");
    const useIDs = blocks(sent.body, 1).map((b) => b.id!);
    const resultIDs = blocks(sent.body, 2).map((b) => b.tool_use_id!);
    expect(useIDs.length).toBe(4);
    expect(resultIDs.length).toBe(4);
    useIDs.forEach((id, i) => {
      expect(id).toMatch(portable);
      expect(resultIDs[i]).toBe(id);
      if (i >= 2) expect(id).toBe(legacyIDs[i]!);
    });
  });
});
