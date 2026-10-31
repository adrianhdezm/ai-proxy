// File-backed token store. Port of sdk/auth/filestore.go (plugin parsers and
// the Codex refresh-patch merge dropped). Credentials live as `*.json`
// documents under a base directory; nested directories are scanned too.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { AttributePath, AttributeSource, AttributeSourceBackend, AuthSourceFile, type Auth } from "../auth/types.ts";
import { log } from "../log.ts";
import type { TokenStore } from "./types.ts";
import { authFromStoredRecord, jsonEqual, recordFromAuth, validateAuthWeight, type PersistingTokenStore, type SaveOptions } from "./record.ts";

export interface FileTokenStoreOptions {
  /** Directory holding the auth JSON files (created on first save). */
  baseDir: string;
}

export class FileTokenStore implements TokenStore, PersistingTokenStore {
  readonly kind = "file";
  private baseDir: string;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(options: FileTokenStoreOptions) {
    this.baseDir = options.baseDir.trim();
  }

  /** Updates the directory used when an auth carries no explicit path. */
  setBaseDir(dir: string): void {
    this.baseDir = dir.trim();
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Persists the auth document to its file. Returns the file path, or "" when
   * a disabled credential whose file no longer exists was not recreated.
   */
  async save(auth: Auth, options: SaveOptions = {}): Promise<string> {
    validateAuthWeight(auth);
    const path = this.resolveAuthPath(auth);
    if (auth.disabled && !options.createDisabled && !exists(path)) return "";

    // Serialise writers so two refreshes never interleave on the same file.
    const run = this.saving.then(() => this.writeDocument(path, auth));
    this.saving = run.catch(() => undefined);
    await run;

    auth.attributes[AttributePath] = path;
    auth.attributes[AttributeSource] = path;
    auth.attributes[AttributeSourceBackend] = AuthSourceFile;
    return path;
  }

  private writeDocument(path: string, auth: Auth): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const document = recordFromAuth(auth);
    const raw = JSON.stringify(document);
    if (exists(path)) {
      let existing: unknown;
      try {
        existing = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        existing = undefined;
      }
      if (existing !== undefined && jsonEqual(existing, document)) return;
    }
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, raw, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best effort on file systems without POSIX modes.
    }
    renameSync(tmp, path);
  }

  /** Enumerates every auth JSON file under the base directory (lexical order). */
  async list(): Promise<Auth[]> {
    const dir = this.baseDir;
    if (dir === "") throw new Error("auth filestore: directory not configured");
    if (!exists(dir)) return [];
    const files: string[] = [];
    walk(dir, files);
    files.sort();
    const entries: Auth[] = [];
    for (const path of files) {
      const auth = this.readAuthFile(path, dir);
      if (auth) entries.push(auth);
    }
    return entries;
  }

  /** Removes the file for the given id (relative to the base dir unless it is a path). */
  async delete(id: string): Promise<void> {
    const trimmed = id.trim();
    if (trimmed === "") throw new Error("auth filestore: id is empty");
    const path = this.resolveDeletePath(trimmed);
    try {
      rmSync(path, { force: true });
    } catch (err) {
      throw new Error(`auth filestore: delete failed: ${(err as Error).message}`);
    }
  }

  private readAuthFile(path: string, baseDir: string): Auth | undefined {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      log.warn("auth filestore: read failed", { path, error: (err as Error).message });
      return undefined;
    }
    if (text.trim() === "") return undefined;
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      log.warn("auth filestore: skipping invalid JSON auth file", { path });
      return undefined;
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
    let modifiedAt = 0;
    try {
      modifiedAt = Math.trunc(statSync(path).mtimeMs);
    } catch {
      modifiedAt = 0;
    }
    const id = idFor(path, baseDir);
    const auth = authFromStoredRecord(id, document as Record<string, unknown>, {
      path,
      sourceBackend: AuthSourceFile,
      modifiedAt,
    });
    if (!auth) log.warn("auth filestore: skipping auth file with invalid metadata", { path });
    return auth;
  }

  private resolveAuthPath(auth: Auth): string {
    const explicit = auth.attributes?.[AttributePath]?.trim() ?? "";
    if (explicit !== "") return explicit;
    const id = auth.id.trim();
    if (id === "") throw new Error("auth filestore: missing id");
    if (isAbsolute(id)) return id;
    if (this.baseDir === "") throw new Error("auth filestore: directory not configured");
    return join(this.baseDir, id);
  }

  private resolveDeletePath(id: string): string {
    if (isAbsolute(id) || id.includes(sep) || id.includes("/")) {
      if (isAbsolute(id)) return id;
      if (this.baseDir === "") return id;
      return join(this.baseDir, id);
    }
    if (this.baseDir === "") throw new Error("auth filestore: directory not configured");
    return join(this.baseDir, id);
  }
}

/** Store id for a file: its path relative to the base directory. */
export function idFor(path: string, baseDir: string): string {
  if (baseDir !== "") {
    const rel = relative(baseDir, path);
    if (rel !== "" && !rel.startsWith("..")) return rel.split(sep).join("/");
  }
  return path;
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log.warn("auth filestore: readdir failed", { dir, error: (err as Error).message });
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    out.push(full);
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
