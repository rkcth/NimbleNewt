import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { startController, type Controller, type StartOptions, type StorageChoice } from "../api/start.js";
import { HttpModelCall } from "../chat/http-model.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { chatRoutes } from "../chat/routed-model.js";
import { DomainError } from "../domain/errors.js";
import type { ModelEndpoint } from "../dispatch/relay.js";
import type { Principal } from "../security/principals.js";
import { PolicyService } from "../policy/policy.js";
import { RoutingService } from "../routing/service.js";
import { makeToken, newSecret } from "../security/credentials.js";
import { principalIdOf } from "../security/principals.js";

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
  /** The approval profile the configuration names (card U14b). Used once, for an installation that has no approval policy record yet; the owner changes it by chat afterwards. The grants and the limits of the document are not read (see the notes). */
  readonly approvals?: { readonly preset: "derived" | "strict" | "autonomous" };
}

/** The start of the name the owner's credential is kept under in the secret store; see ownerSecretName. */
export const OWNER_SECRET = "nimblenewt-owner-token";
/**
 * The name of the owner's credential in the secret store for the installation in `dataDir` (an absolute path). The Linux Secret Service and the macOS Keychain are one store per user account, shared by
 * every installation of that account, so a fixed name would let a second installation's first start overwrite the first one's credential (which cannot be derived again). The name carries a digest of
 * the data directory, so each installation has its own.
 */
export const ownerSecretName = (dataDir: string): string => `${OWNER_SECRET}-${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 16)}`;
/** The context window assumed for a provider the configuration document names, which carries none; the owner changes it by chat (routing.provider.add replaces the provider). */
export const DEFAULT_CONTEXT_TOKENS = 32_768;

/**
 * What the launcher gives the builder of a worker host on this machine (card U14b). The builder lives outside the controller package (it needs the worker package, which the controller does not import), so the host that starts
 * the launcher passes it in. Nothing here loads or switches a model: the host's routes are the providers the owner configured.
 */
export interface LocalHostContext {
  /** The installation's data directory (a protected path: no sandbox mount may reach it). */
  readonly dataDir: string;
  readonly print: (line: string) => void;
  /**
   * Where a route's (`provider/model`) calls go: the provider's address from the owner's records (chat-edited providers included), read at each call, and its key from the secret store by the credential's NAME, read at each call.
   * `undefined` when the provider has no record. The key is never in the answer's address and never printed.
   */
  readonly endpoint: (route: string) => Promise<ModelEndpoint | undefined>;
  /** The controller being started, once it has started (the dispatcher's handle, the services). */
  readonly controller: () => Controller;
  readonly fetch?: typeof globalThis.fetch;
}

/** What the builder made: the start options to add (`dispatch.local`, harnesses, tools), what to do once the controller is up, and how to free what it made. */
export interface LocalHostPlan {
  readonly start: Pick<StartOptions, "dispatch" | "harnesses" | "tools">;
  /** Enrolls the host with the owner's authority, announces it and sets its capacity. Returns notes for the owner. */
  readonly attach: (controller: Controller, owner: Principal) => Promise<readonly string[]>;
  /** Frees what was made before the controller took it over (safe to call more than once). */
  readonly close: () => Promise<void>;
}

/** Builds the worker host, or says in plain words why this machine cannot run one (no sandbox, no usable Node.js install). */
export type LocalHostBuilder = (context: LocalHostContext) => Promise<LocalHostPlan | { readonly problem: string }>;

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
  /** Builds a worker host on this machine. Used only when the owner has turned it on (`host.local.set`, off by default); absent: the launcher builds none and says so when the owner asks for one. */
  readonly localHost?: LocalHostBuilder;
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
  /** A route's endpoint for the worker host's relay: read from the records at each call, the key from the secret store by name at each call. */
  const endpointOf = async (route: string): Promise<ModelEndpoint | undefined> => {
    if (live === undefined) return undefined;
    const slash = route.indexOf("/");
    if (slash <= 0) return undefined;
    const provider = route.slice(0, slash);
    const record = (await live.services.setupProviders.endpoints()).find((e) => e.provider === provider);
    if (record === undefined) return undefined;
    const name = record.credentialName;
    return { url: record.endpoint, ...(record.kind === undefined ? {} : { kind: record.kind }), ...(name === undefined ? {} : { headers: async () => { const key = await secrets.resolve(name); if (key === undefined) throw new Error(`the secret "${name}" is not in the secret store`); return { authorization: `Bearer ${key}` }; } }) };
  };
  const routes = async (): Promise<readonly string[]> => {
    if (live === undefined) return [];
    await refresh();
    const routing = RoutingService.withEpoch(live.storage, live.epoch);
    const local = await chatRoutes(routing, { role: "coordinator", data: "local-only" })();
    // A cloud route is used for the chat only when no local one is there: the owner chose that provider for the team, and without it there would be no chat at all.
    return local.length > 0 ? local : chatRoutes(routing, { role: "coordinator", data: "cloud-allowed" })();
  };
  const interpreter = new ModelInterpreter(model, routes);

  const baseStart: StartOptions = {
    ...(options.start ?? {}),
    storage, argv: options.argv, env: options.env, print, dataDirectory: dataDir,
    ...(config.controller.databaseTransfer === undefined || config.controller.databaseTransfer.targets.length === 0 ? {} : { transfer: { ...(options.start?.transfer ?? {}), stateDirectory: join(dataDir, "transfer"), targets: options.start?.transfer?.targets ?? [], targetEntries: config.controller.databaseTransfer.targets, secrets: (name: string) => secrets.resolve(name) } }),
    chat: { interpreter },
    ...(options.serve === undefined ? {} : { conversationTransport: options.serve }),
  };
  let controller = await startController(baseStart);
  live = controller;
  let hostPlan: LocalHostPlan | undefined;
  try {
    // The worker host on this machine is the owner's choice (a record, off by default), so it is known only once the records can be read: when it is on, the controller is started again with the host built in. The first start made nothing else.
    if (await controller.services.localHost.enabled()) {
      if (options.localHost === undefined) notes.push("You turned on the worker host for this computer, but this start has no way to build one, so tasks wait for a host.");
      else {
        // A builder that throws (a package that cannot be loaded, a folder that cannot be made) is a reason the host was not started, never a reason the owner has no controller.
        let made: LocalHostPlan | { readonly problem: string };
        try { made = await options.localHost({ dataDir, print, endpoint: endpointOf, controller: () => live!, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }); } catch (error) { made = { problem: `building it failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` }; }
        if ("problem" in made) notes.push(`You turned on the worker host for this computer, but it was not started: ${made.problem}`);
        else {
          await controller.close();
          try {
            controller = await startController({ ...baseStart, ...made.start, dispatch: { ...(made.start.dispatch ?? {}), ...(options.start?.dispatch ?? {}) } as NonNullable<StartOptions["dispatch"]>, ...(options.start?.tools === undefined ? {} : { tools: { ...(made.start.tools ?? {}), ...options.start.tools } as NonNullable<StartOptions["tools"]> }) });
            if (controller.dispatch === undefined) {
              // A dispatcher that could not be composed (for instance the host builder threw) is not an error of the start: the controller runs, and says why it has no dispatcher.
              await made.close().catch(() => undefined);
              notes.push(`You turned on the worker host for this computer, but the controller could not run agents with it, so it runs without one: ${String(controller.dispatchProblem ?? "no reason was given").slice(0, 300)}`);
            } else hostPlan = made;
          } catch (error) {
            await made.close().catch(() => undefined);
            notes.push(`You turned on the worker host for this computer, but the controller would not start with it, so it runs without one: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
            controller = await startController(baseStart);
          }
          live = controller;
        }
      }
    }
    const { token, created } = await ensureOwner(controller, secrets, ownerSecretName(dataDir));
    if (created) notes.push("You are now the owner of this installation. Your credential is in this computer's secret store, not in a file.");
    const owner = await controller.services.principals.authenticate(token);
    // The approval profile of the configuration counts once: when the installation has no policy record yet. `strict` is what no record means, so it needs none. A profile the owner set by chat is never replaced by the file.
    if (config.approvals !== undefined && config.approvals.preset !== "strict") {
      const policy = PolicyService.withEpoch(controller.storage, controller.epoch, controller.services.grants);
      if ((await policy.get(owner, "installation")) === undefined) {
        await policy.set(owner, { scope: "installation", commandId: "launcher-approval-preset", profile: config.approvals.preset } as never);
        notes.push(`The approval profile from the configuration (${config.approvals.preset}) was set; change it by telling the chat.`);
      }
    }
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
    if (hostPlan !== undefined) {
      // Attaching can be refused (the owner disabled host:local, the records are busy): the controller keeps running and the owner is told; the host's sandbox is freed when the controller closes.
      try { notes.push(...await hostPlan.attach(controller, owner)); } catch (error) { notes.push(`You turned on the worker host for this computer, but it could not join, so tasks wait for a host: ${String((error as Error)?.message ?? error).slice(0, 300)}`); }
    }
    await refresh();
    return { controller, ownerToken: token, ownerCreated: created, notes, close: async () => { try { await controller.close(); } finally { await hostPlan?.close().catch(() => undefined); } } };
  } catch (error) { await controller.close().catch(() => undefined); await hostPlan?.close().catch(() => undefined); throw error; }
}

/**
 * The owner exists once. The first start makes the owner's token, keeps it in the secret store and reads it back, and only then makes the owner with it: a store that cannot keep it stops the start
 * before any owner exists, and a crash at any point leaves either no owner (the next start begins again and replaces the unused token) or an owner whose token is already kept. A later start reads it back.
 */
export async function ensureOwner(controller: Controller, secrets: LauncherSecrets, secretName: string = OWNER_SECRET): Promise<{ token: string; created: boolean }> {
  const existing = await controller.storage.getAggregate({ kind: "installation", id: "installation" });
  if (existing === undefined) {
    const secret = newSecret();
    const token = makeToken(principalIdOf("owner", OWNER_NAME), secret);
    try { await secrets.set(secretName, token); if ((await secrets.resolve(secretName)) !== token) throw new Error("the value read back differs"); } catch (error) {
      throw new Error(`the secret store cannot keep the owner's credential, so no owner was made: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
    const issued = await controller.services.principals.bootstrapOwner({ name: OWNER_NAME, secret });
    return { token: issued.token, created: true };
  }
  const token = await secrets.resolve(secretName);
  if (token === undefined) throw new Error(`this installation has an owner, but the secret store has no credential named "${secretName}" for it (the name follows the data directory; a moved data directory looks for a new name). The credential is shown once and cannot be derived again: put it back under that name (nimblenewt secret set ${secretName}), or restore the installation's backup.`);
  try { await controller.services.principals.authenticate(token); } catch { throw new Error(`the credential "${secretName}" in the secret store is not the owner's current credential; restore the right one`); }
  return { token, created: false };
}

const OWNER_NAME = "owner";

export const launcherDir = (file: string): string => dirname(resolve(file));
