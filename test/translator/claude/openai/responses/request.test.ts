// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_request_test.go
// Skipped cases: none (byte-exact golden strings are compared as parsed JSON)
import { describe, expect, test } from "bun:test";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import {
  claudeMessageInvariantProblems,
  claudeResponsesRedactedThinkingPrefix,
  qualifyResponsesNamespaceToolName,
  responsesCustomToolNames,
  splitResponsesQualifiedFunctionCallFromRequest,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import {
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
  convertOpenAIResponsesRequestToClaudeResult,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import {
  type JSONObject,
  convertRequest,
  parseSSEEvent,
  testClaudeThinkingSignatureForModel,
  testGPTReasoningSignature,
  useClientToolSearchDefault,
} from "./helpers.ts";

useClientToolSearchDefault();

const conv = (model: string, raw: string, stream = false): JSONObject => JSON.parse(convertRequest(model, raw, stream));
const types = (content: JSONObject[]): string[] => content.map((b) => b.type);
const sig = (): [string, string] => testClaudeThinkingSignatureForModel();

test("sanitizes tool call ids for Claude", () => {
  const out = conv(
    "claude-sonnet-4-5",
    `{"model":"gpt-4.1","input":[{"type":"function_call","call_id":"call.with space:1","name":"Read","arguments":"{\\"path\\":\\"README.md\\"}"},{"type":"function_call_output","call_id":"call.with space:1","output":"ok"}]}`,
  );
  expect(out.messages[0].content[0].id).toBe("call_with_space_1");
  expect(out.messages[1].content[0].tool_use_id).toBe("call_with_space_1");
});

describe("fable max tokens", () => {
  test("defaults to 64k", () => expect(conv("claude-fable-5-1", `{"model":"claude-fable-5-1","input":"hello"}`, true).max_tokens).toBe(64000));
  test("preserves explicit 128k limit", () =>
    expect(conv("claude-fable-5-1", `{"model":"claude-fable-5-1","max_output_tokens":128000,"input":"hello"}`, true).max_tokens).toBe(128000));
  test("does not exceed registered model maximum", () =>
    expect(conv("claude-3-5-haiku-20241022", `{"model":"claude-3-5-haiku-20241022","input":"hello"}`, true).max_tokens).toBe(8192));
  test("clamps explicit limit exceeding registered model maximum", () =>
    expect(conv("claude-3-5-haiku-20241022", `{"model":"claude-3-5-haiku-20241022","max_output_tokens":128000,"input":"hello"}`, true).max_tokens).toBe(8192));
  test("null max_output_tokens retains default 64k", () =>
    expect(conv("claude-fable-5-1", `{"model":"claude-fable-5-1","max_output_tokens":null,"input":"hello"}`, true).max_tokens).toBe(64000));
});

describe("omitted max_output_tokens uses registry limit", () => {
  const cases: [string, string, string, number][] = [
    ["opus 5.5 omitted field uses 128k registry limit", "claude-opus-5-5", `{"model":"claude-opus-5-5","input":"hello"}`, 128000],
    ["opus 5.5 null field uses 128k registry limit", "claude-opus-5-5", `{"model":"claude-opus-5-5","max_output_tokens":null,"input":"hello"}`, 128000],
    ["sonnet 4.6 omitted field uses 64k registry limit", "claude-sonnet-4-6", `{"model":"claude-sonnet-4-6","input":"hello"}`, 64000],
  ];
  for (const [name, model, raw, want] of cases) test(name, () => expect(conv(model, raw).max_tokens).toBe(want));
});

const userContinue = `{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}`;
const assistantVisible = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"visible answer"}]}`;

test("reasoning item to thinking block", () => {
  const [rawSig, expected] = sig();
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${rawSig}","summary":[{"type":"summary_text","text":"internal reasoning"}]},${assistantVisible},${userContinue}]}`,
  );
  const assistant = out.messages[0];
  expect(assistant.role).toBe("assistant");
  expect(assistant.content[0].type).toBe("thinking");
  expect(assistant.content[0].signature).toBe(expected);
  expect(assistant.content[0].thinking).toBe("internal reasoning");
  expect(assistant.content[1].type).toBe("text");
  expect(assistant.content[1].text).toBe("visible answer");
  expect(out.messages[1].role).toBe("user");
});

test("signature-only reasoning flushes before user", () => {
  const [rawSig, expected] = sig();
  const out = conv("claude-test", `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${rawSig}","summary":[]},${userContinue}]}`);
  const thinking = out.messages[0].content[0];
  expect(thinking.type).toBe("thinking");
  expect(thinking.signature).toBe(expected);
  expect(thinking.thinking).toBe("");
  expect(out.messages[1].role).toBe("user");
});

test("redacted reasoning item restores redacted_thinking", () => {
  const data = "EroBCkYIBRgCKkA";
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${claudeResponsesRedactedThinkingPrefix}${data}","summary":[]},${assistantVisible},${userContinue}]}`,
  );
  const block = out.messages[0].content[0];
  expect(block.type).toBe("redacted_thinking");
  expect(block.data).toBe(data);
  expect(block.signature).toBeUndefined();
  expect(out.messages[0].content[1].text).toBe("visible answer");
});

test("empty redacted reasoning item is dropped", () => {
  const out = conv("claude-test", `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${claudeResponsesRedactedThinkingPrefix}","summary":[]},${userContinue}]}`);
  expect(out.messages.length).toBe(1);
  expect(out.messages[0].role).toBe("user");
});

test("reasoning content text rebuilds thinking", () => {
  const [rawSig, expected] = sig();
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${rawSig}","summary":[],"content":[{"type":"reasoning_text","text":"restored from content"}]},${userContinue}]}`,
  );
  expect(out.messages[0].content[0].thinking).toBe("restored from content");
  expect(out.messages[0].content[0].signature).toBe(expected);
});

describe("summary sets thinking display", () => {
  const cases: [string, string, string | undefined][] = [
    ["auto", `"summary":"auto"`, "summarized"],
    ["concise", `"summary":"concise"`, "summarized"],
    ["none", `"summary":"none"`, "omitted"],
    ["absent", "", undefined],
  ];
  for (const [name, summary, want] of cases) {
    test(name, () => {
      let reasoning = `"effort":"high"`;
      if (summary !== "") reasoning += "," + summary;
      expect(conv("claude-opus-5-5", `{"model":"claude-opus-5-5","reasoning":{${reasoning}},"input":"hi"}`).thinking?.display).toBe(want);
    });
  }
});

test("summary wins over duplicated reasoning content", () => {
  const [rawSig] = sig();
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${rawSig}","summary":[{"type":"summary_text","text":"chain of thought"}],"content":[{"type":"reasoning_text","text":"chain of thought"}]},${userContinue}]}`,
  );
  expect(out.messages[0].content[0].thinking).toBe("chain of thought");
});

test("drops incompatible reasoning signature", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${testGPTReasoningSignature()}","summary":[{"type":"summary_text","text":"must not become Claude thinking"}]},${userContinue}]}`,
  );
  const first = Array.isArray(out.messages[0].content) ? out.messages[0].content[0] : {};
  expect(first.type).not.toBe("thinking");
  expect(first.signature).toBeUndefined();
  expect(out.messages[0].role).toBe("user");
});

test("groups assistant and tool result turns", () => {
  const [rawSig, expected] = sig();
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"reasoning","encrypted_content":"${rawSig}","summary":[{"type":"summary_text","text":"internal reasoning"}]},${assistantVisible},` +
      `{"type":"function_call","call_id":"call_first","name":"read_file","arguments":"{\\"path\\":\\"first\\"}"},` +
      `{"type":"function_call","call_id":"call_second","name":"read_file","arguments":"{\\"path\\":\\"second\\"}"},` +
      `{"type":"function_call_output","call_id":"call_first","output":"first result"},{"type":"function_call_output","call_id":"call_second","output":"second result"}]}`,
  );
  expect(out.messages.length).toBe(2);
  const assistant = out.messages[0];
  expect(assistant.role).toBe("assistant");
  expect(types(assistant.content)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
  expect(assistant.content[0].signature).toBe(expected);
  expect(assistant.content[2].id).toBe("call_first");
  expect(assistant.content[3].id).toBe("call_second");
  const user = out.messages[1];
  expect(user.role).toBe("user");
  expect(user.content.map((b: JSONObject) => [b.type, b.tool_use_id])).toEqual([
    ["tool_result", "call_first"],
    ["tool_result", "call_second"],
  ]);
});

test("merges consecutive user messages and preserves cache_control", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"user","cache_control":{"type":"ephemeral"},"content":[{"type":"input_text","text":"first"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"second"}]}]}`,
  );
  expect(out.messages.length).toBe(1);
  const content = out.messages[0].content;
  expect(content.length).toBe(2);
  expect(content[0].text).toBe("first");
  expect(content[0].cache_control.type).toBe("ephemeral");
  expect(content[1].text).toBe("second");
  expect(content[1].cache_control).toBeUndefined();
});

test("does not merge across role changes", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first assistant"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"user reply"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"second assistant"}]}]}`,
  );
  expect(out.messages.map((m: JSONObject) => m.role)).toEqual(["assistant", "user", "assistant"]);
});

test("empty string content does not break assistant turn", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"assistant","content":"first assistant"},{"type":"message","role":"user","content":""},{"type":"message","role":"assistant","content":"second assistant"}]}`,
  );
  expect(out.messages.length).toBe(1);
  expect(out.messages[0].role).toBe("assistant");
  expect(out.messages[0].content.map((b: JSONObject) => [b.type, b.text])).toEqual([
    ["text", "first assistant"],
    ["text", "second assistant"],
  ]);
});

test("function_call_output preserves input_image", () => {
  const imageB64 = "iVBORw0KGgo=";
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"function_call","call_id":"call_view_image_1","name":"view_image","arguments":"{}"},{"type":"function_call_output","call_id":"call_view_image_1","output":[{"type":"input_image","image_url":"data:image/png;base64,${imageB64}","detail":"high"}]}]}`,
  );
  const toolResult = out.messages[1].content[0];
  expect(toolResult.type).toBe("tool_result");
  expect(toolResult.content[0].type).toBe("image");
  expect(toolResult.content[0].source.media_type).toBe("image/png");
  expect(toolResult.content[0].source.data).toBe(imageB64);
  expect(JSON.stringify(toolResult.content)).not.toContain("data:image");
});

test("standalone tool output becomes user text", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"function_call_output","call_id":"toolu_1789312108939888000_16","output":"<codex_delegation>Launched from another task.</codex_delegation>"},{"type":"message","role":"user","content":[{"type":"input_text","text":"Reply with PROBE_OK."}]}]}`,
  );
  for (const msg of out.messages) for (const block of Array.isArray(msg.content) ? msg.content : []) expect(block.type).not.toBe("tool_result");
  expect(out.messages[0].role).toBe("user");
  expect(out.messages[0].content[0].type).toBe("text");
  expect(out.messages[0].content[0].text).toBe("<codex_delegation>Launched from another task.</codex_delegation>");
});

test("synthesizes result for dangling tool_use", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Run the tests."}]},{"type":"function_call","call_id":"call_1","name":"shell","arguments":"{\\"cmd\\":\\"npm test\\"}"},{"type":"message","role":"user","content":[{"type":"input_text","text":"Session was restarted; carry on."}]}]}`,
  );
  expect(out.messages.length).toBe(3);
  expect(out.messages[1].content[0].type).toBe("tool_use");
  expect(out.messages[2].content[0].type).toBe("tool_result");
  expect(out.messages[2].content[0].tool_use_id).toBe("call_1");
  expect(out.messages[2].content[0].is_error).toBe(true);
  expect(out.messages[2].content[1].text).toBe("Session was restarted; carry on.");
});

test("synthesizes result for trailing tool_use", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Run ls."}]},{"type":"function_call","call_id":"call_tail","name":"exec","arguments":"{}"}]}`,
  );
  expect(out.messages.length).toBe(3);
  expect(out.messages[2].role).toBe("user");
  expect(out.messages[2].content[0].type).toBe("tool_result");
  expect(out.messages[2].content[0].tool_use_id).toBe("call_tail");
});

test("moves tool results ahead of injected text", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Run ls."}]},{"type":"function_call","call_id":"call_hb","name":"exec","arguments":"{}"},{"type":"function_call_output","id":"fco_seed","name":"automation_update","namespace":"codex_app","output":"<heartbeat>tick</heartbeat>"},{"type":"function_call_output","call_id":"call_hb","output":"a.txt"},{"type":"message","role":"user","content":[{"type":"input_text","text":"Continue."}]}]}`,
  );
  expect(out.messages.length).toBe(3);
  const blocks = out.messages[2].content;
  expect(blocks.length).toBe(3);
  expect([blocks[0].type, blocks[0].tool_use_id, blocks[0].content]).toEqual(["tool_result", "call_hb", "a.txt"]);
  expect(blocks[1].text).toBe("<heartbeat>tick</heartbeat>");
  expect(blocks[2].text).toBe("Continue.");
});

test("synthesizes result for trailing tool_use on prefill-rejecting model", () => {
  const out = conv(
    "claude-fable-5-1",
    `{"model":"claude-fable-5-1","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Run ls."}]},{"type":"function_call","call_id":"call_tail","name":"exec","arguments":"{}"}]}`,
  );
  expect(out.messages.length).toBe(3);
  expect(out.messages[1].content[0].type).toBe("tool_use");
  expect(out.messages[2].role).toBe("user");
  expect(out.messages[2].content[0].type).toBe("tool_result");
  expect(out.messages[2].content[0].tool_use_id).toBe("call_tail");
});

test("late orphan tool_result folds to text", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Run ls."}]},{"type":"function_call","call_id":"call_a","name":"exec","arguments":"{}"},{"type":"message","role":"user","content":[{"type":"input_text","text":"wait"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"interlude"}]},{"type":"function_call_output","call_id":"call_a","output":"a.txt"}]}`,
  );
  expect(out.messages.length).toBe(5);
  expect(out.messages[2].content[0].type).toBe("tool_result");
  expect(out.messages[2].content[0].tool_use_id).toBe("call_a");
  expect(out.messages[2].content[0].is_error).toBe(true);
  const last = out.messages[4];
  expect(last.role).toBe("user");
  for (const block of last.content) expect(block.type).not.toBe("tool_result");
  expect(last.content[0].text).toBe("a.txt");
});

test("empty standalone tool output keeps marker", () => {
  for (const output of [`""`, `[{"type":"input_text","text":""}]`]) {
    const out = conv("claude-test", `{"model":"claude-test","input":[{"type":"function_call_output","call_id":"orphan","output":${output}}]}`);
    expect(out.messages.length).toBe(1);
    const content = out.messages[0].content;
    if (Array.isArray(content)) {
      expect(content.length).toBeGreaterThan(0);
      expect(content[0].type).toBe("text");
      expect(content[0].text.trim()).not.toBe("");
    } else {
      expect(content.trim()).not.toBe("");
    }
  }
});

const toolNamed = (out: JSONObject, name: string): JSONObject | undefined => (out.tools ?? []).find((t: JSONObject) => t.name === name);
const nonEmptyTextEverywhere = (out: JSONObject): void => {
  for (const msg of out.messages) {
    if (Array.isArray(msg.content)) expect(msg.content.length).toBeGreaterThan(0);
    for (const block of Array.isArray(msg.content) ? msg.content : []) if (block.type === "text") expect(block.text.trim()).not.toBe("");
  }
};

test("sanitized id collision keeps orphan as text", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Run."}]},{"type":"function_call","call_id":"call.custom:1","name":"exec","arguments":"{}"},{"type":"function_call_output","call_id":"call_custom_1","output":"unrelated context"},{"type":"function_call_output","call_id":"call.custom:1","output":"real result"}]}`,
  );
  const blocks = out.messages[2].content;
  expect(blocks.length).toBe(2);
  expect([blocks[0].type, blocks[0].content]).toEqual(["tool_result", "real result"]);
  expect([blocks[1].type, blocks[1].text]).toEqual(["text", "unrelated context"]);
});

const lateOrphan = (callID: string, output: string): string =>
  `{"model":"claude-fable-5-1","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Run the tool."}]},{"type":"function_call","call_id":"${callID}","name":"exec","arguments":"{}"},{"type":"message","role":"user","content":[{"type":"input_text","text":"Wait."}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Interlude."}]},{"type":"function_call_output","call_id":"${callID}","output":${output}}]}`;

test("empty late orphan tool_result keeps non-empty user message", () => {
  const out = conv("claude-fable-5-1", lateOrphan("call_a", `""`));
  nonEmptyTextEverywhere(out);
  for (const msg of out.messages) {
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block.type === "tool_result" && block.tool_use_id === "call_a") expect(block.is_error).toBe(true);
    }
  }
  expect(out.messages[4].role).toBe("user");
  expect(out.messages[4].content[0].text).toBe("Tool result was empty.");
});

test("late orphan tool_result array of empty text keeps marker", () => {
  const out = conv("claude-fable-5-1", lateOrphan("a", `[{"type":"input_text","text":""},{"type":"input_text","text":""}]`));
  nonEmptyTextEverywhere(out);
  for (const msg of out.messages) {
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block.type === "tool_result" && block.tool_use_id === "a") expect(block.is_error).toBe(true);
    }
  }
  expect(out.messages[4].content[0].text).toBe("Tool result was empty.");
});

test("standalone tool output drops empty text in mixed array", () => {
  const out = conv("claude-test", `{"model":"claude-test","input":[{"type":"function_call_output","call_id":"orphan","output":[{"type":"input_text","text":""},{"type":"input_text","text":"context"}]}]}`);
  nonEmptyTextEverywhere(out);
  expect(out.messages[0].content).toBe("context");
});

test("claudeMessageInvariantProblems", () => {
  const msg = (raw: string): JSONObject => JSON.parse(raw);
  const clean = [
    msg(`{"role":"user","content":"hi"}`),
    msg(`{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"exec","input":{}}]}`),
    msg(`{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"},{"type":"text","text":"go on"}]}`),
  ];
  expect(claudeMessageInvariantProblems(clean)).toEqual([]);
  const broken = [
    msg(`{"role":"user","content":[{"type":"tool_result","tool_use_id":"t0","content":"orphan"}]}`),
    msg(`{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"exec","input":{}}]}`),
    msg(`{"role":"user","content":[{"type":"text","text":"x"},{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}`),
  ];
  const got = claudeMessageInvariantProblems(broken);
  for (const fragment of ["tool_result t0 has no tool_use", "tool_result after non-tool_result block", "tool_use t1 has no tool_result", "tool_result t2 has no tool_use"]) {
    expect(got.some((p) => p.includes(fragment))).toBe(true);
  }
  const firstNotUser = claudeMessageInvariantProblems([msg(`{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"exec","input":{}}]}`)]);
  expect(firstNotUser[0]).toContain("first message is not user");
});

test("keeps tool_use adjacent to tool_result", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"function_call","call_id":"call_00_awGuheXs4aRbtedNK8LE3743","name":"js","arguments":"{\\"code\\":\\"nodeRepl.write('ok')\\",\\"title\\":\\"List Obsidian vault contents\\"}"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I'll check your Obsidian vault for articles."}]},{"type":"function_call_output","call_id":"call_00_awGuheXs4aRbtedNK8LE3743","output":"Wall time: 0.1963 seconds\\nOutput:\\n[{\\"type\\":\\"text\\",\\"text\\":\\"\\"}]"}]}`,
  );
  expect(out.messages.length).toBe(2);
  expect(out.messages[0].role).toBe("assistant");
  expect(out.messages[0].content[0].text).toBe("I'll check your Obsidian vault for articles.");
  expect(out.messages[0].content[1].type).toBe("tool_use");
  expect(out.messages[0].content[1].id).toBe("call_00_awGuheXs4aRbtedNK8LE3743");
  expect(out.messages[1].content[0].type).toBe("tool_result");
  expect(out.messages[1].content[0].tool_use_id).toBe("call_00_awGuheXs4aRbtedNK8LE3743");
});

test("keeps apply_patch custom tool", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],"tools":[{"type":"custom","name":"apply_patch","description":"Use the apply_patch tool to edit files.","format":{"type":"grammar","syntax":"lark","definition":"start: patch"}},{"type":"function","name":"exec_command","description":"Runs a command.","parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}]}`,
  );
  expect(out.tools.length).toBe(2);
  const tool = toolNamed(out, "apply_patch")!;
  for (const instruction of ["*** Begin Patch", "*** End Patch", "*** Add File:", "*** Delete File:", "*** Update File:", "*** Move to:", "*** End of File", "@@", "start: patch", "JSON object"]) {
    expect(tool.description).toContain(instruction);
  }
  expect(tool.input_schema.additionalProperties).toBe(false);
  expect(tool.input_schema.required[0]).toBe("input");
});

test("normalizes root tool schema union", () => {
  const schema = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],"tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"query":{"type":"string"},"id":{"type":"string"}},"oneOf":[{"required":["query"]},{"required":["id"]}]}}]}`,
  ).tools[0].input_schema;
  expect(schema.type).toBe("object");
  expect(schema.oneOf).toBeUndefined();
  expect(schema.properties.query).toBeDefined();
  expect(schema.properties.id).toBeDefined();
  expect(schema.required).toBeUndefined();
});

test("merges additional_tools and prefers top-level", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","tools":[{"type":"function","name":"exec","description":"top-level exec","parameters":{"type":"object","properties":{"command":{"type":"string"}}}},{"type":"namespace","name":"collaboration","tools":[{"type":"function","name":"spawn","description":"top-level spawn","parameters":{"type":"object","properties":{}}}]}],"input":[{"type":"additional_tools","role":"developer","tools":[{"type":"custom","name":"exec","description":"additional exec"},{"type":"function","name":"wait","parameters":{"type":"object","properties":{}}},{"type":"namespace","name":"collaboration","tools":[{"type":"function","name":"spawn","parameters":{"type":"object","properties":{}}},{"type":"custom","name":"send","description":"send a message"}]}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}`,
  );
  expect(out.tools.length).toBe(4);
  expect(toolNamed(out, "exec")!.description).toBe("top-level exec");
  expect(toolNamed(out, "wait")).toBeDefined();
  expect(toolNamed(out, "collaboration__spawn")).toBeDefined();
  expect(toolNamed(out, "collaboration__send")!.input_schema.properties.input.type).toBe("string");
});

test("deduplicates expanded tool names", () => {
  const raw = `{"model":"claude-test","tools":[{"type":"function","name":"collaboration__send","description":"top-level send","parameters":{"type":"object","properties":{}}}],"input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"collaboration","tools":[{"type":"function","name":"send","description":"additional send","parameters":{"type":"object","properties":{}}},{"type":"function","name":"other","parameters":{"type":"object","properties":{}}}]}]}]}`;
  const out = conv("claude-test", raw);
  expect(out.tools.length).toBe(2);
  expect(toolNamed(out, "collaboration__send")!.description).toBe("top-level send");
  expect(toolNamed(out, "collaboration__other")).toBeDefined();
  expect(responsesCustomToolNames(raw).has("collaboration__send")).toBe(false);
  expect(splitResponsesQualifiedFunctionCallFromRequest(JSON.parse(raw), "collaboration__send", true)).toEqual({ name: "collaboration__send", namespace: "" });
});

test("direct tool wins over earlier namespace collision", () => {
  const raw = `{"model":"claude-test","tools":[{"type":"namespace","name":"n","tools":[{"type":"function","name":"x","parameters":{"type":"object","properties":{}}}]},{"type":"custom","name":"n__x"}],"tool_choice":{"type":"custom","name":"n__x"}}`;
  const out = conv("claude-test", raw);
  expect(out.tools.length).toBe(1);
  expect(out.tools[0].name).toBe("n__x");
  expect(out.tools[0].input_schema.properties.input.type).toBe("string");
  expect(out.tool_choice.name).toBe("n__x");
  expect(responsesCustomToolNames(raw).has("n__x")).toBe(true);
});

test("prefers direct tool across additional sources", () => {
  const raw = `{"model":"claude-test","input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"n","tools":[{"type":"function","name":"x","description":"namespace x","parameters":{"type":"object","properties":{}}}]}]},{"type":"additional_tools","tools":[{"type":"custom","name":"n__x","description":"direct x"}]}]}`;
  const out = conv("claude-test", raw);
  expect(out.tools.length).toBe(1);
  expect([out.tools[0].name, out.tools[0].description, out.tools[0].input_schema.properties.input.type]).toEqual(["n__x", "direct x", "string"]);
  expect(responsesCustomToolNames(raw).has("n__x")).toBe(true);
});

test("preserves tool declaration order", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","tools":[{"type":"function","name":"first","parameters":{"type":"object","properties":{}}},{"type":"namespace","name":"n","tools":[{"type":"function","name":"middle","parameters":{"type":"object","properties":{}}}]},{"type":"function","name":"last","parameters":{"type":"object","properties":{}}}]}`,
  );
  expect(out.tools.map((t: JSONObject) => t.name)).toEqual(["first", "n__middle", "last"]);
});

test("replays custom_tool_call history", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"custom_tool_call","call_id":"call.custom:1","name":"exec","input":"pwd"},{"type":"custom_tool_call_output","call_id":"call.custom:1","output":"/workspace"}]}`,
  );
  const toolUse = out.messages[0].content[0];
  expect([toolUse.type, toolUse.id, toolUse.input.input]).toEqual(["tool_use", "call_custom_1", "pwd"]);
  const toolResult = out.messages[1].content[0];
  expect([toolResult.type, toolResult.tool_use_id, toolResult.content]).toEqual(["tool_result", "call_custom_1", "/workspace"]);
});

test("replays namespaced function_call history", () => {
  const out = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"mcp__node_repl","tools":[{"type":"function","name":"js","parameters":{"type":"object","properties":{}}}]}]},{"type":"function_call","call_id":"call.namespace","name":"js","namespace":"mcp__node_repl","arguments":"{\\"code\\":\\"pwd\\"}"},{"type":"function_call_output","call_id":"call.namespace","output":"ok"}]}`,
  );
  expect(toolNamed(out, "mcp__node_repl__js")).toBeDefined();
  expect(out.messages[0].content[0].name).toBe("mcp__node_repl__js");
  expect(out.messages[1].content[0].tool_use_id).toBe("call_namespace");
});

describe("maps custom and namespaced tool_choice", () => {
  const cases: [string, string, string][] = [
    ["custom", `{"model":"claude-test","tools":[{"type":"custom","name":"exec"}],"tool_choice":{"type":"custom","name":"exec"}}`, "exec"],
    [
      "namespace",
      `{"model":"claude-test","input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"mcp__node_repl","tools":[{"type":"function","name":"js"}]}]}],"tool_choice":{"type":"function","name":"js","namespace":"mcp__node_repl"}}`,
      "mcp__node_repl__js",
    ],
    [
      "top-level-short-name-wins",
      `{"model":"claude-test","tools":[{"type":"function","name":"foo"}],"input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"mcp__tools","tools":[{"type":"function","name":"foo"}]}]}],"tool_choice":{"type":"function","name":"foo"}}`,
      "foo",
    ],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => {
      const out = conv("claude-test", raw);
      expect(out.tool_choice.type).toBe("tool");
      expect(out.tool_choice.name).toBe(want);
    });
  }
});

test("qualifyResponsesNamespaceToolName avoids prefix collision", () => {
  for (const [namespace, child, want] of [
    ["collab", "collaboration", "collab__collaboration"],
    ["collab", "collab__send", "collab__send"],
    ["collab__", "send", "collab__send"],
    ["mcp__node_repl", "mcp__node_repl__js", "mcp__node_repl__js"],
  ]) {
    expect(qualifyResponsesNamespaceToolName(namespace!, child!)).toBe(want!);
  }
  expect(conv("claude-test", `{"tools":[{"type":"namespace","name":"collab","tools":[{"type":"function","name":"collaboration"}]}]}`).tools[0].name).toBe("collab__collaboration");
});

test("split qualified function call from additional_tools", () => {
  const raw = { input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js" }] }] }] };
  expect(splitResponsesQualifiedFunctionCallFromRequest(raw, "mcp__node_repl__js", true)).toEqual({ name: "js", namespace: "mcp__node_repl" });
});

test("preserves content part cache_control", () => {
  const content = conv(
    "claude-sonnet-4-5",
    `{"model":"gpt-4.1","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"cached prefix","cache_control":{"type":"ephemeral"}},{"type":"input_text","text":"fresh question"}]}]}`,
  ).messages[0].content;
  expect(Array.isArray(content)).toBe(true);
  expect(content[0].cache_control.type).toBe("ephemeral");
  expect(content[1].cache_control).toBeUndefined();
});

test("system-level inputs become separate system blocks", () => {
  const root = conv(
    "claude-sonnet-4-5",
    `{"model":"gpt-4.1","instructions":"I1","input":[{"type":"message","role":"system","content":[{"type":"input_text","text":"S1"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"U1"}]},{"type":"message","role":"developer","content":"D1"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"A1"}]},{"type":"message","role":"system","content":[{"type":"input_text","text":"S2"}]}]}`,
  );
  expect(root.system.map((b: JSONObject) => [b.type, b.text])).toEqual([
    ["text", "I1"],
    ["text", "S1"],
    ["text", "D1"],
    ["text", "S2"],
  ]);
  expect(root.messages.map((m: JSONObject) => m.role)).toEqual(["user", "assistant"]);
  const raw = JSON.stringify(root.messages);
  for (const s of ["I1", "S1", "D1", `"role":"system"`]) expect(raw).not.toContain(s);
});

test("system-only input keeps fallback user message", () => {
  const root = conv("claude-opus-5", `{"model": "gpt-4.1", "instructions": "I1"}`);
  expect(root.system.length).toBe(1);
  expect(root.messages.length).toBe(1);
  expect(root.messages[0].role).toBe("user");
});

test("system non-text part kept as typed marker", () => {
  const system = conv(
    "claude-opus-5",
    `{"model":"gpt-4.1","input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"D1"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"U1"}]}]}`,
  ).system;
  expect(system.length).toBe(2);
  expect(system[0].text).toBe("D1");
  expect(system[1].type).toBe("input_image");
  expect(system[1].source).toBeUndefined();
});

test("system item cache_control applies to last block", () => {
  const system = conv(
    "claude-opus-5",
    `{"model":"gpt-4.1","input":[{"type":"message","role":"system","cache_control":{"type":"ephemeral"},"content":[{"type":"input_text","text":"S1"},{"type":"input_text","text":"S2"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"U1"}]}]}`,
  ).system;
  expect(system.length).toBe(2);
  expect(system[0].cache_control).toBeUndefined();
  expect(system[1].cache_control.type).toBe("ephemeral");
});

test("deduplicates tool outputs", () => {
  const messages = conv(
    "claude-test",
    `{"model":"claude-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Use lookup."}]},{"type":"function_call","call_id":"toolu_dup","name":"lookup","arguments":"{}"},{"type":"function_call_output","call_id":"toolu_dup","output":"first result"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Intermediate step"}]},{"type":"function_call","call_id":"toolu_parallel","name":"other","arguments":"{}"},{"type":"function_call_output","call_id":"toolu_dup","output":"final result"},{"type":"custom_tool_call_output","call_id":"call.custom:dup","output":"custom first"},{"type":"custom_tool_call_output","call_id":"call.custom:dup","output":"custom final"},{"type":"function_call_output","call_id":"toolu_parallel","output":"parallel result"},{"type":"function_call_output","call_id":"","output":"empty id output"}]}`,
  ).messages;
  expect(messages.length).toBeGreaterThanOrEqual(5);
  expect(messages[0].role).toBe("user");
  expect([messages[1].content[0].type, messages[1].content[0].id]).toEqual(["tool_use", "toolu_dup"]);
  expect(messages[2].role).toBe("user");
  expect([messages[2].content[0].type, messages[2].content[0].tool_use_id, messages[2].content[0].content]).toEqual(["tool_result", "toolu_dup", "final result"]);
  expect(messages[3].role).toBe("assistant");
  expect(messages[3].content[0].text).toBe("Intermediate step");
  expect(messages[3].content[1].id).toBe("toolu_parallel");
  const blocks = messages[4].content;
  expect(blocks.length).toBe(3);
  expect([blocks[0].tool_use_id, blocks[0].content]).toEqual(["toolu_parallel", "parallel result"]);
  expect([blocks[1].type, blocks[1].text]).toEqual(["text", "custom final"]);
  expect([blocks[2].type, blocks[2].text]).toEqual(["text", "empty id output"]);
});

describe("service_tier to speed", () => {
  const cases: [string, string | undefined, string, string | undefined][] = [
    ["absent service_tier omits speed", undefined, "", undefined],
    ["default service_tier omits speed", "default", "", undefined],
    ["standard service_tier omits speed", "standard", "", undefined],
    ["unsupported service_tier omits speed", "flex", "", undefined],
    ["priority service_tier emits fast speed", "priority", "", "fast"],
    ["priority with low reasoning effort", "priority", "low", "fast"],
    ["priority with medium reasoning effort", "priority", "medium", "fast"],
    ["priority with high reasoning effort", "priority", "high", "fast"],
    ["priority with xhigh reasoning effort", "priority", "xhigh", "fast"],
    ["priority with max reasoning effort", "priority", "max", "fast"],
  ];
  for (const [name, tier, effort, want] of cases) {
    test(name, () => {
      let raw = `{"model":"claude-3-7-sonnet-20250219","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]`;
      if (tier !== undefined) raw += `,"service_tier":${JSON.stringify(tier)}`;
      if (effort !== "") raw += `,"reasoning":{"effort":${JSON.stringify(effort)}}`;
      raw += "}";
      expect(conv("claude-3-7-sonnet-20250219", raw).speed).toBe(want);
    });
  }
});

const convCompat = (model: string, raw: string): JSONObject => JSON.parse(convertOpenAIResponsesRequestToClaudeResult(model, raw, false, true, true).body);
const userHello = `{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}`;

describe("preserves caller supplied metadata.user_id", () => {
  const cases: [string, string, string][] = [
    ["plain string", `{"model":"claude-test","metadata":{"user_id":"custom-resp-user-123"},"input":[${userHello}]}`, "custom-resp-user-123"],
    ["special characters and json string", `{"model":"claude-test","metadata":{"user_id":"foo\\"bar\\nbaz\\\\qux"},"input":[${userHello}]}`, 'foo"bar\nbaz\\qux'],
    [
      "claude code json format",
      `{"model":"claude-test","metadata":{"user_id":"{\\"device_id\\":\\"0000000000000000000000000000000000000000000000000000000000000000\\",\\"session_id\\":\\"11111111-2222-4333-8444-555555555555\\"}"},"input":[${userHello}]}`,
      `{"device_id":"0000000000000000000000000000000000000000000000000000000000000000","session_id":"11111111-2222-4333-8444-555555555555"}`,
    ],
  ];
  for (const [name, raw, want] of cases) test(name, () => expect(conv("claude-test", raw).metadata.user_id).toBe(want));
});

test("preserves user field", () => {
  expect(conv("claude-test", `{"model":"claude-test","user":"openai-resp-user-456","input":[${userHello}]}`).metadata.user_id).toBe("openai-resp-user-456");
});

test("different sessions produce different user ids", () => {
  const a = conv("claude-test", `{"model":"claude-test","prompt_cache_key":"resp-session-a","input":[${userHello}]}`).metadata.user_id;
  const b = conv("claude-test", `{"model":"claude-test","prompt_cache_key":"resp-session-b","input":[${userHello}]}`).metadata.user_id;
  expect(a).not.toBe(b);
});

test("different user content with same system prompt", () => {
  const mk = (q: string): string =>
    `{"model":"claude-test","instructions":"global instruction","input":[{"type":"message","role":"system","content":"system context"},{"type":"message","role":"user","content":"${q}"}]}`;
  const a = conv("claude-test", mk("user question A")).metadata.user_id;
  const b = conv("claude-test", mk("user question B")).metadata.user_id;
  for (const id of [a, b]) {
    expect(id).not.toBe("");
    expect(id).not.toBe("unknown");
  }
  expect(a).not.toBe(b);
});

test("fable strips trailing assistant prefill", () => {
  const messages = conv(
    "claude-fable-5",
    `{"model":"claude-fable-5","input":[${userHello},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"progress update"}]}]}`,
  ).messages;
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("user");
  expect(messages[0].content).toBe("hello");
});

test("fable only assistant message yields fallback user", () => {
  const messages = conv("claude-fable-5", `{"model":"claude-fable-5","input":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"orphan progress"}]}]}`).messages;
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("user");
});

describe("unsupported prefill models strip trailing assistant", () => {
  for (const model of [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-4-6",
    "fable",
    "opus-5",
    "sonnet-4.6",
    "anthropic/claude-opus-5-thinking",
    "claude-sonnet-4.6",
    "claude-sonnet-4-7",
    "claude-sonnet-4-10",
    "claude-sonnet-5",
    "claude-opus-6",
    "claude-opus-5.1",
    "claude-sonnet-4-6-20260217",
    " ANTHROPIC/CLAUDE-OPUS-5-THINKING ",
    "claude-haiku-5-5",
    "claude-haiku-5",
    "claude-haiku-5.5",
    "haiku-5-5",
    "anthropic/claude-haiku-5-5",
  ]) {
    test(JSON.stringify(model), () => {
      const messages = conv(
        model,
        JSON.stringify({ model, input: [JSON.parse(userHello), { type: "message", role: "assistant", content: [{ type: "output_text", text: "progress update" }] }] }),
      ).messages;
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("hello");
    });
  }
});

describe("supported prefill models preserve assistant prefill", () => {
  for (const model of [
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-haiku-5foo",
    "claude-haiku-20260217",
    "claude-3-opus-20240229",
    "claude-opus-20240229",
    "claude-sonnet-4-20260217",
    "claude-sonnet-4.5",
    "not-a-fable-model",
    "my-custom-opus-5-wrapper",
    "my-sonnet-4-6-wrapper",
    "claude-fabled-5",
    "claude-opus-5foo",
    "claude-sonnet-4-6foo",
    "fable/gpt-4o",
    "opus",
    "sonnet",
    "",
  ]) {
    test(JSON.stringify(model), () => {
      const messages = conv(
        model,
        JSON.stringify({ model, input: [JSON.parse(userHello), { type: "message", role: "assistant", content: [{ type: "output_text", text: "prefill text" }] }] }),
      ).messages;
      expect(messages.length).toBe(2);
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("prefill text");
    });
  }
});

test("with compat fable preserves assistant prefill", () => {
  const messages = convCompat(
    "claude-fable-5",
    `{"model":"claude-fable-5","input":[${userHello},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"prefill text"}]}]}`,
  ).messages;
  expect(messages.length).toBe(2);
  expect(messages[1].role).toBe("assistant");
});

describe("strips trailing thinking blocks from assistant", () => {
  const [rawSig] = sig();
  const model = "claude-haiku-4-5-20251001";
  const reasoning = (summary: string): string => `{"type":"reasoning","encrypted_content":${JSON.stringify(rawSig)},"summary":${summary}}`;
  const thought = `[{"type":"summary_text","text":"thought"}]`;
  const prefill = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"prefill text"}]}`;
  test("user then reasoning drops trailing assistant message", () => {
    const messages = conv(model, `{"model":"${model}","input":[${userHello},${reasoning(thought)}]}`).messages;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hello");
  });
  test("user, assistant text, reasoning strips trailing thinking and keeps assistant text", () => {
    const messages = conv(model, `{"model":"${model}","input":[${userHello},${prefill},${reasoning(thought)}]}`).messages;
    expect(messages.length).toBe(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("prefill text");
  });
  test("trailing redacted_thinking is stripped", () => {
    const redacted = `{"type":"reasoning","encrypted_content":"${claudeResponsesRedactedThinkingPrefix}redacted-data","summary":[]}`;
    const messages = conv(model, `{"model":"${model}","input":[${userHello},${prefill},${reasoning("[]")},${redacted}]}`).messages;
    expect(messages.length).toBe(2);
    expect(messages[1].content).toBe("prefill text");
  });
  test("only reasoning item yields fallback user message", () => {
    const messages = conv(model, `{"model":"${model}","input":[${reasoning(thought)}]}`).messages;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
  });
  test("compat mode preserves trailing thinking", () => {
    expect(convCompat(model, `{"model":"${model}","input":[${userHello},${reasoning(thought)}]}`).messages.length).toBe(2);
  });
});

describe("keeps agent_message text", () => {
  const input = `{"model":"claude-fable-5-1","input":[{"type":"agent_message","content":[{"type":"input_text","text":"do X"}]},{"type":"agent_message","content":[{"type":"encrypted_content","encrypted_content":"secret task"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"plain"}]}]}`;
  for (const [name, fn] of [
    ["standard", conv],
    ["compat", convCompat],
  ] as const) {
    test(name, () => {
      const messages = fn("claude-fable-5-1", input).messages;
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content.map((p: JSONObject) => p.text)).toEqual(["do X", "secret task", "plain"]);
    });
  }
  test("mixed content in single agent_message", () => {
    const parts = conv(
      "claude-fable-5-1",
      `{"model":"claude-fable-5-1","input":[{"type":"agent_message","content":[{"type":"input_text","text":"step 1"},{"type":"encrypted_content","encrypted_content":"step 2"}]}]}`,
    ).messages[0].content;
    expect(parts.map((p: JSONObject) => p.text)).toEqual(["step 1", "step 2"]);
  });
});

describe("text.format structured output", () => {
  const systemTexts = (out: JSONObject): string[] => (out.system ?? []).map((b: JSONObject) => b.text as string);
  test("json_schema", () => {
    const out = conv(
      "claude-sonnet-4-6",
      `{"model":"claude-sonnet-4-6","input":"Extract facts.","text":{"format":{"type":"json_schema","name":"extracted_facts","schema":{"type":"object","properties":{"facts":{"type":"array","items":{"type":"string"}}},"required":["facts"]}}}}`,
    );
    expect(systemTexts(out).some((t) => t.includes("facts"))).toBe(true);
  });
  test("json_object", () => {
    const out = conv("claude-sonnet-4-6", `{"model":"claude-sonnet-4-6","input":"Return JSON.","text":{"format":{"type":"json_object"}}}`);
    expect(systemTexts(out).some((t) => t.includes("JSON object"))).toBe(true);
  });
  test("preserves existing instructions and precedence", () => {
    const texts = systemTexts(
      conv(
        "claude-sonnet-4-6",
        `{"model":"claude-sonnet-4-6","instructions":"Be concise.","input":"Extract facts.","text":{"format":{"type":"json_schema","name":"winning_schema","description":"Primary facts","schema":{"type":"object","properties":{"item":{"type":"string"}}}}},"response_format":{"type":"json_object"}}`,
      ),
    );
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts.some((t) => t.includes("Be concise."))).toBe(true);
    expect(texts.some((t) => t.includes("winning_schema") && t.includes("Primary facts") && t.includes("item"))).toBe(true);
    expect(texts.some((t) => t.includes("valid JSON object"))).toBe(false);
  });
});

describe("function_call_output alternate ids and queue fallback", () => {
  const cases: [string, string][] = [
    ["call_id standard", `"call_id":"call_123"`],
    ["tool_call_id alternate field", `"tool_call_id":"call_123"`],
    ["callId alternate field", `"callId":"call_123"`],
    ["id alternate field", `"id":"call_123"`],
    ["missing call_id completely fallback to pending queue", ``],
  ];
  for (const [name, field] of cases) {
    test(name, () => {
      const output = `{"type":"function_call_output","output":"tool_result_ok"${field !== "" ? "," + field : ""}}`;
      const messages = conv(
        "claude-sonnet-4-6",
        `{"model":"claude-sonnet-4-6","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},{"type":"function_call","call_id":"call_123","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"},${output}]}`,
      ).messages;
      expect(messages.length).toBe(3);
      expect([messages[1].content[0].type, messages[1].content[0].id]).toEqual(["tool_use", "call_123"]);
      expect([messages[2].content[0].type, messages[2].content[0].tool_use_id, messages[2].content[0].content]).toEqual(["tool_result", "call_123", "tool_result_ok"]);
    });
  }
});

const resultMapOf = (messages: JSONObject[]): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const m of messages) if (m.role === "user" && Array.isArray(m.content)) for (const p of m.content) if (p.type === "tool_result") map[p.tool_use_id] = p.content;
  return map;
};

test("mixed missing and explicit parallel outputs", () => {
  const messages = conv(
    "claude-sonnet-4-6",
    `{"model":"claude-sonnet-4-6","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},{"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},{"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},{"type":"function_call_output","output":"result_b"},{"type":"function_call_output","call_id":"call_a","output":"result_a"}]}`,
  ).messages;
  expect(messages.length).toBe(3);
  expect(messages[2].content.length).toBe(2);
  const map = resultMapOf(messages);
  expect(map.call_a).toBe("result_a");
  expect(map.call_b).toBe("result_b");
});

test("mixed missing and explicit parallel outputs across user message", () => {
  const map = resultMapOf(
    conv(
      "claude-sonnet-4-6",
      `{"model":"claude-sonnet-4-6","input":[{"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},{"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},{"type":"function_call_output","output":"result_b"},{"type":"message","role":"user","content":[{"type":"input_text","text":"status?"}]},{"type":"function_call_output","call_id":"call_a","output":"result_a"}]}`,
    ).messages,
  );
  expect(map.call_a).toBe("result_a");
  expect(map.call_b).toBe("result_b");
});

test("string input", () => {
  const textOf = (content: unknown): string => (Array.isArray(content) ? (content as JSONObject[])[0]!.text : (content as string));
  const messages = conv("claude-sonnet-4-6", `{"model":"claude-sonnet-4-6","input":"hi","max_output_tokens":16,"stream":false}`).messages;
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("user");
  expect(textOf(messages[0].content)).toBe("hi");
  const withInstr = conv("claude-sonnet-4-6", `{"model":"claude-sonnet-4-6","instructions":"Be concise.","input":"hello world","max_output_tokens":32,"stream":false}`);
  expect(withInstr.system.length).toBe(1);
  expect(withInstr.system[0].text).toBe("Be concise.");
  expect(withInstr.messages.length).toBe(1);
  expect([withInstr.messages[0].role, withInstr.messages[0].content]).toEqual(["user", "hello world"]);
  const complex = conv("claude-sonnet-4-6", `{"model":"claude-sonnet-4-6","input":"line 1\\n\\"line 2\\"\\n你好，世界 🌍","max_output_tokens":16,"stream":false}`);
  expect(complex.messages.length).toBe(1);
  expect(complex.messages[0].content).toBe('line 1\n"line 2"\n你好，世界 🌍');
});

test("long tool names unique and reversible", () => {
  const reqJSON = `{"model":"claude-sonnet-5-5","input":"test","stream":false,"tools":[{"type":"namespace","name":"mcp__example_apps__acme_inventory_service","tools":[{"type":"function","name":"acme_inventory_service_get_item_prices","description":"prices","parameters":{"type":"object","properties":{}}},{"type":"function","name":"acme_inventory_service_get_item_metrics","description":"metrics","parameters":{"type":"object","properties":{}}}]}]}`;
  const tools = conv("claude-sonnet-5-5", reqJSON).tools;
  expect(tools.length).toBe(2);
  const [name0, name1] = [tools[0].name as string, tools[1].name as string];
  expect(name0.length).toBeLessThanOrEqual(64);
  expect(name1.length).toBeLessThanOrEqual(64);
  expect(name0).not.toBe(name1);
  const ns = "mcp__example_apps__acme_inventory_service";
  expect(splitResponsesQualifiedFunctionCallFromRequest(JSON.parse(reqJSON), name0, true)).toEqual({ name: "acme_inventory_service_get_item_prices", namespace: ns });
  expect(splitResponsesQualifiedFunctionCallFromRequest(JSON.parse(reqJSON), name1, true)).toEqual({ name: "acme_inventory_service_get_item_metrics", namespace: ns });

  const claudeResp = [
    `data: {"type":"message_start","message":{"id":"msg_test_123","usage":{"input_tokens":10,"output_tokens":5}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_test_0","name":${JSON.stringify(name0)},"input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"item_id\\":\\"42\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_stop"}`,
  ].join("\n");
  const item = JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-sonnet-5-5", reqJSON, "", claudeResp, undefined)).output[0];
  expect([item.type, item.name, item.namespace]).toEqual(["function_call", "acme_inventory_service_get_item_prices", ns]);

  const streamChunks = [
    `data: {"type":"message_start","message":{"id":"msg_stream_123","usage":{"input_tokens":10,"output_tokens":5}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_test_1","name":${JSON.stringify(name1)},"input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"metric\\":\\"latency\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_stop"}`,
  ];
  const state: TranslatorState = {};
  let added: JSONObject | undefined;
  let done: JSONObject | undefined;
  let completed: JSONObject | undefined;
  for (const chunk of streamChunks) {
    for (const output of convertClaudeResponseToOpenAIResponses(emptyContext, "claude-sonnet-5-5", reqJSON, "", chunk, state)) {
      const [event, data] = parseSSEEvent(output);
      if (event === "response.output_item.added" && data.item.type === "function_call") added = data;
      if (event === "response.output_item.done" && data.item.type === "function_call") done = data;
      if (event === "response.completed") completed = data;
    }
  }
  for (const it of [added!.item, done!.item, completed!.response.output[0]]) expect([it.name, it.namespace]).toEqual(["acme_inventory_service_get_item_metrics", ns]);
});

test("sanitization collisions", () => {
  const reqJSON = `{"model":"claude-sonnet-5-5","input":"test","stream":false,"tools":[{"type":"function","name":"a_b","description":"ab","parameters":{"type":"object","properties":{}}},{"type":"function","name":"a.b","description":"a.b","parameters":{"type":"object","properties":{}}}]}`;
  const tools = conv("claude-sonnet-5-5", reqJSON).tools;
  expect(tools.length).toBe(2);
  expect(tools[0].name).toBe("a_b");
  expect(tools[1].name).not.toBe("a_b");
  expect(tools[1].name.startsWith("a_b_")).toBe(true);
  expect(splitResponsesQualifiedFunctionCallFromRequest(JSON.parse(reqJSON), tools[0].name, true)).toEqual({ name: "a_b", namespace: "" });
  expect(splitResponsesQualifiedFunctionCallFromRequest(JSON.parse(reqJSON), tools[1].name, true)).toEqual({ name: "a.b", namespace: "" });
});

test("long tool_choice and history", () => {
  const out = conv(
    "claude-sonnet-5-5",
    `{"model":"claude-sonnet-5-5","input":[{"type":"message","role":"user","content":"check item"},{"type":"function_call","call_id":"call_123","namespace":"mcp__example_apps__acme_inventory_service","name":"acme_inventory_service_get_item_prices","arguments":"{}"},{"type":"function_call_output","call_id":"call_123","output":"{\\"price\\": 100}"}],"stream":false,"tool_choice":{"type":"function","namespace":"mcp__example_apps__acme_inventory_service","name":"acme_inventory_service_get_item_prices"},"tools":[{"type":"namespace","name":"mcp__example_apps__acme_inventory_service","tools":[{"type":"function","name":"acme_inventory_service_get_item_prices","description":"prices","parameters":{"type":"object","properties":{}}},{"type":"function","name":"acme_inventory_service_get_item_metrics","description":"metrics","parameters":{"type":"object","properties":{}}}]}]}`,
  );
  const declared = out.tools[0].name;
  expect(out.tool_choice.name).toBe(declared);
  let historyName = "";
  for (const msg of out.messages) if (msg.role === "assistant") for (const part of msg.content) if (part.type === "tool_use") historyName = part.name;
  expect(historyName).toBe(declared);
});

test("apply_patch Claude request contract and history", () => {
  const result = conv(
    "test",
    `{"tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch","description":"Edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.","format":{"type":"grammar","syntax":"lark","definition":"start: patch"},"cache_control":{"type":"ephemeral"}}]}],"input":[{"type":"custom_tool_call","namespace":"editor","name":"apply_patch","call_id":"c1","input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch"},{"type":"custom_tool_call_output","call_id":"c1","output":"done"}]}`,
  );
  const tool = result.tools[0];
  for (const instruction of ["*** Begin Patch", "*** End Patch", "*** Add File:", "*** Delete File:", "*** Update File:", "*** Move to:", "*** End of File", "@@", "start: patch", "JSON object"]) {
    expect(tool.description).toContain(instruction);
  }
  expect(tool.description).not.toContain("do not wrap the patch in JSON");
  expect(tool.input_schema.additionalProperties).toBe(false);
  expect(tool.input_schema.required[0]).toBe("input");
  expect(tool.cache_control.type).toBe("ephemeral");
  const call = result.messages[0].content[0];
  expect([call.name, call.input.input, call.id]).toEqual(["editor__apply_patch", "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch", "c1"]);
  expect(result.messages[1].content[0].tool_use_id).toBe("c1");
  expect(result.messages[1].content[0].content).toBe("done");
});

test("incomplete tool output is error", () => {
  const result = conv(
    "claude-opus-5-5",
    `{"model":"gpt-4o","tools":[{"type":"function","name":"get_weather","description":"Get weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"input":[{"type":"message","role":"user","content":"Weather in Atlantis?"},{"type":"function_call","call_id":"call_err1","name":"get_weather","arguments":"{\\"city\\":\\"Atlantis\\"}"},{"type":"function_call_output","call_id":"call_err1","status":"incomplete","output":"City not found"},{"type":"message","role":"user","content":"Did it fail?"}],"max_output_tokens":128,"stream":false}`,
  );
  let toolResult: JSONObject | undefined;
  for (const m of result.messages) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "tool_result" && b.tool_use_id === "call_err1") toolResult ??= b;
  expect(toolResult!.content).toBe("City not found");
  expect(toolResult!.is_error).toBe(true);
});

describe("drops empty and whitespace text blocks", () => {
  test("trailing empty and whitespace input_text dropped", () => {
    const root = conv(
      "claude-sonnet-5",
      `{"model":"claude-sonnet-5","instructions":"   ","input":[{"role":"developer","content":[{"type":"input_text","text":"Follow instructions."},{"type":"input_text","text":""},{"type":"input_text","text":"  \\n\\t "}],"cache_control":{"type":"ephemeral"}},{"role":"user","content":[{"type":"input_text","text":"Reply with exactly OK."},{"type":"input_text","text":""},{"type":"input_text","text":"   "}]},{"role":"assistant","content":[{"type":"output_text","text":""},{"type":"output_text","text":"OK"},{"type":"output_text","text":" \\t "}]},{"role":"user","content":[{"type":"input_text","text":"Next turn"},{"type":"input_text","text":"","cache_control":{"type":"ephemeral"}}]}],"reasoning":{"effort":"minimal"},"max_output_tokens":128,"store":false}`,
    );
    expect(root.system.length).toBe(1);
    expect(root.system[0].text).toBe("Follow instructions.");
    expect(root.system[0].cache_control.type).toBe("ephemeral");
    expect(root.messages.length).toBe(3);
    expect(root.messages[0].content).toBe("Reply with exactly OK.");
    expect(root.messages[1].content).toBe("OK");
    expect(root.messages[2].content[0].text).toBe("Next turn");
    expect(root.messages[2].content[0].cache_control.type).toBe("ephemeral");
  });
  test("middle empty part with cache_control attaches to immediately preceding block preserving TTL order", () => {
    const root = conv(
      "claude-sonnet-5",
      `{"model":"claude-sonnet-5","input":[{"role":"developer","content":[{"type":"input_text","text":"S1"},{"type":"input_text","text":"","cache_control":{"type":"ephemeral","ttl":"1h"}},{"type":"input_text","text":"S2","cache_control":{"type":"ephemeral","ttl":"5m"}},{"type":"input_text","text":"S3"}]},{"role":"user","content":[{"type":"input_text","text":"A"},{"type":"input_text","text":"","cache_control":{"type":"ephemeral","ttl":"1h"}},{"type":"input_text","text":"B","cache_control":{"type":"ephemeral","ttl":"5m"}},{"type":"input_text","text":"C"}]},{"role":"user","content":[{"type":"input_text","text":""},{"type":"input_text","text":"   "}]}]}`,
    );
    expect(root.system.length).toBe(3);
    expect(root.system[0].cache_control.ttl).toBe("1h");
    expect(root.system[1].cache_control.ttl).toBe("5m");
    expect(root.system[2].cache_control).toBeUndefined();
    expect(root.messages.length).toBe(1);
    expect(root.messages[0].content.length).toBe(3);
    expect(root.messages[0].content[0].cache_control.ttl).toBe("1h");
    expect(root.messages[0].content[1].cache_control.ttl).toBe("5m");
    expect(root.messages[0].content[2].cache_control).toBeUndefined();
  });
});
