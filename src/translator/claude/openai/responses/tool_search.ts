// Port of internal/translator/claude/openai/responses/claude_openai-responses_tool_search.go.
//
// Codex declares client-executed tool search as {"type":"tool_search",
// "execution":"client"} and keeps deferred tools out of tools[]. The model
// calls it through a tool_search_call item, Codex runs the search locally and
// replays a tool_search_output item whose tools[] become callable from then on.
// Claude has no counterpart, so the declaration becomes an ordinary function
// tool, the call and output become a tool_use/tool_result pair, and every tool
// discovered in history is declared on later requests.
//
// With native tool search, discovered tools are declared with defer_loading
// and referenced through tool_reference blocks. Anthropic keeps the prompt
// cache when deferred tools are added, but not when a request goes from no
// deferred tool to one, so a constant deferred anchor is declared from the
// first request on and discoveries only append after it.
import type { TranslateContext } from "../../../types.ts";
import { sseEventData } from "../../../common/bytes.ts";
import { normalizeClaudeToolInputSchema } from "../../../../util/claude_schema.ts";
import { sanitizeClaudeToolID } from "../../../../util/claude_tool_id.ts";
import { getAt, gstr, isObj } from "../../../../util/gpath.ts";
import { tryParse } from "../../../../util/json.ts";
import {
  type ClaudeToolNames,
  type ResponsesToolDescriptor,
  appendResponsesToolDescriptors,
  responsesDiscoveredToolPriority,
  responsesToolDescription,
} from "./tools.ts";

type JSONObject = Record<string, unknown>;

/** Mirrors Codex's item id prefix for tool_search_call. */
export const responsesToolSearchIDPrefix = "tsc_";
/** Names the constant deferred tool declared with native tool search; nothing references it. */
export const responsesDeferredAnchorName = "tool_search_deferred_anchor";

// clientToolSearchEnabled mirrors upstream.claude.tool-search. While it is off
// the translator keeps the behaviour that predates tool_search support:
// tool_search declarations are generic tools and tool_search_call and
// tool_search_output items are unmapped.
let clientToolSearch = false;

/** Applies upstream.claude.tool-search (Go: SetClientToolSearchEnabled). */
export function setClientToolSearchEnabled(enabled: boolean): void {
  clientToolSearch = enabled;
}

/** Reports whether upstream.claude.tool-search is on (Go: ClientToolSearchEnabled). */
export function clientToolSearchEnabled(): boolean {
  return clientToolSearch;
}

/** TranslateContext.values key that pins upstream.claude.tool-search for one request. */
export const clientToolSearchContextKey = "claude.responses.clientToolSearch";

/**
 * Pins upstream.claude.tool-search for one request (Go: WithClientToolSearch),
 * so request and response translation agree even if the configuration is
 * reloaded while it runs. Returns a new context.
 */
export function withClientToolSearch(ctx: TranslateContext | undefined, enabled: boolean): TranslateContext {
  return { ...(ctx ?? {}), values: { ...(ctx?.values ?? {}), [clientToolSearchContextKey]: enabled } };
}

/** The value pinned in ctx, or the current setting when ctx carries none (Go: ClientToolSearchEnabledFor). */
export function clientToolSearchEnabledFor(ctx: TranslateContext | undefined): boolean {
  const pinned = ctx?.values?.[clientToolSearchContextKey];
  if (typeof pinned === "boolean") return pinned;
  return clientToolSearchEnabled();
}

const claudeToolSearchDefaultSchema = `{"type":"object","properties":{"query":{"type":"string","description":"Search query for deferred tools."},"limit":{"type":"number","description":"Maximum number of tools to return."}},"required":["query"],"additionalProperties":false}`;

function responsesDeferredAnchor(): JSONObject {
  return {
    name: responsesDeferredAnchorName,
    description: "Placeholder that is never loaded; tool search returns the real tools.",
    input_schema: { type: "object", properties: {} },
    defer_loading: true,
  };
}

/**
 * Returns the deferred anchor declaration, unless a converted tool already
 * carries its Claude name; on a clash the request keeps the client's tool and has no anchor.
 */
export function responsesDeferredAnchorTool(toolItems: JSONObject[]): JSONObject | undefined {
  for (const tool of toolItems) if (gstr(tool.name) === responsesDeferredAnchorName) return undefined;
  return responsesDeferredAnchor();
}

/** Keeps the client's declared schema but guarantees the required query field Codex parses. */
export function convertResponsesToolSearchToolToClaude(tool: unknown, claudeName: string): JSONObject {
  let schemaRaw = claudeToolSearchDefaultSchema;
  const parameters = getAt(tool, "parameters");
  if (isObj(parameters)) schemaRaw = normalizeClaudeToolInputSchema(JSON.stringify(parameters));
  const schema = JSON.parse(schemaRaw) as JSONObject;
  if (gstr(getAt(schema, "properties.query.type")) !== "string") {
    if (!isObj(schema.properties)) schema.properties = {};
    (schema.properties as JSONObject).query = { type: "string", description: "Search query for deferred tools." };
  }
  const required = Array.isArray(schema.required) ? schema.required : undefined;
  if (!required || !required.includes("query")) {
    if (required) required.push("query");
    else schema.required = ["query"];
  }
  return { name: claudeName, description: responsesToolDescription(tool), input_schema: schema };
}

/**
 * Replays a client tool_search_call as an assistant tool_use and returns it
 * with its raw call id. Hosted calls have no call id and return undefined.
 */
export function convertResponsesToolSearchCallToClaude(item: unknown, claudeName: string): { toolUse: JSONObject; callID: string } | undefined {
  const callID = gstr(getAt(item, "call_id")).trim();
  if (callID === "" || gstr(getAt(item, "execution")).trim() !== "client") return undefined;
  const toolUse: JSONObject = { type: "tool_use", id: sanitizeClaudeToolID(callID), name: claudeName, input: {} };
  let args = getAt(item, "arguments");
  if (typeof args === "string") args = tryParse<unknown>(args);
  if (isObj(args)) toolUse.input = args;
  return { toolUse, callID };
}

/** Summarizes discovered tools for the model; names suffice since full definitions are in tools[]. */
export function responsesToolSearchOutputText(item: unknown, names: ClaudeToolNames): string {
  const discovered = appendResponsesToolDescriptors([], getAt(item, "tools"), responsesDiscoveredToolPriority, true).map((d) => names.claudeName(d.name));
  if (discovered.length === 0) return "No matching tools were found.";
  return "Tools now available to call: " + discovered.join(", ") + ".";
}

/**
 * The tool_result content for a paired tool_search_output. With native tool
 * search it lists a tool_reference for each tool that only loads through search;
 * when none qualify, the text summary is used.
 */
export function responsesToolSearchOutputContent(
  item: unknown,
  names: ClaudeToolNames,
  winners: Map<string, ResponsesToolDescriptor>,
  nativeReferences: boolean,
): unknown {
  if (nativeReferences) {
    const references: JSONObject[] = [];
    const seen = new Set<string>();
    for (const descriptor of appendResponsesToolDescriptors([], getAt(item, "tools"), responsesDiscoveredToolPriority, true)) {
      const winner = winners.get(descriptor.name);
      if (!winner || winner.sourcePriority !== responsesDiscoveredToolPriority || (winner.toolType !== "function" && winner.toolType !== "custom")) continue;
      const claudeName = names.claudeName(descriptor.name);
      if (seen.has(claudeName)) continue;
      seen.add(claudeName);
      references.push({ type: "tool_reference", tool_name: claudeName });
    }
    if (references.length > 0) return references;
  }
  return responsesToolSearchOutputText(item, names);
}

function isJSONObject(raw: string): boolean {
  return isObj(tryParse<unknown>(raw));
}

/** Downgrades a completed call whose arguments are not a JSON object. */
export function toolSearchCallStatus(status: string, args: string): string {
  if (status === "completed" && !isJSONObject(args)) return "incomplete";
  return status;
}

/** Renders the tool_search_call item Codex parses: call_id, execution "client" and an arguments object. */
export function buildResponsesToolSearchCallItem(callID: string, status: string, args: string): JSONObject {
  const item: JSONObject = { id: responsesToolSearchIDPrefix + callID, type: "tool_search_call", status, call_id: callID, execution: "client", arguments: {} };
  const parsed = tryParse<unknown>(args);
  if (isObj(parsed)) item.arguments = parsed;
  return item;
}

/**
 * Wraps a tool_search_call item in an output_item event. Responses has no
 * argument delta events for it; Codex dispatches the search from output_item.done.
 */
export function toolSearchCallEvent(event: string, sequence: number, outputIndex: number, item: JSONObject): string {
  return sseEventData(event, JSON.stringify({ type: event, sequence_number: sequence, output_index: outputIndex, item }));
}
