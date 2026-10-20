import { createHash } from "node:crypto";
import { StorageError } from "./errors.js";
import { LIMITS, type Json } from "./types.js";

/**
 * Canonical JSON text: object keys in code-point order, no whitespace. Rejects what JSON cannot carry faithfully:
 * `undefined`, non-finite numbers, negative zero, integers beyond 2^53 - 1, functions, symbols, bigint, cycles, and anything
 * nested deeper than `LIMITS.bodyDepth`. This is the one representation every adapter stores, so values compare equal in
 * every database.
 */
export function canonicalJson(value: unknown, path = "body"): string {
  const seen = new Set<object>();
  const walk = (v: unknown, at: string, depth: number): string => {
    if (depth > LIMITS.bodyDepth) throw new StorageError("invalid_input", `${at}: nested more than ${LIMITS.bodyDepth} levels`, { path: at });
    if (v === null) return "null";
    switch (typeof v) {
      case "boolean": return v ? "true" : "false";
      case "string": return JSON.stringify(v);
      case "number":
        if (!Number.isFinite(v)) throw new StorageError("invalid_input", `${at}: numbers must be finite`, { path: at });
        if (Object.is(v, -0)) throw new StorageError("invalid_input", `${at}: negative zero is not allowed`, { path: at });
        if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new StorageError("invalid_input", `${at}: integers must be safe integers (at most 2^53 - 1)`, { path: at });
        return JSON.stringify(v);
      case "object": {
        if (seen.has(v)) throw new StorageError("invalid_input", `${at}: contains a cycle`, { path: at });
        seen.add(v);
        try {
          if (Array.isArray(v)) return `[${v.map((item, i) => walk(item, `${at}[${i}]`, depth + 1)).join(",")}]`;
          const proto = Object.getPrototypeOf(v);
          if (proto !== Object.prototype && proto !== null) throw new StorageError("invalid_input", `${at}: only plain objects are allowed`, { path: at });
          const keys = Object.keys(v).sort(compareCodePoints);
          return `{${keys.map((k) => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k], `${at}.${k}`, depth + 1)}`).join(",")}}`;
        } finally {
          seen.delete(v);
        }
      }
      default:
        throw new StorageError("invalid_input", `${at}: ${v === undefined ? "undefined is not a value; omit the field" : `${typeof v} is not allowed`}`, { path: at });
    }
  };
  return walk(value, path, 0);
}

/** Code-point order (not UTF-16 unit order), the same ordering a database gives for binary collation of UTF-8. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Parses stored canonical JSON text back to a value. */
export const parseJson = (text: string): Json => JSON.parse(text) as Json;
