import { inspect } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_NAME } from "./schema.js";
import { secretRefsOf, type NimbleNewtConfig } from "./config.js";

/** Windows treats these as devices whatever the extension; opening one can block or read nothing. */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
const REDACTED = "[redacted]";

/**
 * A secret value that cannot be printed or serialized by accident: string conversion, JSON and `util.inspect` all give
 * "[redacted]". The only way to get the value is the explicit `reveal()`.
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return REDACTED; }
  toJSON(): string { return REDACTED; }
  [inspect.custom](): string { return REDACTED; }
}

/** Where secret values come from. The configuration holds only names; a resolver turns a name into a value on demand. */
export interface SecretResolver {
  resolve(name: string): Promise<string | undefined>;
}

/**
 * Secrets from environment variables named `NIMBLENEWT_SECRET_<NAME>`: upper-cased, with '.' written `__DOT__` and '-' written
 * `__DASH__` so that different secret names can never share a variable (secret names may not contain "__").
 */
export function environmentSecrets(env: Readonly<Record<string, string | undefined>> = process.env): SecretResolver {
  return { resolve: async (name) => SECRET_NAME.test(name) ? env[`NIMBLENEWT_SECRET_${name.toUpperCase().replace(/\./g, "__DOT__").replace(/-/g, "__DASH__")}`] : undefined };
}

/** Secrets from files named after the secret in a directory (the layout container secret mounts use). */
export function directorySecrets(directory: string): SecretResolver {
  return {
    resolve: async (name) => {
      if (!SECRET_NAME.test(name) || RESERVED_DEVICE.test(name) || name.endsWith(".")) return undefined; // a name can never be a path or a Windows device
      try {
        return (await readFile(join(directory, name), "utf8")).replace(/\r?\n$/, "");
      } catch {
        return undefined;
      }
    },
  };
}

/** Secrets held in memory, for tests and for callers that already have them. */
export function memorySecrets(values: Readonly<Record<string, string>>): SecretResolver {
  return { resolve: async (name) => (Object.hasOwn(values, name) ? values[name] : undefined) };
}

/** Every secret name a configuration refers to, with where it is used, in a stable order. */
export const secretReferences = secretRefsOf;

export type ResolvedSecrets =
  | { readonly ok: true; readonly secrets: ReadonlyMap<string, Secret> }
  | { readonly ok: false; readonly missing: { name: string; usedBy: string }[] };

/**
 * Looks up every secret a configuration refers to. Reports all that are missing by name and use, never by value, so a
 * failed start explains itself without exposing anything. Only enabled providers' credentials are required.
 */
export async function resolveSecrets(config: NimbleNewtConfig, resolver: SecretResolver): Promise<ResolvedSecrets> {
  const secrets = new Map<string, Secret>();
  const missing: { name: string; usedBy: string }[] = [];
  const disabled = new Set(Object.entries(config.models.providers).filter(([, p]) => !p.enabled).map(([n]) => `models.providers.${n}.credential`));
  for (const { name, usedBy } of secretReferences(config)) {
    if (disabled.has(usedBy) || secrets.has(name)) continue;
    const value = await resolver.resolve(name);
    if (value === undefined || value === "") missing.push({ name, usedBy });
    else secrets.set(name, new Secret(value));
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, secrets };
}

/** A view of the configuration that is safe to log or show: secret references stay as names, which are not secret. */
export function describeConfig(config: NimbleNewtConfig): string {
  return JSON.stringify(config, null, 2);
}
