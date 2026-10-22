import { execFile } from "node:child_process";
import { SECRET_NAME } from "../schema.js";
import type { SecretResolver } from "../secrets.js";

export type SecretStoreFailure = "unavailable" | "locked" | "unsafe" | "invalid";

/** A secret store failed. The message names the reference and the problem, never a value; `reference` is the secret's name (not secret). */
export class SecretStoreError extends Error {
  readonly code: SecretStoreFailure;
  readonly reference: string;
  constructor(code: SecretStoreFailure, reference: string, message: string) {
    super(`secret "${reference}": ${message}`);
    this.name = "SecretStoreError";
    this.code = code;
    this.reference = reference;
  }
}

/**
 * A place secret values live (card F09). It is a `SecretResolver` (so configuration's references resolve through it at the moment they are needed, with no cache: a rotated value is used from the
 * next resolution) that can also write. `set` returns nothing and nothing here ever returns, logs or puts a value in an error.
 */
export interface SecretStore extends SecretResolver {
  readonly kind: "macos-keychain" | "windows-dpapi" | "linux-secret-service" | "protected-file";
  /** The value, `undefined` when the store has no such secret; throws `SecretStoreError` when the store is locked, missing, or unsafe. */
  resolve(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** Whether a secret was removed. */
  remove(name: string): Promise<boolean>;
  /** Whether the store can be used now, and if not why, in words. */
  check(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

export const MAX_SECRET_BYTES = 16 * 1024;

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) throw new SecretStoreError("invalid", String(typeof name === "string" ? name.slice(0, 64) : "?"), "is not a valid secret name (it starts with a letter and holds letters, digits, '.', '_' or '-', at most 64, no '__')");
  return name;
}

export function checkValue(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new SecretStoreError("invalid", name, "a secret must be a non-empty string");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new SecretStoreError("invalid", name, `a secret may be at most ${MAX_SECRET_BYTES} bytes`);
  return value;
}

export interface Ran { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean; readonly missing: boolean }

/** Runs a program with the value, if any, on its standard input (never on its command line, where other users could read it). */
export function run(program: string, args: readonly string[], input: string | undefined, timeoutMs = 15_000): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(program, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: "utf8" }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      if (e === null) return resolve({ code: 0, stdout, stderr, timedOut: false, missing: false });
      if (e.code === "ENOENT") return resolve({ code: null, stdout, stderr, timedOut: false, missing: true });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: e.killed === true, missing: false });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}
