// Ported from: internal/runtime/executor/caching_verify_test.go
// Skipped cases: none. TestClaudeExecutorCloakedRollingCacheBreakpointAdvances runs the Claude executor against an
//   in-process fetch (Go: roundTripperFunc on the context) with the same cloaked API-key credential.
import { describe, expect, test } from "bun:test";
import {
  claudeCacheControlTTL1h,
  countCacheControls,
  ensureCacheControl,
  injectToolsCacheControl,
  shouldEnsureCacheControl,
  upgradeClaudeCacheControlTTL,
} from "../../src/executor/claude/cache_control.ts";
import { injectClaudeCodeCurrentDate } from "../../src/executor/claude/billing.ts";
import { executeClaudeRequest } from "./claude_helpers.ts";

const get = (body: string, path: string): unknown => {
  let cur: unknown = JSON.parse(body);
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
};
const has = (body: string, path: string) => get(body, path) !== undefined;
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("TestEnsureCacheControl", () => {
  test("String System Prompt", () => {
    const out = ensureCacheControl(`{"model": "claude-3-5-sonnet", "system": "This is a long system prompt", "messages": []}`);
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
  });

  test("Array System Prompt", () => {
    const out = ensureCacheControl(`{"model": "claude-3-5-sonnet", "system": [{"type": "text", "text": "Part 1"}, {"type": "text", "text": "Part 2"}], "messages": []}`);
    expect(has(out, "system.0.cache_control")).toBe(false);
    expect(get(out, "system.1.cache_control.type")).toBe("ephemeral");
  });

  test("Tools Not Auto Cached", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "tools": [
        {"name": "tool1", "description": "First tool", "input_schema": {"type": "object"}},
        {"name": "tool2", "description": "Second tool", "input_schema": {"type": "object"}}
      ],
      "system": "System prompt",
      "messages": []
    }`);
    expect(has(out, "tools.0.cache_control")).toBe(false);
    expect(has(out, "tools.1.cache_control")).toBe(false);
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "system.0.cache_control.ttl")).toBe(false);
  });

  test("Independent Cache Breakpoints", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "tools": [{"name": "tool1", "description": "First tool", "input_schema": {"type": "object"}, "cache_control": {"type": "ephemeral"}}],
      "system": [{"type": "text", "text": "System"}],
      "messages": []
    }`);
    expect(get(out, "tools.0.cache_control.type")).toBe("ephemeral");
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
  });

  test("Only Tools No System Falls Back To Tools Breakpoint", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "tools": [
        {"name": "tool1", "description": "Tool", "input_schema": {"type": "object"}},
        {"name": "tool2", "description": "Tool", "input_schema": {"type": "object"}}
      ],
      "messages": [{"role": "user", "content": "Hi"}]
    }`);
    expect(has(out, "tools.0.cache_control")).toBe(false);
    expect(get(out, "tools.1.cache_control.type")).toBe("ephemeral");
    expect(has(out, "tools.1.cache_control.ttl")).toBe(false);
    expect(get(out, "messages.0.content.0.cache_control.type")).toBe("ephemeral");
  });

  for (const [name, system] of [
    ["empty array", `"system": [],`],
    ["empty string", `"system": "",`],
    ["blank string", `"system": "   ",`],
  ] as const) {
    test(`Empty System Still Falls Back To Tools: ${name}`, () => {
      const out = ensureCacheControl(`{
        "model": "claude-3-5-sonnet",
        ${system}
        "tools": [{"name": "tool1", "description": "Tool", "input_schema": {"type": "object"}}],
        "messages": [{"role": "user", "content": "Hi"}]
      }`);
      expect(get(out, "tools.0.cache_control.type")).toBe("ephemeral");
      expect(out.includes(`"text":""`) || out.includes(`"text":"   "`)).toBe(false);
      expect(has(out, "system.0.cache_control")).toBe(false);
      expect(countCacheControls(out)).toBe(2);
    });
  }

  test("Many Tools (Claude Code Scenario)", () => {
    const tools = Array.from({ length: 50 }, (_, i) => `{"name": "tool${i}", "description": "Tool ${i}", "input_schema": {"type": "object"}}`).join(",");
    const input = `{"model": "claude-3-5-sonnet", "tools": [${tools}], "system": [{"type": "text", "text": "You are Claude Code"}], "messages": [{"role": "user", "content": "Hello"}]}`;
    const out = ensureCacheControl(input);
    for (let i = 0; i < 50; i++) expect(has(out, `tools.${i}.cache_control`)).toBe(false);
    expect(get(injectToolsCacheControl(input), "tools.49.cache_control.type")).toBe("ephemeral");
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
    expect(get(out, "messages.0.content.0.cache_control.type")).toBe("ephemeral");
  });

  test("Empty Tools Array", () => {
    const out = ensureCacheControl(`{"model": "claude-3-5-sonnet", "tools": [], "system": "Test", "messages": []}`);
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
  });

  test("Messages Caching Latest User", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "messages": [
        {"role": "user", "content": "First user"},
        {"role": "assistant", "content": "Assistant reply"},
        {"role": "user", "content": "Second user"},
        {"role": "assistant", "content": "Assistant reply 2"},
        {"role": "user", "content": "Third user"}
      ]
    }`);
    expect(get(out, "messages.4.content.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "messages.4.content.0.cache_control.ttl")).toBe(false);
    expect(has(out, "messages.2.content.0.cache_control")).toBe(false);
  });

  test("Messages Caching Trailing System String", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "messages": [
        {"role": "user", "content": "User"},
        {"role": "assistant", "content": "Assistant"},
        {"role": "system", "content": "Internal system"}
      ]
    }`);
    const content = get(out, "messages.2.content") as Array<Record<string, unknown>>;
    expect(Array.isArray(content) && content.length === 1).toBe(true);
    expect(content[0]!.text).toBe("Internal system");
    expect((content[0]!.cache_control as Record<string, unknown>).type).toBe("ephemeral");
    expect(has(out, "messages.1.content.0.cache_control")).toBe(false);
  });

  test("Messages Caching Trailing System Array Falls Back", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "messages": [
        {"role": "user", "content": "User"},
        {"role": "assistant", "content": "Assistant"},
        {"role": "system", "content": [{"type": "text", "text": "Internal 1"}, {"type": "text", "text": "Internal 2"}]}
      ]
    }`);
    expect(has(out, "messages.2.content.1.cache_control")).toBe(false);
    expect(get(out, "messages.1.content.0.cache_control.type")).toBe("ephemeral");
  });

  test("Messages Caching Trailing Assistant Text", () => {
    const out = ensureCacheControl(`{"messages": [{"role": "user", "content": "User"}, {"role": "assistant", "content": "Assistant prefill"}]}`);
    expect(get(out, "messages.1.content.0.cache_control.type")).toBe("ephemeral");
    expect(out).toContain(`[{"type":"text","text":"Assistant prefill","cache_control":{"type":"ephemeral"}}]`);
    expect(has(out, "messages.0.content.0.cache_control")).toBe(false);
  });

  test("Messages Skip Trailing Assistant Thinking", () => {
    const out = ensureCacheControl(`{
      "messages": [
        {"role": "user", "content": "User"},
        {"role": "system", "content": "Internal system"},
        {"role": "assistant", "content": [{"type": "text", "text": "Assistant"}, {"type": "thinking", "thinking": "Internal"}]}
      ]
    }`);
    expect(get(out, "messages.0.content.0.cache_control.type")).toBe("ephemeral");
    expect(typeof get(out, "messages.1.content")).toBe("string");
    expect(has(out, "messages.2.content.1.cache_control")).toBe(false);
  });

  test("Messages Inject Despite Cloaking First User Marker", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "tools": [{"name": "Read", "description": "read", "input_schema": {"type": "object"}}],
      "system": "You are helpful.",
      "messages": [
        {"role": "user", "content": [{"type": "text", "text": "currentDate"}, {"type": "text", "text": "First user", "cache_control": {"type": "ephemeral"}}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Assistant reply"}]},
        {"role": "user", "content": [{"type": "text", "text": "Second user"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Assistant reply 2"}]},
        {"role": "user", "content": [{"type": "text", "text": "Third user"}]}
      ]
    }`);
    expect(get(out, "messages.0.content.1.cache_control.type")).toBe("ephemeral");
    expect(get(out, "messages.4.content.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "tools.0.cache_control")).toBe(false);
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
  });

  test("Messages Skip When Latest User Already Has Cache Control", () => {
    const out = ensureCacheControl(`{
      "model": "claude-3-5-sonnet",
      "messages": [
        {"role": "user", "content": [{"type": "text", "text": "First user"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Assistant reply"}]},
        {"role": "user", "content": [{"type": "text", "text": "Second user", "cache_control": {"type": "ephemeral", "ttl": "1h"}}]}
      ]
    }`);
    expect(get(out, "messages.2.content.0.cache_control.ttl")).toBe("1h");
    expect(has(out, "messages.0.content.0.cache_control")).toBe(false);
  });

  test("Native Cache Control Wire Order", () => {
    const out = ensureCacheControl(`{"system": [{"type": "text", "text": "System"}], "messages": [{"role": "user", "content": [{"type": "text", "text": "User"}]}]}`);
    expect(count(out, `"cache_control":{"type":"ephemeral"}`)).toBe(2);
    const upgraded = upgradeClaudeCacheControlTTL(out, claudeCacheControlTTL1h);
    expect(count(upgraded, `"cache_control":{"type":"ephemeral","ttl":"1h"}`)).toBe(2);
    expect(upgraded).not.toContain(`"cache_control":{"ttl":"1h","type":"ephemeral"}`);
  });

  test("String Promotion Native Parent Order", () => {
    const out = ensureCacheControl(`{"system":"System <tag> &","messages":[{"role":"user","content":"User <tag> &"}]}`);
    expect(out).toContain(`"system":[{"type":"text","text":"System <tag> &","cache_control":{"type":"ephemeral"}}]`);
    expect(out).toContain(`"content":[{"type":"text","text":"User <tag> &","cache_control":{"type":"ephemeral"}}]`);
    for (const escaped of ["\\u003c", "\\u003e", "\\u0026"]) expect(out).not.toContain(escaped);
  });

  test("Existing Global Scope Preserved", () => {
    const out = ensureCacheControl(`{"system":[{"type":"text","text":"Global","cache_control":{"type":"ephemeral","ttl":"1h","scope":"global"}}],"messages":[{"role":"user","content":"User"}]}`);
    expect(out).toContain(`"cache_control":{"type":"ephemeral","ttl":"1h","scope":"global"}`);
  });
});

describe("TestShouldEnsureCacheControl", () => {
  const markerless = `{"messages":[{"role":"user","content":"x"}]}`;
  const withMarker = `{"messages":[{"role":"user","content":[{"type":"text","text":"x","cache_control":{"type":"ephemeral"}}]}]}`;
  const explicit = `{"prompt_cache_options":{"mode":"explicit"},"messages":[{"role":"user","content":"x"}]}`;
  const explicitMarker = `{"prompt_cache_options":{"mode":"explicit"},"messages":[{"role":"user","content":[{"type":"text","text":"x","cache_control":{"type":"ephemeral"}}]}]}`;
  const cases: Array<[string, string, boolean, boolean, boolean]> = [
    ["confirmed native markerless", markerless, false, true, false],
    ["confirmed native with marker", withMarker, false, true, false],
    ["cloaked with marker", withMarker, true, false, true],
    ["unconfirmed markerless", markerless, false, false, true],
    ["unconfirmed with marker", withMarker, false, false, false],
    ["explicit mode markerless", explicit, false, false, false],
    ["explicit mode cloaked", explicit, true, false, false],
    ["explicit mode with marker", explicitMarker, true, false, false],
  ];
  for (const [name, payload, cloaked, confirmed, want] of cases) {
    test(name, () => {
      expect(shouldEnsureCacheControl(payload, cloaked, confirmed)).toBe(want);
    });
  }
});

describe("TestInjectToolsCacheControlSkipsDeferredTools", () => {
  const cases: Array<[string, string, number, string]> = [
    ["trailing deferred tool", `{"tools":[{"name":"resident","defer_loading":false},{"name":"deferred","defer_loading":true}]}`, 0, ""],
    ["multiple trailing deferred tools", `{"tools":[{"name":"resident"},{"name":"deferred_1","defer_loading":true},{"name":"deferred_2","defer_loading":true}]}`, 0, ""],
    ["middle deferred tool", `{"tools":[{"name":"resident_1"},{"name":"deferred","defer_loading":true},{"name":"resident_2"}]}`, 2, ""],
    ["all tools deferred", `{"tools":[{"name":"deferred_1","defer_loading":true},{"name":"deferred_2","defer_loading":true}]}`, -1, ""],
    ["existing cache control", `{"tools":[{"name":"resident_1","cache_control":{"type":"ephemeral","ttl":"1h"}},{"name":"resident_2"}]}`, 0, "1h"],
  ];
  for (const [name, input, wantIndex, wantTTL] of cases) {
    test(name, () => {
      const out = injectToolsCacheControl(input);
      const tools = get(out, "tools") as Array<Record<string, unknown>>;
      let cacheCount = 0;
      tools.forEach((tool, index) => {
        if (tool.cache_control !== undefined) {
          cacheCount++;
          expect(index).toBe(wantIndex);
        }
        if (tool.defer_loading === true) expect(tool.cache_control).toBeUndefined();
      });
      expect(cacheCount).toBe(wantIndex < 0 ? 0 : 1);
      if (wantTTL !== "") expect(get(out, `tools.${wantIndex}.cache_control.ttl`)).toBe(wantTTL);
    });
  }
});

test("TestCacheControlOrder", () => {
  const out = ensureCacheControl(`{
    "model": "claude-sonnet-4",
    "tools": [
      {"name": "Read", "description": "Read file", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}},
      {"name": "Write", "description": "Write file", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}}}
    ],
    "system": [
      {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
      {"type": "text", "text": "Additional instructions here..."}
    ],
    "messages": [{"role": "user", "content": "Hello"}]
  }`);
  expect(has(out, "tools.0.cache_control") || has(out, "tools.1.cache_control")).toBe(false);
  expect(get(out, "system.1.cache_control.type")).toBe("ephemeral");
  expect(has(out, "system.1.cache_control.ttl")).toBe(false);
  expect(get(upgradeClaudeCacheControlTTL(out, claudeCacheControlTTL1h), "system.1.cache_control.ttl")).toBe("1h");
  expect(has(out, "system.0.cache_control")).toBe(false);
});

describe("TestUpgradeClaudeCacheControlTTL", () => {
  test("Upgrades Only Existing Markers", () => {
    const input =
      `{"tools":[{"name":"t","cache_control":{"type":"ephemeral"}},{"name":"u"}],` +
      `"system":[{"type":"text","text":"s0"},{"type":"text","text":"s1","cache_control":{"type":"ephemeral"}}],` +
      `"messages":[{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b","cache_control":{"type":"ephemeral"}}]}]}`;
    const out = upgradeClaudeCacheControlTTL(input, claudeCacheControlTTL1h);
    for (const path of ["tools.0", "system.1", "messages.0.content.1"]) expect(get(out, path + ".cache_control.ttl")).toBe("1h");
    for (const path of ["tools.1", "system.0", "messages.0.content.0"]) expect(has(out, path + ".cache_control")).toBe(false);
    expect(countCacheControls(out)).toBe(3);
  });

  test("Preserves Caller TTL And Is Idempotent", () => {
    const out = upgradeClaudeCacheControlTTL(`{"system":[{"type":"text","text":"s","cache_control":{"type":"ephemeral","ttl":"5m"}}]}`, claudeCacheControlTTL1h);
    expect(get(out, "system.0.cache_control.ttl")).toBe("5m");
    const once = upgradeClaudeCacheControlTTL(`{"system":[{"type":"text","text":"s","cache_control":{"type":"ephemeral"}}]}`, claudeCacheControlTTL1h);
    expect(upgradeClaudeCacheControlTTL(once, claudeCacheControlTTL1h)).toBe(once);
  });

  test("Keeps Native Key Order With Scope", () => {
    const out = upgradeClaudeCacheControlTTL(`{"system":[{"type":"text","text":"s","cache_control":{"type":"ephemeral","scope":"global"}}]}`, claudeCacheControlTTL1h);
    expect(out).toContain(`"cache_control":{"type":"ephemeral","ttl":"1h","scope":"global"}`);
  });

  test("No TTL Is A No-op", () => {
    const input = `{"system":[{"type":"text","text":"s","cache_control":{"type":"ephemeral"}}]}`;
    expect(upgradeClaudeCacheControlTTL(input, "")).toBe(input);
    expect(upgradeClaudeCacheControlTTL("not json", claudeCacheControlTTL1h)).toBe("not json");
  });
});

test("TestClaudeExecutorCloakedRollingCacheBreakpointAdvances", async () => {
  const conversation = (exchanges: number): string => {
    const messages: string[] = [];
    for (let i = 0; i < exchanges; i++) messages.push(`{"role":"user","content":"question number ${i}"}`, `{"role":"assistant","content":"answer number ${i}"}`);
    return `{"model":"claude-opus-5","max_tokens":100,"system":"You are a helpful assistant.","messages":[${messages.join(",")}]}`;
  };
  const lastMarked = (body: string): number => {
    let last = -1;
    (JSON.parse(body).messages as Array<{ content: unknown }>).forEach((message, idx) => {
      if (Array.isArray(message.content) && message.content.some((b: { cache_control?: unknown }) => b.cache_control !== undefined)) last = idx;
    });
    return last;
  };
  const shortBody = await executeClaudeRequest(conversation(2), false);
  const longBody = await executeClaudeRequest(conversation(6), false);
  const shortMarked = lastMarked(shortBody);
  const longMarked = lastMarked(longBody);
  expect(shortMarked).toBeGreaterThan(0);
  expect(longMarked).toBeGreaterThan(shortMarked);
  expect(longMarked).toBe((JSON.parse(longBody).messages as unknown[]).length - 1);
  expect(has(longBody, "messages.0.content.1.cache_control")).toBe(true);
  expect(countCacheControls(longBody)).toBeLessThanOrEqual(4);
});

describe("TestEnsureCacheControlSkipsEmptyAndWhitespaceTextBlocks", () => {
  test("Message With Trailing Empty And Whitespace Text Blocks", () => {
    const out = ensureCacheControl(`{"model": "claude-sonnet-5", "messages": [{"role": "user", "content": [{"type": "text", "text": "Reply with exactly OK."}, {"type": "text", "text": ""}, {"type": "text", "text": "  \\n\\t "}]}]}`);
    expect(get(out, "messages.0.content.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "messages.0.content.1.cache_control") || has(out, "messages.0.content.2.cache_control")).toBe(false);
  });

  test("Trailing Message With Only Empty Text Falls Back To Earlier Message", () => {
    const out = ensureCacheControl(`{"model": "claude-sonnet-5", "messages": [{"role": "user", "content": [{"type": "text", "text": "Real question"}]}, {"role": "assistant", "content": [{"type": "text", "text": ""}]}, {"role": "user", "content": "   "}]}`);
    expect(get(out, "messages.0.content.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "messages.1.content.0.cache_control") || has(out, "messages.2.content.0.cache_control")).toBe(false);
  });

  test("System-Only Fallback Empty User Message Is Never Stamped", () => {
    const out = ensureCacheControl(`{"model": "claude-sonnet-5", "system": [{"type": "text", "text": "You are a helpful assistant."}], "messages": [{"role": "user", "content": [{"type": "text", "text": ""}]}]}`);
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "messages.0.content.0.cache_control")).toBe(false);
  });

  test("System Array With Trailing Empty Text Stamps Last Non-Empty Element", () => {
    const out = ensureCacheControl(`{"model": "claude-sonnet-5", "system": [{"type": "text", "text": "Valid system prompt"}, {"type": "text", "text": ""}, {"type": "text", "text": "   "}], "messages": [{"role": "user", "content": "Hi"}]}`);
    expect(get(out, "system.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "system.1.cache_control") || has(out, "system.2.cache_control")).toBe(false);
  });

  test("System Array With Only Empty Text Falls Back To Tools", () => {
    const out = ensureCacheControl(`{"model": "claude-sonnet-5", "system": [{"type": "text", "text": ""}, {"type": "text", "text": "   "}], "tools": [{"name": "tool1", "description": "Tool", "input_schema": {"type": "object"}}], "messages": [{"role": "user", "content": "Hi"}]}`);
    expect(get(out, "tools.0.cache_control.type")).toBe("ephemeral");
    expect(has(out, "system.0.cache_control") || has(out, "system.1.cache_control")).toBe(false);
  });

  test("Cloaking CurrentDate Injection Skips Empty Text Blocks", () => {
    const out = injectClaudeCodeCurrentDate(`{"model": "claude-sonnet-5", "messages": [{"role": "user", "content": [{"type": "text", "text": ""}, {"type": "text", "text": "Actual user prompt"}]}]}`, "2026-10-20");
    expect(has(out, "messages.0.content.1.cache_control")).toBe(false);
    expect(get(out, "messages.0.content.2.cache_control.type")).toBe("ephemeral");
  });
});
