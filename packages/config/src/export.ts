import { validateConfig, type NimbleNewtConfig } from "./config.js";
import type { ConfigError } from "./schema.js";

export interface ExportPreview {
  /** Every setting that is shared as it is, by path (secret references appear as their names). Built from the exported document itself. */
  readonly kept: readonly string[];
  /** Settings removed or switched off because they are private or unsafe to share. */
  readonly omitted: readonly { path: string; reason: string }[];
  /** Placeholders the importer must fill in: `{{name}}` to where it is used. */
  readonly placeholders: readonly { name: string; path: string }[];
}

export interface ExportedProfile {
  readonly document: Record<string, unknown>;
  readonly preview: ExportPreview;
}

const placeholder = (name: string) => `{{${name}}}`;
const PLACEHOLDER = /^\{\{[^}]+\}\}$/;

/** Paths of every leaf value that is not a placeholder. */
function leafPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [path] : value.flatMap((v, i) => leafPaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0 ? [path] : entries.flatMap(([k, v]) => leafPaths(v, path === "" ? k : `${path}.${k}`));
  }
  return typeof value === "string" && PLACEHOLDER.test(value) ? [] : [path];
}

/**
 * Builds a shareable copy of a configuration: a public profile with private grants removed, everything that names one
 * machine or installation (the installation name, data and workspace paths, the SQLite path, provider endpoints, grant
 * scopes) replaced by a placeholder, paid providers switched off, and secret references kept as names. It never contains a
 * secret value (a configuration never holds one), a transcript or deployment history. `preview` lists exactly what is
 * shared, computed from the exported document.
 */
export function exportProfile(config: NimbleNewtConfig): ExportedProfile {
  const omitted: { path: string; reason: string }[] = [];
  const placeholders: { name: string; path: string }[] = [];
  const document = structuredClone(config) as unknown as Record<string, any>;
  const replace = (target: Record<string, any>, key: string, name: string, path: string) => {
    target[key] = placeholder(name);
    placeholders.push({ name, path });
  };

  document.profile = "public";
  const kept: Record<string, any>[] = [];
  document.approvals.grants.forEach((g: Record<string, any>, i: number) => {
    if (g.visibility === "public") kept.push(g);
    else omitted.push({ path: `approvals.grants[${i}] (${g.id})`, reason: "private grant" });
  });
  document.approvals.grants = kept;
  kept.forEach((g, i) => replace(g, "scope", `grant.${g.id}.scope`, `approvals.grants[${i}].scope`));

  replace(document.installation, "name", "installationName", "installation.name");
  replace(document.installation, "dataDir", "dataDir", "installation.dataDir");
  for (const name of Object.keys(document.installation.workspaces)) replace(document.installation.workspaces[name], "path", `workspace.${name}`, `installation.workspaces.${name}.path`);
  if (document.controller.storage.kind === "sqlite") replace(document.controller.storage, "path", "sqlitePath", "controller.storage.path");

  for (const [name, provider] of Object.entries(document.models.providers as Record<string, Record<string, any>>)) {
    if (provider.endpoint !== undefined) replace(provider, "endpoint", `provider.${name}.endpoint`, `models.providers.${name}.endpoint`);
    if (provider.paid && provider.enabled) {
      provider.enabled = false;
      omitted.push({ path: `models.providers.${name}.enabled`, reason: "paid provider switched off in a shared profile" });
    }
  }
  if (document.execution.isolation === "trusted-host") {
    document.execution = { isolation: "strong" };
    omitted.push({ path: "execution.trustedHost", reason: "trusted-host authorization names a person and is private; isolation reset to strong" });
  }
  if (document.api.remoteExposure) {
    document.api.remoteExposure = false;
    omitted.push({ path: "api.remoteExposure", reason: "remote exposure is off in a shared profile" });
  }
  return { document, preview: { kept: leafPaths(document), omitted, placeholders } };
}

export type ImportResult = { readonly ok: true; readonly config: NimbleNewtConfig } | { readonly ok: false; readonly errors: ConfigError[] };

/**
 * Fills the placeholders of an exported profile from a mapping and validates the result. Missing mappings, unused
 * mappings and placeholders left in place are reported by name, so nothing from the original machine is needed.
 */
export function importProfile(exported: Record<string, unknown>, mapping: Readonly<Record<string, string>>): ImportResult {
  const errors: ConfigError[] = [];
  const used = new Set<string>();
  const fill = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      return value.replace(/\{\{([^}]+)\}\}/g, (whole, name: string) => {
        used.add(name);
        const replacement = Object.hasOwn(mapping, name) ? mapping[name] : undefined;
        if (replacement === undefined || replacement === "") { errors.push({ path, message: `needs a value for ${whole}; add "${name}" to the mapping` }); return whole; }
        return replacement;
      });
    }
    if (Array.isArray(value)) return value.map((v, i) => fill(v, `${path}[${i}]`));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, path === "" ? k : `${path}.${k}`)]));
    return value;
  };
  const filled = fill(structuredClone(exported), "") as Record<string, unknown>;
  for (const name of Object.keys(mapping)) if (!used.has(name)) errors.push({ path: "", message: `the mapping has "${name}" but the profile has no {{${name}}} placeholder` });
  if (errors.length > 0) return { ok: false, errors };
  const checked = validateConfig({ ...filled, profile: "private" });
  return checked.ok ? { ok: true, config: checked.config } : checked;
}
