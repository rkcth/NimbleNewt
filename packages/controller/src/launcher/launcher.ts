import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { startController, type Controller, type StartOptions, type StorageChoice } from "../api/start.js";
import { HttpModelCall } from "../chat/http-model.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { chatRoutes } from "../chat/routed-model.js";
import { DomainError } from "../domain/errors.js";
import type { ModelEndpoint } from "../dispatch/relay.js";
import { RoutingService } from "../routing/service.js";

/**
 * The launcher (card U14): starts the controller from a configuration document, makes the owner once, and keeps the owner's credential in the operating system's secret store, never in a file the
 * owner has to guard. It holds no policy of its own; everything after the start is done through the state API and the chat. The configuration is passed in already loaded and checked (the package that
 * reads and validates the document is separate), as the structural subset the launcher uses.
 */
export interface LauncherSecrets {
  resolve(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  remove?(name: string): Promise<boolean>;
}

export interface LauncherProvider {
  readonly adapter: string;
  readonly endpoint?: string;
  readonly credential?: { readonly secret: string };
  readonly enabled: boolean;
  readonly paid: boolean;
  readonly models: readonly string[];
}

export interface LauncherConfig {
  readonly installation: { readonly name: string; readonly dataDir: string };
  readonly controller: { readonly storage: { readonly kind: "sqlite"; readonly path: string } | { readonly kind: "postgres"; readonly url: { readonly secret: string }; readonly maxConnections: number; readonly schema?: string }; readonly databaseTransfer?: { readonly targets: readonly unknown[] } };
  readonly models: { readonly providers: Readonly<Record<string, LauncherProvider>> };
}

/** The name the owner's credential is kept under in the secret store. */
export const OWNER_SECRET = "nimblenewt-owner-token";
/** The context window assumed for a provider the configuration document names, which carries none; the owner changes it by chat (routing.provider.add replaces the provider). */
export const DEFAULT_CONTEXT_TOKENS = 32_768;

export interface LaunchOptions {
  readonly config: LauncherConfig;
  readonly secrets: LauncherSecrets;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where notices go. Default: standard error. */
  readonly print?: (line: string) => void;
  /** Passed to the controller as they are (tests inject the environment facts and file system detector; a host adds dispatch). */
  readonly start?: Partial<Omit<StartOptions, "storage" | "argv" | "env" | "chat">>;
  /** The model client for the chat. Default: an OpenAI-compatible HTTP client over the providers' recorded addresses. */
  readonly fetch?: typeof globalThis.fetch;
  /** The conversation listener (HTTP, local only unless the host adds TLS and host names). Absent: none. */
  readonly serve?: NonNullable<StartOptions["conversationTransport"]>;
}

export interface Launched {
  readonly controller: Controller;
  /** The owner's token. Kept in memory for this process (the chat uses it); never printed. */
  readonly ownerToken: string;
  /** Whether this start made the owner. */
  readonly ownerCreated: boolean;
  /** What the launcher did or left alone, in plain words, for the owner to read. */
  readonly notes: readonly string[];
  close(): Promise<void>;
}

const loopback = (url: string): boolean => { try { const h = new URL(url).hostname; return h === "localhost" || h === "::1" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h); } catch { return false; } };

/** Starts the controller from `config`, makes the owner the first time, and lets the chat reach the providers the owner has recorded. */
export async function launch(options: LaunchOptions): Promise<Launched> {
  const { config, secrets } = options;
  const print = options.print ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const dataDir = resolve(config.installation.dataDir);
  if (!isAbsolute(config.installation.dataDir)) print(`The data directory ${config.installation.dataDir} is not an absolute path; ${dataDir} is used.`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const notes: string[] = [];

  let storage: StorageChoice;
  if (config.controller.storage.kind === "sqlite") storage = { kind: "sqlite", path: resolve(dataDir, config.controller.storage.path) };
  else {
    const url = await secrets.resolve(config.controller.storage.url.secret);
    if (url === undefined) throw new Error(`the configuration chooses PostgreSQL and names the secret "${config.controller.storage.url.secret}" for its address, but the secret store has none by that name; put it there first (nimblenewt secret set ${config.controller.storage.url.secret})`);
    storage = { kind: "postgres", url, maxConnections: config.controller.storage.maxConnections, ...(config.controller.storage.schema === undefined ? {} : { schema: config.controller.storage.schema }) };
  }

  // The chat reaches the providers through the addresses the owner recorded (guided setup keeps them in the controller's records); the credential is read from the secret store at each call.
  let live: Controller | undefined;
  const endpoints = new Map<string, { endpoint: string; credentialName?: string }>();
  const refresh = async (): Promise<void> => {
    if (live === undefined) return;
    endpoints.clear();
    for (const e of await live.services.setupProviders.endpoints()) endpoints.set(e.provider, { endpoint: e.endpoint, ...(e.credentialName === undefined ? {} : { credentialName: e.credentialName }) });
  };
  const model = new HttpModelCall({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    endpoint: (route): ModelEndpoint | undefined => {
      const e = endpoints.get(route.slice(0, route.indexOf("/")));
      if (e === undefined) return undefined;
      return { url: e.endpoint, ...(e.credentialName === undefined ? {} : { headers: async () => { const key = await secrets.resolve(e.credentialName!); if (key === undefined) throw new Error(`the secret "${e.credentialName}" is not in the secret store`); return { authorization: `Bearer ${key}` }; } }) };
    },
  });
  const routes = async (): Promise<readonly string[]> => {
    if (live === undefined) return [];
    await refresh();
    const routing = RoutingService.withEpoch(live.storage, live.epoch);
    const local = await chatRoutes(routing, { role: "coordinator", data: "local-only" })();
    // A cloud route is used for the chat only when no local one is there: the owner chose that provider for the team, and without it there would be no chat at all.
    return local.length > 0 ? local : chatRoutes(routing, { role: "coordinator", data: "cloud-allowed" })();
  };
  const interpreter = new ModelInterpreter(model, routes);

  const controller = await startController({
    ...(options.start ?? {}),
    storage, argv: options.argv, env: options.env, print, dataDirectory: dataDir,
    ...(config.controller.databaseTransfer === undefined || config.controller.databaseTransfer.targets.length === 0 ? {} : { transfer: { ...(options.start?.transfer ?? {}), stateDirectory: join(dataDir, "transfer"), targets: options.start?.transfer?.targets ?? [], targetEntries: config.controller.databaseTransfer.targets, secrets: (name: string) => secrets.resolve(name) } }),
    chat: { interpreter },
    ...(options.serve === undefined ? {} : { conversationTransport: options.serve }),
  });
  live = controller;
  try {
    const { token, created } = await ensureOwner(controller, secrets);
    if (created) notes.push("You are now the owner of this installation. Your credential is in this computer's secret store, not in a file.");
    const owner = await controller.services.principals.authenticate(token);
    const have = await controller.storage.getAggregate({ kind: "routing-table", id: "routing" });
    const wanted = Object.entries(config.models.providers).filter(([, p]) => p.enabled && p.endpoint !== undefined && p.models.length > 0);
    if (have === undefined && wanted.length > 0) {
      try {
        const done = await controller.services.setupProviders.add(owner, { commandId: "launcher-providers", providers: wanted.map(([name, p]) => ({ name, location: loopback(p.endpoint!) ? "local" : "cloud", paid: p.paid, endpoint: p.endpoint!, models: p.models, contextTokens: DEFAULT_CONTEXT_TOKENS, ...(p.credential === undefined ? {} : { credentialName: p.credential.secret }) })) });
        notes.push(`Model providers from the configuration were registered: ${done.routes.join(", ")} (context window assumed ${DEFAULT_CONTEXT_TOKENS} tokens; tell the chat the real one to change it).`);
      } catch (error) {
        notes.push(`The model providers in the configuration were not registered yet: ${error instanceof DomainError ? error.message : "a registration problem"}`);
      }
    } else if (have === undefined) notes.push("No model provider is set up yet. The chat needs one: name a model server in the configuration (models.providers) or start with `init --model-endpoint ...`.");
    await refresh();
    return { controller, ownerToken: token, ownerCreated: created, notes, close: () => controller.close() };
  } catch (error) { await controller.close().catch(() => undefined); throw error; }
}

/** The owner exists once. The first start makes the owner and puts the token in the secret store before anything else uses it; a later start reads it back. */
export async function ensureOwner(controller: Controller, secrets: LauncherSecrets): Promise<{ token: string; created: boolean }> {
  const existing = await controller.storage.getAggregate({ kind: "installation", id: "installation" });
  if (existing === undefined) {
    // Prove the store can keep a secret before the owner is made: a credential that cannot be kept would be lost for good (the token is shown only once, to this process).
    const probe = `${OWNER_SECRET}-probe`;
    try { await secrets.set(probe, "probe"); if ((await secrets.resolve(probe)) !== "probe") throw new Error("the value read back differs"); await secrets.remove?.(probe); } catch (error) {
      throw new Error(`the secret store cannot keep the owner's credential, so no owner was made: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
    const issued = await controller.services.principals.bootstrapOwner({ name: "owner" });
    await secrets.set(OWNER_SECRET, issued.token);
    return { token: issued.token, created: true };
  }
  const token = await secrets.resolve(OWNER_SECRET);
  if (token === undefined) throw new Error(`this installation has an owner, but the secret store has no credential named "${OWNER_SECRET}" for it. The credential is shown once and cannot be derived again: restore it from where it was kept, or restore the installation's backup.`);
  try { await controller.services.principals.authenticate(token); } catch { throw new Error(`the credential "${OWNER_SECRET}" in the secret store is not the owner's current credential; restore the right one`); }
  return { token, created: false };
}


export const launcherDir = (file: string): string => dirname(resolve(file));
