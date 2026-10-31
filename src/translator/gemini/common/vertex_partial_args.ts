// Port of internal/translator/common/vertex_partial_args.go.
//
// The shared common port (src/translator/common) skipped this helper; the Gemini
// Claude response translator needs it for Vertex streaming functionCall.partialArgs,
// so it lives in the Gemini translator's own common module. gjson Results are
// replaced by parsed JSON values.
import { gbool, getAt, gstr, isObj } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";

const maxVertexPartialArgsArrayIndex = 1024;
const maxVertexPartialArgsDepth = 64;
const maxVertexPartialArgsOutputSize = 4 * 1024 * 1024;

type PathSegment = { kind: "key"; key: string } | { kind: "index"; index: number };

const NodeUnset = 0;
const NodeObject = 1;
const NodeArray = 2;
const NodeString = 3;
const NodeScalar = 4;
type NodeKind = typeof NodeUnset | typeof NodeObject | typeof NodeArray | typeof NodeString | typeof NodeScalar;

class VertexASTNode {
  kind: NodeKind = NodeUnset;

  // Object state
  keys: string[] = [];
  children = new Map<string, VertexASTNode>();
  objNextIdx = 0;

  // Array state
  elements = new Map<number, VertexASTNode>();
  maxIdx = -1;
  arrNextIdx = 0;

  // String state
  strBuf = "";
  strEmitted = 0;
  strOpened = false;
  strClosed = false;
  stringOpen = false;

  // Scalar state
  scalarRaw = "";
  scalarEmitted = false;

  holdUntilFinish = false;

  // Container emission state
  containerOpened = false;
  containerClosed = false;
  commaEmitted = new Set<number>();
}

function newContainerNode(kind: NodeKind): VertexASTNode {
  const node = new VertexASTNode();
  node.kind = kind;
  return node;
}

function pick(a: unknown, b: unknown): unknown {
  return a !== undefined ? a : b;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Reports whether a Gemini/Vertex functionCall object uses streaming arguments (partialArgs or willContinue). */
export function isVertexStreamingFunctionCall(fc: unknown): boolean {
  if (!isObj(fc)) return false;
  const partialArgs = pick(fc.partialArgs, fc.partial_args);
  if (partialArgs !== undefined) {
    if (Array.isArray(partialArgs) && partialArgs.length === 0 && fc.args !== undefined && !vertexFunctionCallWillContinue(fc)) return false;
    return true;
  }
  if (fc.willContinue !== undefined || fc.will_continue !== undefined) {
    if (fc.args !== undefined && !vertexFunctionCallWillContinue(fc)) return false;
    return true;
  }
  return false;
}

/** Reports whether a functionCall chunk indicates that subsequent chunks follow for the same call. */
export function vertexFunctionCallWillContinue(fc: unknown): boolean {
  return gbool(getAt(fc, "willContinue")) || gbool(getAt(fc, "will_continue"));
}

/**
 * Incrementally reconstructs a JSON value from Vertex AI streaming
 * functionCall.partialArgs fragments and emits valid JSON deltas that can be
 * concatenated directly by downstream Claude clients.
 */
export class VertexPartialArgsAssembler {
  private root: VertexASTNode | undefined;
  private lastStringNode: VertexASTNode | undefined;
  private cleaner: ((raw: string) => string) | undefined;
  private closedEmptyCache: Map<string, boolean> | undefined;
  private fullBuf = "";
  private bufferedBytes = 0;
  private error: Error | undefined;

  /**
   * Configures an optional JSON argument cleaner (such as Claude schema placeholder
   * stripping) applied before potentially removable placeholder fields ("reason",
   * "_", or closed empty object fields) are emitted.
   */
  setArgumentCleaner(cleaner: ((raw: string) => string) | undefined): void {
    this.cleaner = cleaner;
    if (cleaner && !this.closedEmptyCache) this.closedEmptyCache = new Map();
  }

  /** The first structural or limits error encountered while assembling partialArgs. */
  err(): Error | undefined {
    return this.error;
  }

  private setError(message: string): void {
    if (!this.error) this.error = new Error(message);
  }

  /** Processes one functionCall chunk; returns the newly emitted JSON delta and whether the call completed cleanly. */
  pushFunctionCall(fc: unknown): [string, boolean] {
    if (this.error) return ["", false];
    const startLen = this.fullBuf.length;
    const outerWillContinue = vertexFunctionCallWillContinue(fc);

    const partialArgs = pick(getAt(fc, "partialArgs"), getAt(fc, "partial_args"));
    if (partialArgs !== undefined) {
      if (!Array.isArray(partialArgs)) {
        this.setError("vertex partialArgs must be an array");
        return ["", false];
      }
      for (const item of partialArgs) {
        this.pushPartialArg(item);
        if (this.error) return ["", false];
      }
    }
    if (!outerWillContinue && this.root === undefined && this.fullBuf.length === 0) {
      const args = getAt(fc, "args");
      if (isObj(args)) {
        let raw = JSON.stringify(args).trim();
        if (raw !== "") {
          if (this.cleaner) raw = this.cleaner(raw);
          if (!this.writeString(raw)) return ["", false];
          return [this.fullBuf.slice(startLen), true];
        }
      }
    }

    if (this.root !== undefined) {
      if (!outerWillContinue && this.cleaner && this.hasHeldNodes(this.root)) {
        const cleaned = this.cleaner(this.serializeNode(this.root));
        const parsed = tryParse<unknown>(cleaned);
        if (parsed !== undefined) this.pruneHeldNodes(this.root, parsed);
        else this.clearHeldFlags(this.root);
      }
      this.emitNode(this.root, !outerWillContinue);
      if (this.error) return ["", false];
    } else if (!outerWillContinue && this.fullBuf.length === 0) {
      if (!this.writeString("{}")) return ["", false];
    }

    return [this.fullBuf.slice(startLen), !outerWillContinue];
  }

  /** The concatenated JSON arguments emitted so far. */
  fullArguments(): string {
    return this.fullBuf.length === 0 ? "{}" : this.fullBuf;
  }

  private reserveBuffered(n: number): boolean {
    if (n < 0 || this.bufferedBytes + n > maxVertexPartialArgsOutputSize) {
      this.setError("vertex partialArgs output size limit exceeded");
      return false;
    }
    this.bufferedBytes += n;
    return true;
  }

  private writeString(s: string): boolean {
    if (this.fullBuf.length + s.length > maxVertexPartialArgsOutputSize) {
      this.setError("vertex partialArgs output size limit exceeded");
      return false;
    }
    this.fullBuf += s;
    return true;
  }

  private findNode(segments: PathSegment[]): VertexASTNode | undefined {
    let curr = this.root;
    for (const seg of segments) {
      if (!curr) return undefined;
      if (seg.kind === "key") {
        if (curr.kind !== NodeObject) return undefined;
        curr = curr.children.get(seg.key);
      } else {
        if (curr.kind !== NodeArray) return undefined;
        curr = curr.elements.get(seg.index);
      }
    }
    return curr;
  }

  private pushPartialArg(item: unknown): void {
    if (!isObj(item)) {
      this.setError("vertex partialArgs element must be an object");
      return;
    }

    const hasPathField = item.jsonPath !== undefined || item.json_path !== undefined;
    const rawPath = item.jsonPath !== undefined ? gstr(item.jsonPath) : gstr(item.json_path);

    let segments: PathSegment[] = [];
    if (hasPathField) {
      const parsed = parseVertexJSONPath(rawPath);
      if (parsed === undefined) {
        this.setError(`invalid vertex partialArgs jsonPath: ${JSON.stringify(rawPath)}`);
        return;
      }
      segments = parsed;
    }

    const innerWillContinue = gbool(item.willContinue) || gbool(item.will_continue);

    const strRes = pick(item.stringValue, item.string_value);
    const numRes = pick(item.numberValue, item.number_value);
    const boolRes = pick(item.boolValue, item.bool_value);
    const nullRes = pick(item.nullValue, item.null_value);

    const hasString = strRes !== undefined && strRes !== null;
    const hasNumber = numRes !== undefined && numRes !== null;
    const hasBool = boolRes !== undefined && boolRes !== null;
    const hasNull = nullRes !== undefined && !hasString && !hasNumber && !hasBool;
    const hasAnyValue = hasString || hasNumber || hasBool || hasNull;

    // Valueless end marker (e.g. {"jsonPath":"$.city"} or {"jsonPath":"$.city","willContinue":false}).
    if (!hasAnyValue && !innerWillContinue) {
      if (segments.length === 0) {
        if (this.lastStringNode && this.lastStringNode.stringOpen) this.lastStringNode.stringOpen = false;
        return;
      }
      const node = this.findNode(segments);
      if (node && node.kind === NodeString && node.stringOpen) node.stringOpen = false;
      return;
    }

    if (segments.length === 0) {
      this.setError("vertex partialArgs value requires non-empty jsonPath");
      return;
    }

    const rootKind: NodeKind = segments[0]!.kind === "index" ? NodeArray : NodeObject;
    if (this.root === undefined) {
      this.root = newContainerNode(rootKind);
    } else if (this.root.kind !== rootKind) {
      this.setError("conflicting root container type in vertex partialArgs");
      return;
    }

    let curr = this.root;
    for (let k = 0; k < segments.length - 1; k++) {
      if (curr.containerClosed) {
        this.setError(`cannot modify closed container in vertex partialArgs: ${JSON.stringify(rawPath)}`);
        return;
      }
      const seg = segments[k]!;
      const wantChildKind: NodeKind = segments[k + 1]!.kind === "index" ? NodeArray : NodeObject;
      let child: VertexASTNode | undefined;
      if (seg.kind === "key") {
        if (curr.kind !== NodeObject) {
          this.setError(`expected object container in vertex partialArgs: ${JSON.stringify(rawPath)}`);
          return;
        }
        child = curr.children.get(seg.key);
        if (!child) {
          if (!this.reserveBuffered(seg.key.length + 4)) return;
          child = newContainerNode(wantChildKind);
          child.holdUntilFinish = this.shouldHoldObjectKey(segments.slice(0, k), seg.key);
          this.insertObjectChild(curr, seg.key, child);
        }
      } else {
        if (curr.kind !== NodeArray) {
          this.setError(`expected array container in vertex partialArgs: ${JSON.stringify(rawPath)}`);
          return;
        }
        if (seg.index < curr.arrNextIdx && !curr.elements.has(seg.index)) {
          this.setError(`array index ${seg.index} already emitted in vertex partialArgs: ${JSON.stringify(rawPath)}`);
          return;
        }
        child = curr.elements.get(seg.index);
        if (!child) {
          if (!this.reserveBuffered(4)) return;
          child = newContainerNode(wantChildKind);
          curr.elements.set(seg.index, child);
          if (seg.index > curr.maxIdx) curr.maxIdx = seg.index;
        }
      }
      if (child.kind !== wantChildKind) {
        this.setError(`conflicting node type in vertex partialArgs: ${JSON.stringify(rawPath)}`);
        return;
      }
      curr = child;
    }

    if (curr.containerClosed) {
      this.setError(`cannot modify closed container in vertex partialArgs: ${JSON.stringify(rawPath)}`);
      return;
    }

    const leafSeg = segments[segments.length - 1]!;
    let leaf: VertexASTNode | undefined;
    if (leafSeg.kind === "key") {
      if (curr.kind !== NodeObject) {
        this.setError(`expected object container at leaf in vertex partialArgs: ${JSON.stringify(rawPath)}`);
        return;
      }
      leaf = curr.children.get(leafSeg.key);
      if (!leaf) {
        if (!this.reserveBuffered(leafSeg.key.length + 4)) return;
        leaf = new VertexASTNode();
        leaf.holdUntilFinish = this.shouldHoldObjectKey(segments.slice(0, segments.length - 1), leafSeg.key);
        this.insertObjectChild(curr, leafSeg.key, leaf);
      }
    } else {
      if (curr.kind !== NodeArray) {
        this.setError(`expected array container at leaf in vertex partialArgs: ${JSON.stringify(rawPath)}`);
        return;
      }
      if (leafSeg.index < curr.arrNextIdx && !curr.elements.has(leafSeg.index)) {
        this.setError(`array index ${leafSeg.index} already emitted in vertex partialArgs: ${JSON.stringify(rawPath)}`);
        return;
      }
      leaf = curr.elements.get(leafSeg.index);
      if (!leaf) {
        if (!this.reserveBuffered(4)) return;
        leaf = new VertexASTNode();
        curr.elements.set(leafSeg.index, leaf);
        if (leafSeg.index > curr.maxIdx) curr.maxIdx = leafSeg.index;
      }
    }

    if (hasString || innerWillContinue) {
      if (leaf.kind === NodeUnset) {
        leaf.kind = NodeString;
        leaf.stringOpen = true;
      } else if (leaf.kind !== NodeString || leaf.strClosed || !leaf.stringOpen) {
        this.setError(`cannot append to completed value at ${JSON.stringify(rawPath)}`);
        return;
      }
      const strVal = hasString ? gstr(strRes) : "";
      if (!this.reserveBuffered(strVal.length)) return;
      leaf.strBuf += escapeJSONStringContent(strVal);
      leaf.stringOpen = innerWillContinue;
      this.lastStringNode = leaf;
    } else if (hasNumber) {
      if (leaf.kind !== NodeUnset) {
        this.setError(`cannot overwrite existing value at ${JSON.stringify(rawPath)}`);
        return;
      }
      const numRaw = formatVertexJSONNumber(numRes);
      if (!this.reserveBuffered(numRaw.length)) return;
      leaf.kind = NodeScalar;
      leaf.scalarRaw = numRaw;
    } else if (hasBool) {
      if (leaf.kind !== NodeUnset) {
        this.setError(`cannot overwrite existing value at ${JSON.stringify(rawPath)}`);
        return;
      }
      leaf.kind = NodeScalar;
      leaf.scalarRaw = gbool(boolRes) ? "true" : "false";
    } else if (hasNull) {
      if (leaf.kind !== NodeUnset) {
        this.setError(`cannot overwrite existing value at ${JSON.stringify(rawPath)}`);
        return;
      }
      leaf.kind = NodeScalar;
      leaf.scalarRaw = "null";
    }
  }

  private insertObjectChild(curr: VertexASTNode, key: string, child: VertexASTNode): void {
    curr.children.set(key, child);
    if (!child.holdUntilFinish) {
      let insertAt = curr.keys.length;
      for (let i = curr.objNextIdx; i < curr.keys.length; i++) {
        const existing = curr.children.get(curr.keys[i]!);
        if (existing && existing.holdUntilFinish) {
          insertAt = i;
          break;
        }
      }
      if (insertAt < curr.keys.length) {
        curr.keys.splice(insertAt, 0, key);
        return;
      }
    }
    curr.keys.push(key);
  }

  private shouldHoldObjectKey(parentPath: PathSegment[], key: string): boolean {
    if (!this.cleaner) return false;
    const probeKey = key === "reason" || key === "_" ? key : "__cpa_probe__";
    return this.isKeyRemovedByCleaner(parentPath, probeKey);
  }

  private isKeyRemovedByCleaner(path: PathSegment[], probeKey: string): boolean {
    if (!this.cleaner) return false;
    let cacheKey = "$";
    for (const seg of path) {
      if (seg.kind === "index") cacheKey += "[]";
      else cacheKey += "{" + seg.key.length + ":" + seg.key + "}";
    }
    cacheKey += "/" + probeKey.length + ":" + probeKey;
    const cached = this.closedEmptyCache?.get(cacheKey);
    if (cached !== undefined) return cached;
    const probeJSON = buildSegmentProbeJSON(path, probeKey);
    const cleaned = this.cleaner(probeJSON);
    let removed = false;
    const parsed = tryParse<unknown>(cleaned);
    if (parsed !== undefined) removed = !segmentProbeKeyExists(parsed, path, probeKey);
    this.closedEmptyCache?.set(cacheKey, removed);
    return removed;
  }

  private hasHeldNodes(n: VertexASTNode | undefined): boolean {
    if (!n) return false;
    if (n.holdUntilFinish) return true;
    if (n.kind === NodeObject) {
      for (const k of n.keys) if (this.hasHeldNodes(n.children.get(k))) return true;
    } else if (n.kind === NodeArray) {
      for (let i = 0; i <= n.maxIdx; i++) if (this.hasHeldNodes(n.elements.get(i))) return true;
    }
    return false;
  }

  private clearHeldFlags(n: VertexASTNode | undefined): void {
    if (!n) return;
    n.holdUntilFinish = false;
    for (const k of n.keys) this.clearHeldFlags(n.children.get(k));
    for (let i = 0; i <= n.maxIdx; i++) this.clearHeldFlags(n.elements.get(i));
  }

  private serializeNode(n: VertexASTNode | undefined): string {
    if (!n) return "null";
    switch (n.kind) {
      case NodeObject: {
        let out = "{";
        n.keys.forEach((k, i) => {
          if (i > 0) out += ",";
          out += '"' + escapeJSONStringContent(k) + '":' + this.serializeNode(n.children.get(k));
        });
        return out + "}";
      }
      case NodeArray: {
        let out = "[";
        for (let i = 0; i <= n.maxIdx; i++) {
          if (i > 0) out += ",";
          out += this.serializeNode(n.elements.get(i));
        }
        return out + "]";
      }
      case NodeString:
        return '"' + n.strBuf + '"';
      case NodeScalar:
        return n.scalarRaw === "" ? "null" : n.scalarRaw;
      default:
        return "null";
    }
  }

  private pruneHeldNodes(n: VertexASTNode | undefined, cleaned: unknown): void {
    if (!n) return;
    if (n.kind === NodeObject) {
      const cleanedMap = isObj(cleaned) ? cleaned : {};
      const kept = n.keys.slice(0, n.objNextIdx);
      for (let i = n.objNextIdx; i < n.keys.length; i++) {
        const k = n.keys[i]!;
        const child = n.children.get(k);
        if (!child) continue;
        const exists = hasOwn(cleanedMap, k);
        if (child.holdUntilFinish && !exists) {
          n.children.delete(k);
          continue;
        }
        child.holdUntilFinish = false;
        this.pruneHeldNodes(child, cleanedMap[k]);
        kept.push(k);
      }
      n.keys = kept;
    } else if (n.kind === NodeArray) {
      const cleanedArr = Array.isArray(cleaned) ? cleaned : [];
      for (let i = 0; i <= n.maxIdx; i++) {
        const elem = n.elements.get(i);
        if (!elem) continue;
        elem.holdUntilFinish = false;
        this.pruneHeldNodes(elem, i < cleanedArr.length ? cleanedArr[i] : undefined);
      }
    }
  }

  private emitNode(node: VertexASTNode | undefined, final: boolean): boolean {
    if (this.error || !node || node.holdUntilFinish) return false;
    switch (node.kind) {
      case NodeString: {
        if (!node.strOpened) {
          if (!this.writeString('"')) return false;
          node.strOpened = true;
        }
        if (node.strEmitted < node.strBuf.length) {
          if (!this.writeString(node.strBuf.slice(node.strEmitted))) return false;
          node.strEmitted = node.strBuf.length;
        }
        if (node.stringOpen && !final) return false;
        if (!node.strClosed) {
          if (!this.writeString('"')) return false;
          node.strClosed = true;
          node.stringOpen = false;
        }
        return true;
      }
      case NodeScalar: {
        if (!node.scalarEmitted) {
          if (!this.writeString(node.scalarRaw)) return false;
          node.scalarEmitted = true;
        }
        return true;
      }
      case NodeObject: {
        if (node.containerClosed) return true;
        if (!node.containerOpened) {
          if (!final && node.keys.length > 0) {
            const first = node.children.get(node.keys[0]!);
            if (first && first.holdUntilFinish) return false;
          }
          if (!this.writeString("{")) return false;
          node.containerOpened = true;
        }
        while (node.objNextIdx < node.keys.length) {
          const idx = node.objNextIdx;
          const key = node.keys[idx]!;
          const child = node.children.get(key);
          if (child && child.holdUntilFinish) return false;
          if (!node.commaEmitted.has(idx)) {
            if (idx > 0 && !this.writeString(",")) return false;
            if (!this.writeString('"' + escapeJSONStringContent(key) + '":')) return false;
            node.commaEmitted.add(idx);
          }
          if (!this.emitNode(child, final)) return false;
          node.objNextIdx++;
        }
        if (!final) return false;
        if (!this.writeString("}")) return false;
        node.containerClosed = true;
        return true;
      }
      case NodeArray: {
        if (node.containerClosed) return true;
        if (!node.containerOpened) {
          if (!this.writeString("[")) return false;
          node.containerOpened = true;
        }
        while (node.arrNextIdx <= node.maxIdx) {
          const idx = node.arrNextIdx;
          const elem = node.elements.get(idx);
          if (!elem) {
            if (!final) return false;
            if (!node.commaEmitted.has(idx)) {
              if (idx > 0 && !this.writeString(",")) return false;
              if (!this.writeString("null")) return false;
              node.commaEmitted.add(idx);
            }
            node.arrNextIdx++;
            continue;
          }
          if (!node.commaEmitted.has(idx)) {
            if (idx > 0 && !this.writeString(",")) return false;
            node.commaEmitted.add(idx);
          }
          if (!this.emitNode(elem, final)) return false;
          node.arrNextIdx++;
        }
        if (!final) return false;
        if (!this.writeString("]")) return false;
        node.containerClosed = true;
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Reports whether fc's partialArgs can continue the current in-progress argument
   * tree without overwriting any already-completed leaf value.
   */
  canAcceptContinuation(fc: unknown): boolean {
    if (this.error) return false;
    const partialArgs = pick(getAt(fc, "partialArgs"), getAt(fc, "partial_args"));
    if (partialArgs === undefined) return true;
    if (!Array.isArray(partialArgs)) return false;
    for (const item of partialArgs) {
      if (!isObj(item)) return false;
      const hasPathField = item.jsonPath !== undefined || item.json_path !== undefined;
      if (!hasPathField) continue;
      const rawPath = item.jsonPath !== undefined ? gstr(item.jsonPath) : gstr(item.json_path);
      const segments = parseVertexJSONPath(rawPath);
      if (segments === undefined || segments.length === 0) continue;
      const node = this.findNode(segments);
      if (!node || node.kind === NodeUnset) continue;
      const innerWillContinue = gbool(item.willContinue) || gbool(item.will_continue);
      const strRes = pick(item.stringValue, item.string_value);
      const numRes = pick(item.numberValue, item.number_value);
      const boolRes = pick(item.boolValue, item.bool_value);
      const nullRes = pick(item.nullValue, item.null_value);
      const hasString = strRes !== undefined && strRes !== null;
      const hasNumber = numRes !== undefined && numRes !== null;
      const hasBool = boolRes !== undefined && boolRes !== null;
      const hasNull = nullRes !== undefined && !hasString && !hasNumber && !hasBool;
      const hasAnyValue = hasString || hasNumber || hasBool || hasNull;
      if (!hasAnyValue && !innerWillContinue) continue;
      if (hasString || innerWillContinue) {
        if (node.kind !== NodeString || node.strClosed || !node.stringOpen) return false;
        continue;
      }
      return false;
    }
    return true;
  }
}

/** Creates a new assembler for a single streaming function call. */
export function newVertexPartialArgsAssembler(): VertexPartialArgsAssembler {
  return new VertexPartialArgsAssembler();
}

function buildSegmentProbeJSON(path: PathSegment[], probeKey: string): string {
  let inner = '{"' + probeKey + '":1}';
  for (let i = path.length - 1; i >= 0; i--) {
    const seg = path[i]!;
    if (seg.kind === "index") inner = "[" + inner + "]";
    else inner = '{"' + escapeJSONStringContent(seg.key) + '":' + inner + "}";
  }
  return inner;
}

function segmentProbeKeyExists(cur: unknown, path: PathSegment[], probeKey: string): boolean {
  for (const seg of path) {
    if (seg.kind === "index") {
      const arr = Array.isArray(cur) ? cur : [];
      if (arr.length === 0) return false;
      cur = arr[0];
    } else {
      if (!isObj(cur) || !hasOwn(cur, seg.key)) return false;
      cur = cur[seg.key];
    }
  }
  return isObj(cur) && hasOwn(cur, probeKey);
}

function formatVertexJSONNumber(res: unknown): string {
  if (typeof res === "number") {
    const s = String(res);
    if (!s.includes("e")) return s;
    return formatFloatF(res);
  }
  if (typeof res === "string") {
    const s = res.trim();
    if (s !== "" && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return s;
    const n = Number(s);
    return formatFloatF(Number.isFinite(n) ? n : 0);
  }
  if (typeof res === "boolean") return res ? "1" : "0";
  return "0";
}

function formatFloatF(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

const hexDigits = "0123456789abcdef";

/** Appends s to a JSON string literal body, escaping as encoding/json would for the control set. */
export function escapeJSONStringContent(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = c.charCodeAt(0);
        if (code < 0x20) out += "\\u00" + hexDigits[code >> 4] + hexDigits[code & 0x0f];
        else out += c;
      }
    }
  }
  return out;
}

function parseHex4(s: string): number | undefined {
  if (s.length < 4) return undefined;
  let val = 0;
  for (let i = 0; i < 4; i++) {
    const c = s.charCodeAt(i);
    val <<= 4;
    if (c >= 0x30 && c <= 0x39) val |= c - 0x30;
    else if (c >= 0x61 && c <= 0x66) val |= c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) val |= c - 0x41 + 10;
    else return undefined;
  }
  return val;
}

/** Parses a Vertex partialArgs jsonPath ("$.a.b[0]['key']"); undefined when invalid. */
export function parseVertexJSONPath(rawPath: string): PathSegment[] | undefined {
  let s = rawPath.trim();
  if (s === "" || s === "$") return [];
  if (!s.startsWith("$")) return undefined;
  s = s.slice(1);
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < s.length) {
    if (segments.length >= maxVertexPartialArgsDepth) return undefined;
    const ch = s[i]!;
    if (ch === ".") {
      i++;
      if (i >= s.length) return undefined;
      const start = i;
      while (i < s.length && s[i] !== "." && s[i] !== "[") {
        if (s.charCodeAt(i) < 0x20) return undefined;
        i++;
      }
      if (i === start) return undefined;
      segments.push({ kind: "key", key: s.slice(start, i) });
    } else if (ch === "[") {
      i++;
      if (i >= s.length) return undefined;
      if (s[i] === "'" || s[i] === '"') {
        const quote = s[i];
        i++;
        let keyBuf = "";
        let closed = false;
        while (i < s.length) {
          const c = s[i]!;
          i++;
          if (c === "\\") {
            if (i >= s.length) return undefined;
            const esc = s[i]!;
            i++;
            switch (esc) {
              case '"':
              case "'":
              case "\\":
              case "/":
                keyBuf += esc;
                break;
              case "n":
                keyBuf += "\n";
                break;
              case "r":
                keyBuf += "\r";
                break;
              case "t":
                keyBuf += "\t";
                break;
              case "b":
                keyBuf += "\b";
                break;
              case "f":
                keyBuf += "\f";
                break;
              case "u": {
                const r1 = parseHex4(s.slice(i, i + 4));
                if (r1 === undefined) return undefined;
                i += 4;
                if (r1 >= 0xd800 && r1 <= 0xdbff) {
                  if (i + 6 > s.length || s[i] !== "\\" || s[i + 1] !== "u") return undefined;
                  const r2 = parseHex4(s.slice(i + 2, i + 6));
                  if (r2 === undefined || r2 < 0xdc00 || r2 > 0xdfff) return undefined;
                  i += 6;
                  keyBuf += String.fromCharCode(r1, r2);
                } else if (r1 >= 0xdc00 && r1 <= 0xdfff) {
                  return undefined;
                } else {
                  keyBuf += String.fromCharCode(r1);
                }
                break;
              }
              default:
                return undefined;
            }
            continue;
          }
          if (c.charCodeAt(0) < 0x20) return undefined;
          if (c === quote) {
            closed = true;
            break;
          }
          keyBuf += c;
        }
        if (!closed || i >= s.length || s[i] !== "]") return undefined;
        i++;
        segments.push({ kind: "key", key: keyBuf });
      } else {
        const start = i;
        let idxVal = 0;
        while (i < s.length && s[i]! >= "0" && s[i]! <= "9") {
          const digit = s.charCodeAt(i) - 0x30;
          if (idxVal > Math.floor((maxVertexPartialArgsArrayIndex - digit) / 10)) return undefined;
          idxVal = idxVal * 10 + digit;
          i++;
        }
        if (i === start || i >= s.length || s[i] !== "]") return undefined;
        i++;
        segments.push({ kind: "index", index: idxVal });
      }
    } else {
      return undefined;
    }
  }
  return segments;
}

/** Tracks an in-progress Vertex streaming function call across SSE chunks. */
export class VertexStreamingToolCall {
  readonly assembler: VertexPartialArgsAssembler;
  constructor(
    public rawName: string,
    public name: string,
    public upstreamID: string,
    public id: string,
    public index: number,
  ) {
    this.assembler = new VertexPartialArgsAssembler();
  }

  /** Reports whether fc belongs to this in-progress streaming tool call. */
  canContinueWith(fc: unknown): boolean {
    if (!isObj(fc)) return false;
    if (fc.args !== undefined && !isVertexStreamingFunctionCall(fc)) return false;
    const fcID = gstr(fc.id).trim();
    if (fcID !== "" && this.upstreamID !== "" && fcID !== this.upstreamID) return false;
    const rawName = gstr(fc.name).trim();
    if (rawName === "") return true;
    if (rawName !== this.rawName) return false;
    if (fcID !== "" && this.upstreamID !== "" && fcID === this.upstreamID) return true;
    return this.assembler.canAcceptContinuation(fc);
  }
}

/** Creates a new active streaming tool call tracker. */
export function newVertexStreamingToolCall(rawName: string, name: string, upstreamID: string, id: string, index: number): VertexStreamingToolCall {
  return new VertexStreamingToolCall(rawName, name, upstreamID, id, index);
}
