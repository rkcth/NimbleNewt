import { MAX_DEPTH, SECRET_NAME, tooDeep, validate, type ConfigError, type Schema } from "./schema.js";

/** The configuration layout this build writes and reads. Older layouts are upgraded by `migrateConfig`. */
export const CURRENT_CONFIG_VERSION = 1;

export interface SecretRef {
  readonly secret: string;
}

export type ControllerStorage =
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "postgres"; readonly url: SecretRef; readonly maxConnections: number };

export interface Provider {
  /** Which adapter talks to this provider (for example `fake`, `openai-compatible`). */
  readonly adapter: string;
  readonly endpoint?: string;
  readonly credential?: SecretRef;
  readonly enabled: boolean;
  /** Whether using it costs money. A paid provider is never enabled by a public profile. */
  readonly paid: boolean;
  readonly models: readonly string[];
}

export interface Grant {
  readonly id: string;
  readonly action: string;
  readonly scope: string;
  /** `private` grants belong to one installation and never appear in public defaults or exports. */
  readonly visibility: "public" | "private";
  readonly expires?: string;
}

export interface NimbleNewtConfig {
  readonly configVersion: number;
  /** `public` is what an example or shared profile may contain; `private` is one installation's own. */
  readonly profile: "public" | "private";
  readonly installation: {
    readonly name: string;
    /** Where deployment data lives. Outside the source checkout and the repositories agents work on. */
    readonly dataDir: string;
    readonly workspaces: Readonly<Record<string, { readonly path: string }>>;
  };
  readonly controller: { readonly storage: ControllerStorage };
  readonly limits: { readonly productiveAttempts: number; readonly perHost: number; readonly inquirySlots: number };
  readonly execution: {
    readonly isolation: "strong" | "trusted-host";
    readonly trustedHost?: { readonly authorizedBy: string; readonly reason: string };
  };
  readonly models: {
    readonly providers: Readonly<Record<string, Provider>>;
    /** Difficulty profile name to an ordered list of `provider/model` routes, first choice first. */
    readonly difficulty: Readonly<Record<string, readonly string[]>>;
  };
  readonly api: { readonly remoteExposure: boolean };
  /** The approval profile (card A07 builds the policy engine behind it): `strict` (the default for a new installation) asks at every consequential step; `derived` lets an explicit instruction authorize what it reasonably needs and is offered by first-run setup (the owner's own installation sets it in private configuration); `autonomous` acts within grants. */
  readonly approvals: { readonly preset: "derived" | "strict" | "autonomous"; readonly grants: readonly Grant[] };
}

/** Initial operating limits accepted by the owner (decision D6). */
export const DEFAULT_LIMITS = { productiveAttempts: 4, perHost: 2, inquirySlots: 2 } as const;

const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const NAME_HINT = "must start with a letter and contain only letters, digits, '.', '_' or '-' (at most 64 characters)";
/** A `{{name}}` stand-in used by shared profiles for values that belong to one installation. */
const PLACEHOLDER = /^\{\{[^}]+\}\}$/;
const text = (extra: { minLength?: number; pattern?: RegExp; hint?: string } = {}): Schema => ({ kind: "string", minLength: 1, ...extra });
const secretRef: Schema = { kind: "secretRef" };

const SCHEMA: Schema = {
  kind: "object",
  optional: ["limits", "execution", "api", "approvals"],
  props: {
    configVersion: { kind: "integer", min: 1 },
    profile: { kind: "enum", values: ["public", "private"] },
    installation: {
      kind: "object",
      props: {
        name: text({ pattern: /^(?:[A-Za-z][A-Za-z0-9._-]{0,63}|\{\{[^}]+\}\})$/, hint: NAME_HINT }),
        dataDir: text(),
        workspaces: { kind: "record", keyPattern: NAME, keyHint: NAME_HINT, values: { kind: "object", props: { path: text() } } },
      },
    },
    controller: {
      kind: "object",
      props: {
        storage: {
          kind: "variant",
          discriminator: "kind",
          variants: {
            sqlite: { kind: "object", props: { kind: { kind: "literal", value: "sqlite" }, path: text() } },
            postgres: { kind: "object", props: { kind: { kind: "literal", value: "postgres" }, url: secretRef, maxConnections: { kind: "integer", min: 1, max: 200 } } },
          },
        },
      },
    },
    limits: {
      kind: "object",
      optional: ["productiveAttempts", "perHost", "inquirySlots"],
      props: { productiveAttempts: { kind: "integer", min: 1, max: 1000 }, perHost: { kind: "integer", min: 1, max: 1000 }, inquirySlots: { kind: "integer", min: 0, max: 1000 } },
    },
    execution: {
      kind: "object",
      optional: ["isolation", "trustedHost"],
      props: {
        isolation: { kind: "enum", values: ["strong", "trusted-host"] },
        trustedHost: { kind: "object", props: { authorizedBy: text(), reason: text() } },
      },
    },
    models: {
      kind: "object",
      props: {
        providers: {
          kind: "record",
          keyPattern: NAME,
          keyHint: NAME_HINT,
          values: {
            kind: "object",
            optional: ["endpoint", "credential"],
            props: {
              adapter: text({ pattern: NAME, hint: NAME_HINT }),
              endpoint: text({ pattern: /^(?:https?:\/\/[^\s/@]+(?:[/?#]\S*)?|\{\{[^}]+\}\})$/, hint: "must be an http(s) URL without embedded credentials" }),
              credential: secretRef,
              enabled: { kind: "boolean" },
              paid: { kind: "boolean" },
              models: { kind: "array", items: text() },
            },
          },
        },
        difficulty: { kind: "record", keyPattern: NAME, keyHint: NAME_HINT, values: { kind: "array", items: text({ pattern: /^[^/\s]+\/\S+$/, hint: 'must look like "provider/model"' }), maxItems: 32 } },
      },
    },
    api: { kind: "object", props: { remoteExposure: { kind: "boolean" } } },
    approvals: {
      kind: "object",
      optional: ["grants"],
      props: {
        preset: { kind: "enum", values: ["derived", "strict", "autonomous"] },
        grants: {
          kind: "array",
          items: {
            kind: "object",
            optional: ["expires"],
            props: { id: text({ pattern: NAME, hint: NAME_HINT }), action: text(), scope: text(), visibility: { kind: "enum", values: ["public", "private"] }, expires: text({ pattern: /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/, hint: "must be an ISO date or UTC timestamp" }) },
          },
        },
      },
    },
  },
};

/** Strings that look like credentials. Reported by path only: the value is never echoed. */
const SECRET_SHAPES: readonly [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, "a URL with a password in it"],
];

const shapeOf = (text: string): string | undefined => SECRET_SHAPES.find(([shape]) => shape.test(text))?.[1];
const WITHHELD = "<key withheld>";

/**
 * Finds values and names that look like credentials anywhere in a document. A safety net that recognises well-known
 * token formats by shape; it cannot spot an ordinary password in an ordinary field. The real protection is that settings
 * which need a secret accept only a `{ "secret": "name" }` reference. Reports paths only, never the value; a key that
 * looks like a credential is replaced in the path.
 */
export function findInlineSecrets(value: unknown, path = "", depth = 0): ConfigError[] {
  const message = (kind: string): string => `looks like ${kind}; secrets must never be written into configuration (store it in the secret store and refer to it by name: {"secret": "name"})`;
  if (depth > MAX_DEPTH) return [];
  if (typeof value === "string") {
    const hit = shapeOf(value);
    return hit === undefined ? [] : [{ path, message: message(hit) }];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => findInlineSecrets(item, `${path}[${i}]`, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => {
      const hit = shapeOf(k);
      const here = path === "" ? (hit === undefined ? k : WITHHELD) : `${path}.${hit === undefined ? k : WITHHELD}`;
      return [...(hit === undefined ? [] : [{ path: here, message: `the name ${message(hit)}` }]), ...findInlineSecrets(v, here, depth + 1)];
    });
  }
  return [];
}

/** Paths of string values that still contain a `{{name}}` placeholder. */
function unfilledPlaceholders(value: unknown, path = "", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  if (typeof value === "string") return /\{\{[^}]+\}\}/.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => unfilledPlaceholders(v, `${path}[${i}]`, depth + 1));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => unfilledPlaceholders(v, path === "" ? k : `${path}.${k}`, depth + 1));
  return [];
}

/** Every secret name the configuration refers to, with where it is used, in a stable order. */
export function secretRefsOf(config: NimbleNewtConfig): { name: string; usedBy: string }[] {
  const found: { name: string; usedBy: string }[] = [];
  const add = (ref: SecretRef | undefined, usedBy: string) => { if (ref !== undefined) found.push({ name: ref.secret, usedBy }); };
  if (config.controller.storage.kind === "postgres") add(config.controller.storage.url, "controller.storage.url");
  for (const [name, provider] of Object.entries(config.models.providers)) add(provider.credential, `models.providers.${name}.credential`);
  return found;
}

/** Host names that only mean something on one machine or network. */
const PRIVATE_HOST = /^(?:localhost|.*\.(?:local|internal|lan|home|corp)|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(?:1[6-9]|2\d|3[01])\.[\d.]+|169\.254\.[\d.]+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*|[^.]+)$/i;
const hostOf = (endpoint: string): string => /^https?:\/\/([^/?#]+)/i.exec(endpoint)?.[1]?.replace(/:\d+$/, "") ?? "";

/** Rules that span several settings. Run only on a document that already matches the schema. */
function crossChecks(config: NimbleNewtConfig): ConfigError[] {
  const errors: ConfigError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });

  for (const [name, provider] of Object.entries(config.models.providers)) {
    if (provider.enabled && provider.adapter !== "fake" && provider.credential === undefined && provider.endpoint === undefined) {
      add(`models.providers.${name}`, "is enabled but names neither an endpoint nor a credential, so it cannot be reached");
    }
  }
  for (const [difficulty, routes] of Object.entries(config.models.difficulty)) {
    routes.forEach((route, i) => {
      const [providerName, ...rest] = route.split("/");
      const provider = Object.hasOwn(config.models.providers, providerName!) ? config.models.providers[providerName!] : undefined;
      if (provider === undefined) add(`models.difficulty.${difficulty}[${i}]`, `route "${route}" names unknown provider "${providerName}"`);
      else if (!provider.models.includes(rest.join("/"))) add(`models.difficulty.${difficulty}[${i}]`, `provider "${providerName}" does not list model "${rest.join("/")}"`);
    });
    if (new Set(routes).size !== routes.length) add(`models.difficulty.${difficulty}`, "lists the same route twice");
  }
  if (config.execution.isolation === "trusted-host" && config.execution.trustedHost === undefined) {
    add("execution.trustedHost", 'is required when isolation is "trusted-host": trusted-host mode needs a named person and a reason');
  }
  if (config.execution.isolation === "strong" && config.execution.trustedHost !== undefined) {
    add("execution.trustedHost", 'is set but isolation is "strong"; remove it or choose "trusted-host" deliberately');
  }
  const ids = new Set<string>();
  config.approvals.grants.forEach((grant, i) => {
    if (ids.has(grant.id)) add(`approvals.grants[${i}].id`, `grant "${grant.id}" appears twice`);
    ids.add(grant.id);
  });
  if (config.limits.perHost > config.limits.productiveAttempts) add("limits.perHost", "cannot exceed limits.productiveAttempts (the installation-wide total)");

  if (config.profile === "private") {
    for (const path of unfilledPlaceholders(config)) add(path, 'still contains a {{placeholder}} from a shared profile; fill it in (see importProfile) before using this configuration');
  }
  const seenRefs = new Map<string, string>();
  for (const { name, usedBy } of secretRefsOf(config)) {
    const key = name.toLowerCase();
    const earlier = seenRefs.get(key);
    if (earlier !== undefined && earlier !== name) add(usedBy, `secret names "${name}" and "${earlier}" differ only by letter case; the secret store treats them as the same, so use one spelling`);
    else seenRefs.set(key, name);
  }
  if (config.profile === "public") {
    const mustBePlaceholder = (path: string, value: string) => { if (!PLACEHOLDER.test(value)) add(path, "a public profile must use a {{placeholder}} here, not a real location; real paths belong to one machine"); };
    mustBePlaceholder("installation.dataDir", config.installation.dataDir);
    for (const [name, workspace] of Object.entries(config.installation.workspaces)) mustBePlaceholder(`installation.workspaces.${name}.path`, workspace.path);
    if (config.controller.storage.kind === "sqlite") mustBePlaceholder("controller.storage.path", config.controller.storage.path);
    for (const [name, provider] of Object.entries(config.models.providers)) {
      if (provider.endpoint !== undefined && !PLACEHOLDER.test(provider.endpoint) && PRIVATE_HOST.test(hostOf(provider.endpoint))) {
        add(`models.providers.${name}.endpoint`, "a public profile must not point at localhost or a private network address; use a {{placeholder}} or a public host");
      }
    }
    config.approvals.grants.forEach((grant, i) => {
      if (grant.visibility === "private") add(`approvals.grants[${i}]`, "is a private grant; a public profile may not contain private grants (keep them in a private profile)");
    });
    for (const [name, provider] of Object.entries(config.models.providers)) {
      if (provider.paid && provider.enabled) add(`models.providers.${name}.enabled`, "a public profile must not enable a paid provider; examples must never activate paid services on their own");
    }
    if (config.execution.isolation === "trusted-host") add("execution.isolation", 'a public profile must use "strong" isolation; trusted-host mode is a private, explicitly authorized choice');
    if (config.api.remoteExposure) add("api.remoteExposure", "a public profile must leave remote exposure off");
  }
  return errors;
}

/** Fills the settings a document may omit with their documented defaults. Pure. */
export function withDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const limits = (raw.limits ?? {}) as Record<string, unknown>;
  const execution = (raw.execution ?? {}) as Record<string, unknown>;
  const approvals = (raw.approvals ?? {}) as Record<string, unknown>;
  const api = (raw.api ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    limits: { ...DEFAULT_LIMITS, ...limits },
    execution: { isolation: "strong", ...execution },
    api: { remoteExposure: false, ...api },
    // The first release called the strict profile "tight"; an old document keeps that meaning under its new name (it never silently becomes looser).
    approvals: { preset: "strict", grants: [], ...approvals, ...(approvals.preset === "tight" ? { preset: "strict" } : {}) },
  };
}

/** Validates a document that is already at the current layout. Never throws; reports every problem found. */
export function validateConfig(raw: unknown): { readonly ok: true; readonly config: NimbleNewtConfig } | { readonly ok: false; readonly errors: ConfigError[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: [{ path: "", message: "the configuration must be an object" }] };
  if (tooDeep(raw)) return { ok: false, errors: [{ path: "", message: `the configuration is nested more than ${MAX_DEPTH} levels deep; real configuration is shallow, so this is refused rather than processed` }] };
  const document = raw as Record<string, unknown>;
  if (document.configVersion !== CURRENT_CONFIG_VERSION) {
    return { ok: false, errors: [{ path: "configVersion", message: `expected ${CURRENT_CONFIG_VERSION} (migrate older documents first), found ${typeof document.configVersion === "number" ? String(document.configVersion) : `a ${typeof document.configVersion}`}` }] };
  }
  const secrets = findInlineSecrets(raw);
  if (secrets.length > 0) return { ok: false, errors: secrets };
  const filled = withDefaults(document);
  const errors = validate(filled, SCHEMA);
  if (errors.length > 0) return { ok: false, errors };
  const config = filled as unknown as NimbleNewtConfig;
  const cross = crossChecks(config);
  return cross.length > 0 ? { ok: false, errors: cross } : { ok: true, config };
}

export { SECRET_NAME };
