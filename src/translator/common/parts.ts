// Port of internal/translator/common/parts.go.
import { RequestRejectedError } from "../types.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";

/**
 * A request-scoped rejection: the part type was present and this translation has
 * no equivalent, so the request must not be sent with that part removed.
 */
export class UnsupportedPartError extends RequestRejectedError {
  readonly type: string;
  constructor(type: string) {
    super(type === "" ? "unsupported content part" : `unsupported content part: ${type}`, 400);
    this.name = "UnsupportedPartError";
    this.type = type;
  }
  isRequestScoped(): boolean {
    return this.requestScoped;
  }
}

/**
 * Shared policy for a part a translation cannot send: a user turn left with nothing
 * to send is refused rather than forwarded empty. The decision is made per user turn.
 */
export class UserTurnDrops {
  private turn = "";
  private first = "";

  /** Records a part of the current user turn that cannot be sent (the first type recorded wins). */
  drop(partType: string): void {
    if (this.turn === "") this.turn = partType;
  }

  /** Closes the current user turn; `sendable` is the number of parts it contributed. */
  endTurn(sendable: number): void {
    if (this.turn !== "" && sendable <= 0 && this.first === "") this.first = this.turn;
    this.turn = "";
  }

  /** The refusal for the first emptied user turn, or undefined. */
  err(): UnsupportedPartError | undefined {
    if (this.first === "") return undefined;
    return new UnsupportedPartError(this.first);
  }
}

/**
 * Follows the consecutive user content that a target merges into one user turn.
 * All methods are safe to call on an undefined receiver via the static helpers.
 */
export class UserRun {
  private readonly drops = new UserTurnDrops();
  private sendable = 0;

  add(): void {
    this.sendable++;
  }
  drop(partType: string): void {
    this.drops.drop(partType);
  }
  end(): void {
    this.drops.endTurn(this.sendable);
    this.sendable = 0;
  }
  err(): UnsupportedPartError | undefined {
    return this.drops.err();
  }
}

/** Nil-receiver-safe helpers mirroring Go's no-op methods on a nil *UserRun. */
export const userRun = {
  add(run: UserRun | undefined): void {
    run?.add();
  },
  drop(run: UserRun | undefined, partType: string): void {
    run?.drop(partType);
  },
  end(run: UserRun | undefined): void {
    run?.end();
  },
  err(run: UserRun | undefined): UnsupportedPartError | undefined {
    return run?.err();
  },
};

/**
 * Whether an Interactions step carries developer or system content rather than user
 * content; a step that names neither role nor type inherits `inherited`.
 */
export function isInteractionsInstructionStep(step: unknown, inherited: boolean): boolean {
  let name = gstr(getAt(step, "role")).trim().toLowerCase();
  if (name === "") name = gstr(getAt(step, "type")).trim().toLowerCase();
  switch (name) {
    case "developer":
    case "system":
      return true;
    case "user":
    case "assistant":
    case "model":
    case "model_output":
    case "thought":
      return false;
  }
  return inherited;
}

/** Names the attachment type of an Interactions content part, or "" for text and unnamed parts. */
export function interactionsAttachmentType(part: unknown): string {
  if (!isObj(part)) return "";
  const partType = gstr(part.type).trim().toLowerCase();
  if (partType !== "") return partType === "text" ? "" : partType;
  if (part.inlineData !== undefined || part.inline_data !== undefined) return "inlineData";
  if (part.fileData !== undefined || part.file_data !== undefined) return "fileData";
  return "";
}

/** Whether a Gemini part gives the model something to read (blank text does not). */
export function geminiPartIsSendable(part: unknown): boolean {
  const text = getAt(part, "text");
  if (text === undefined || gstr(text).trim() !== "") return true;
  for (const key of ["functionCall", "functionResponse", "inlineData", "inline_data", "fileData", "file_data"]) {
    if (getAt(part, key) !== undefined) return true;
  }
  return false;
}

export function countSendableGeminiParts(parts: unknown[]): number {
  return parts.filter(geminiPartIsSendable).length;
}

/** Whether value is an absolute http or https URL with a host. */
export function isHTTPURL(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.host === "") return false;
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
