// Ported from: internal/translator/claude/openai/responses/echo_perf_test.go
// Skipped cases: BenchmarkClaudeResponsesToolStreamLongRequest (benchmark, no harness). The golden hashes are
// compared over Go's canonical encoding (sorted keys, HTML-escaped strings), which goCanonical reproduces.
import { describe, expect, test } from "bun:test";
import {
  buildClaudeToolNames,
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
  withClientToolSearch,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import { sha256Hex } from "../../../../../src/util/hash.ts";
import { useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

/** Go's json.Marshal of a decoded value: map keys sorted, <, >, & and U+2028/2029 escaped. */
function goCanonical(v: unknown): string {
  if (v === null || typeof v !== "object") {
    const s = JSON.stringify(v);
    return typeof v === "string" ? s.replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : s;
  }
  if (Array.isArray(v)) return "[" + v.map(goCanonical).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => goCanonical(k) + ":" + goCanonical(obj[k])).join(",") + "}";
}

function zeroCreated(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(zeroCreated);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = k === "created_at" ? 0 : zeroCreated(val);
    return out;
  }
  return v;
}

function normalizeEvents(raw: string): string {
  let out = "";
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (line === "") continue;
    out += (line.startsWith("data: ") ? goCanonical(zeroCreated(JSON.parse(line.slice(6)))) : line) + "\n";
  }
  return out;
}

function claudeSSEFixture(): string[] {
  return [
    `data: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ponder"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"editor__read","input":{}}}`,
    `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/tmp/a\\"}"}}`,
    `data: {"type":"content_block_stop","index":2}`,
    `data: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_2","name":"plain","input":{}}}`,
    `data: {"type":"content_block_stop","index":3}`,
    `data: {"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"toolu_3","name":"unknown_tool","input":{}}}`,
    `data: {"type":"content_block_stop","index":4}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":9}}`,
    `data: {"type":"message_stop"}`,
  ];
}

function runClaudeStream(request: string, chunks = claudeSSEFixture()): string {
  const state: TranslatorState = {};
  let out = "";
  for (const chunk of chunks) out += convertClaudeResponseToOpenAIResponses(emptyContext, "m", request, request, chunk, state).join("");
  return out;
}

function nonStreamHash(request: string, chunks = claudeSSEFixture()): string {
  const non = convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "m", request, request, chunks.map((c) => c + "\n").join(""), {});
  return sha256Hex(goCanonical(zeroCreated(JSON.parse(non))));
}

const history = "context ".repeat(4096);
const nsTools = `[{"type":"namespace","name":"editor","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]},{"type":"function","name":"plain","parameters":{"type":"object"}}]`;
const requests: [string, string][] = [
  ["nil", ""],
  ["empty", `{}`],
  [
    "full",
    `{"model":"gpt-5","instructions":"${history}","max_output_tokens":99,"parallel_tool_calls":false,"reasoning":{"effort":"high"},"store":true,"temperature":1,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":${nsTools},"top_p":0.5,"metadata":{"b":2,"a":1},"input":[{"role":"user","content":"hi"}]}`,
  ],
  [
    "flat-collision",
    `{"model":"gpt-5","tools":[{"type":"function","name":"editor__read","parameters":{"type":"object"}},{"type":"namespace","name":"editor","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]}],"input":[]}`,
  ],
  ["weird-types", `{"model":42,"instructions":null,"temperature":"hot","store":"yes","tools":"none","metadata":[3],"input":[]}`],
  ["duplicate-keys", `{"model":"first","input":[],"model":"second","temperature":0.1,"temperature":0.9}`],
  [
    "history-calls",
    `{"model":"gpt-5","tools":${nsTools},"input":[{"type":"function_call","call_id":"c0","name":"read","namespace":"editor","arguments":"{}"},{"type":"function_call_output","call_id":"c0","output":"ok"}]}`,
  ],
];
const goldenHashes: Record<string, [string, string]> = {
  nil: ["ab4bf61de3306512dcde13cdabb426c55226319673cc766c18751d1f41009dad", "99221176860da000324aab10d71af05082ec1ea3752234a85adfa300283d24ee"],
  empty: ["ab4bf61de3306512dcde13cdabb426c55226319673cc766c18751d1f41009dad", "99221176860da000324aab10d71af05082ec1ea3752234a85adfa300283d24ee"],
  full: ["197061d4b6a78413a453999e3aa5f61f15d919c4496deea1b6d141ce925f664a", "4510b918b334ba8bedeb79ebd0ffcb158d99597edaf2b2c80d90cddf736a8959"],
  "flat-collision": ["3390b4761e3e41d9239ebe0f97572205540f23a206cfbe4c2948af615cda43c3", "06e538b3c37fa6e5e7aa1992a5f60401829e34752ba531fd58d216709a0635ef"],
  "weird-types": ["e5915b3997f997f570eaa5a8a09dcf2ad4fdac0795ead2791018d2ebe986dba7", "b60a62ba215b1aea49ba6013215b3f035764e95fcf02fd9eb670f4dc340e413a"],
  "duplicate-keys": ["750b93f22f590508161a38465bda84e3237c87b70ffab02b7f19243e8b8f5242", "65ada4367a73723f249349931d495aa178fb7ea9030ae3ec82b7e578a2431052"],
  "history-calls": ["cdf54a66b81bdab55f032612ecc6a0e2d5d8c500ac8849ab88c69c2373bf9ad6", "de0e606c25ee77a78c5cc8c0653d621836b168e284ccef11ecca13827aef2a52"],
};

describe("echo golden outputs", () => {
  for (const [name, raw] of requests) {
    test(name, () => {
      const want = goldenHashes[name]!;
      expect(sha256Hex(normalizeEvents(runClaudeStream(raw)))).toBe(want[0]);
      expect(nonStreamHash(raw)).toBe(want[1]);
    });
  }
});

function egChunks(names: string[]): string[] {
  const out = [`data: {"type":"message_start","message":{"id":"msg-e","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1}}}`];
  names.forEach((name, i) => {
    out.push(
      `data: {"type":"content_block_start","index":${i},"content_block":{"type":"tool_use","id":"toolu_${i}","name":${JSON.stringify(name)},"input":{}}}`,
      `data: {"type":"content_block_delta","index":${i},"delta":{"type":"input_json_delta","partial_json":"{}"}}`,
      `data: {"type":"content_block_stop","index":${i}}`,
    );
  });
  out.push(`data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":3,"output_tokens":4}}`, `data: {"type":"message_stop"}`);
  return out;
}

describe("echo golden edge cases", () => {
  const want: Record<string, [string, string]> = {
    "long-and-invalid-names": ["41307ab5fdb3c147802cc04c12c1aebc2136c4b17fb7e0b0eb21cb750f7bd50c", "0dbf5c12e8f78697d4cdd86260fd918f1710909434738a190b2d6490ead74bcc"],
    "toolsearch-on": ["e57dcaf468458da7a240fe19c41a3d689d90191797ef6cc4d1f03e6ca4fdad3d", "3cc6b91c93b5789e52bdcf8bd9bf8a95308604d76fbc9e683e04306c5d2b3721"],
    "toolsearch-off": ["fd981f216a4da138561d4379ea8236f60aab2fbb96b292bbe5b296677a7e0bf3", "6674a51b19acb3b834840494c1110eb7e998ca5a9b808bb2731ddb69a0555d07"],
  };
  const longName = "ns__" + "x".repeat(90);
  const dotted = "my.tool name";
  const collideA = "a.b";
  const collideB = "a_b";
  const toolsJSON = `[{"type":"namespace","name":"editor","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]},${[longName, dotted, collideA, collideB]
    .map((n) => `{"type":"function","name":${JSON.stringify(n)},"parameters":{"type":"object"}}`)
    .join(",")}]`;
  const searchTools = `[{"type":"tool_search","execution":"client"},{"type":"function","name":"deferred_tool","defer_loading":true,"parameters":{"type":"object"}},{"type":"function","name":"plain","parameters":{"type":"object"}}]`;
  const cases: [string, string, boolean, (req: string) => string[]][] = [
    [
      "long-and-invalid-names",
      `{"model":"gpt-5","tools":${toolsJSON},"input":[]}`,
      false,
      (req) => {
        const names = buildClaudeToolNames(JSON.parse(req), false);
        return [names.claudeName(longName), names.claudeName(dotted), names.claudeName(collideA), names.claudeName(collideB), "editor__read"];
      },
    ],
    ["toolsearch-on", `{"model":"gpt-5","tools":${searchTools},"input":[]}`, true, () => ["tool_search", "plain"]],
    ["toolsearch-off", `{"model":"gpt-5","tools":${searchTools},"input":[]}`, false, () => ["tool_search", "plain", "deferred_tool"]],
  ];
  for (const [name, request, toolSearch, names] of cases) {
    test(name, () => {
      const ctx = withClientToolSearch(emptyContext, toolSearch);
      const chunks = egChunks(names(request));
      const state: TranslatorState = {};
      let out = "";
      for (const c of chunks) out += convertClaudeResponseToOpenAIResponses(ctx, "m", request, request, c, state).join("");
      const non = convertClaudeResponseToOpenAIResponsesNonStream(ctx, "m", request, request, chunks.map((c) => c + "\n").join(""), {});
      expect(sha256Hex(normalizeEvents(out))).toBe(want[name]![0]);
      expect(sha256Hex(goCanonical(zeroCreated(JSON.parse(non))))).toBe(want[name]![1]);
    });
  }
});
