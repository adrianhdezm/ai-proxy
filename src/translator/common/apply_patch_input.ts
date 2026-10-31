// Port of internal/translator/common/apply_patch_input.go.
//
// Decodes the input string of streamed apply_patch function arguments
// ({"input":"<patch>"}) fragment by fragment, emitting only complete,
// validated characters.
//
// Deviation: Go scanned UTF-8 bytes and held back incomplete multi-byte
// sequences. Fragments here are JS strings (UTF-16), so the only character a
// fragment boundary can split is a surrogate pair: a raw high surrogate is held
// back until its low surrogate arrives, and an unpaired raw surrogate is
// rejected the way Go rejected invalid UTF-8.

const enum Phase {
  BeforeObject,
  BeforeKey,
  InKey,
  BeforeColon,
  BeforeValue,
  InValue,
  AfterValue,
  Complete,
}

function isJSONSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** A decoder belongs to one call. Methods return Go-style [value, error] tuples. */
export class ApplyPatchInputDecoder {
  private phase: Phase = Phase.BeforeObject;
  private keyRaw = "";
  private escapeRaw = "";
  private rawPending = "";
  private highSurrogate = 0;
  private text = "";
  private finished = false;
  private err: Error | undefined;

  /** Scans each fragment once, returning the newly decoded input characters. */
  push(fragment: string): [string, Error | undefined] {
    if (this.err) return ["", this.err];
    if (this.finished) {
      if (fragment === "") return ["", undefined];
      return ["", this.fail(new Error("apply_patch arguments received after completion"))];
    }
    const start = this.text.length;
    for (let i = 0; i < fragment.length; i++) {
      const c = fragment.charCodeAt(i);
      switch (this.phase) {
        case Phase.BeforeObject:
          if (isJSONSpace(c)) continue;
          if (c !== 0x7b) return ["", this.fail(new Error("apply_patch arguments must be a JSON object"))];
          this.phase = Phase.BeforeKey;
          break;
        case Phase.BeforeKey:
          if (isJSONSpace(c)) continue;
          if (c !== 0x22) return ["", this.fail(new Error("apply_patch arguments must contain the input field"))];
          this.keyRaw += fragment[i];
          this.phase = Phase.InKey;
          break;
        case Phase.InKey: {
          this.keyRaw += fragment[i];
          if (this.escapeRaw !== "") {
            this.escapeRaw = "";
            continue;
          }
          if (c === 0x5c) {
            this.escapeRaw = "\\";
            continue;
          }
          if (c < 0x20) return ["", this.fail(new Error("invalid control character in apply_patch input key"))];
          if (c === 0x22) {
            let key: unknown;
            try {
              key = JSON.parse(this.keyRaw);
            } catch (e) {
              return ["", this.fail(new Error(`decode apply_patch input key: ${(e as Error).message}`))];
            }
            if (key !== "input") return ["", this.fail(new Error("apply_patch arguments must contain the input field"))];
            this.keyRaw = "";
            this.phase = Phase.BeforeColon;
          }
          break;
        }
        case Phase.BeforeColon:
          if (isJSONSpace(c)) continue;
          if (c !== 0x3a) return ["", this.fail(new Error("apply_patch input key must be followed by a colon"))];
          this.phase = Phase.BeforeValue;
          break;
        case Phase.BeforeValue:
          if (isJSONSpace(c)) continue;
          if (c !== 0x22) return ["", this.fail(new Error("apply_patch input must be a string"))];
          this.phase = Phase.InValue;
          break;
        case Phase.InValue: {
          const errConsume = this.consumeValue(c, fragment[i]!);
          if (errConsume) return ["", this.fail(errConsume)];
          break;
        }
        case Phase.AfterValue:
          if (isJSONSpace(c)) continue;
          if (c !== 0x7d) return ["", this.fail(new Error("apply_patch arguments must contain only one input field"))];
          this.phase = Phase.Complete;
          break;
        case Phase.Complete:
          if (!isJSONSpace(c)) return ["", this.fail(new Error("apply_patch arguments must not contain trailing JSON"))];
          break;
      }
    }
    return [this.text.slice(start), undefined];
  }

  private consumeValue(c: number, ch: string): Error | undefined {
    if (this.rawPending !== "" || c >= 0x80) {
      // Pending escapes and surrogate pairs cannot consume raw characters.
      if (this.escapeRaw !== "" || this.highSurrogate !== 0) return new Error("invalid Unicode escape in apply_patch input");
      if (this.rawPending !== "") {
        if (!isLowSurrogate(c)) return new Error("invalid UTF-8 in apply_patch input");
        this.text += this.rawPending + ch;
        this.rawPending = "";
        return undefined;
      }
      if (isHighSurrogate(c)) {
        this.rawPending = ch;
        return undefined;
      }
      if (isLowSurrogate(c)) return new Error("invalid UTF-8 in apply_patch input");
      this.text += ch;
      return undefined;
    }
    if (this.escapeRaw !== "") {
      this.escapeRaw += ch;
      if (this.escapeRaw.length === 2) {
        if (this.highSurrogate !== 0 && ch !== "u") return new Error("apply_patch input high surrogate requires a low surrogate");
        let decoded: string;
        switch (ch) {
          case "u":
            return undefined;
          case '"':
          case "\\":
          case "/":
            decoded = ch;
            break;
          case "b":
            decoded = "\b";
            break;
          case "f":
            decoded = "\f";
            break;
          case "n":
            decoded = "\n";
            break;
          case "r":
            decoded = "\r";
            break;
          case "t":
            decoded = "\t";
            break;
          default:
            return new Error("invalid escape in apply_patch input");
        }
        this.text += decoded;
        this.escapeRaw = "";
        return undefined;
      }
      if (hexValue(c) < 0) return new Error("invalid Unicode escape in apply_patch input");
      if (this.escapeRaw.length < 6) return undefined;
      let code = 0;
      for (let k = 2; k < 6; k++) code = (code << 4) | hexValue(this.escapeRaw.charCodeAt(k));
      this.escapeRaw = "";
      if (this.highSurrogate !== 0) {
        if (!isLowSurrogate(code)) return new Error("apply_patch input high surrogate requires a low surrogate");
        this.text += String.fromCharCode(this.highSurrogate, code);
        this.highSurrogate = 0;
      } else if (isHighSurrogate(code)) {
        this.highSurrogate = code;
      } else if (isLowSurrogate(code)) {
        return new Error("unpaired low surrogate in apply_patch input");
      } else {
        this.text += String.fromCharCode(code);
      }
      return undefined;
    }
    if (this.highSurrogate !== 0 && c !== 0x5c) return new Error("apply_patch input high surrogate requires a low surrogate");
    if (c === 0x5c) this.escapeRaw = "\\";
    else if (c === 0x22) this.phase = Phase.AfterValue;
    else if (c < 0x20) return new Error("invalid control character in apply_patch input");
    else this.text += ch;
    return undefined;
  }

  /** Validates the final wrapper and returns only the previously unsent suffix. */
  finish(args: string): [string, Error | undefined] {
    if (this.err) return ["", this.err];
    // The final snapshot needs the same strict character validation as streamed fragments.
    const final = new ApplyPatchInputDecoder();
    const [, errPush] = final.push(args);
    if (errPush) return ["", this.fail(errPush)];
    if (!final.complete()) return ["", this.fail(new Error("decode apply_patch arguments: unexpected end of JSON input"))];
    const input = final.input();
    if (this.finished) {
      if (input !== this.text) return ["", this.fail(new Error("conflicting apply_patch arguments completion"))];
      return ["", undefined];
    }
    if (!input.startsWith(this.text)) return ["", this.fail(new Error("final apply_patch input conflicts with streamed input"))];
    const tail = input.slice(this.text.length);
    this.text += tail;
    this.finished = true;
    this.phase = Phase.Complete;
    this.keyRaw = "";
    this.escapeRaw = "";
    this.rawPending = "";
    this.highSurrogate = 0;
    return [tail, undefined];
  }

  /** The decoded input, preserving its original whitespace. */
  input(): string {
    return this.text;
  }

  /** Whether the scanned arguments form a complete wrapper object. */
  complete(): boolean {
    return this.err === undefined && this.phase === Phase.Complete;
  }

  private fail(err: Error): Error {
    this.err = err;
    return err;
  }
}
