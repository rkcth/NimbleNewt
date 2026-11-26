// Card W09: the embedder that runs a task through NimbleNewt's real controller and worker on the Radiance route, with the model calls going through the controller's model relay.
//
// It is the product composition, not a stand-in: the launcher (`launch`, packages/controller/src/launcher) with the worker host on this computer (scripts/local-host.mjs: bubblewrap, the worker process running Pi, the
// relay, the done check of card W05). What it adds is only what an owner would otherwise do by hand or in chat:
//   - one model provider, `radiance`, recorded with kind `radiance` (so the relay names the length and reasoning budget fields the way a Radiance server reads them, card W07), the owner's real context window, and the key
//     kept in the secret store under a NAME (here an in-memory store for the run; the key is never written, printed or logged);
//   - the worker host turned on (`host.local.set`), and the second agent's route (`report.reviewerRoute`, card W10) set to the same Radiance route, so a done is questioned before it is recorded;
//   - a project bound to the task's repository with write access (card P02), an agent with its work grants, the task with its contract (the checks of card W05), and its assignment; the controller admits and runs it itself.
// Every model request of the run (the agent's, through the relay, and the second agent's, through the launcher's client) goes through ONE fetch, `radianceOnlyFetch`: it sends only `POST <base>/chat/completions` to the
// Radiance server's own address and nothing else (no cloud route, no other host), and one request at a time (a reply is read to its end, or abandoned, before the next request is sent). Nothing here loads, unloads, switches
// or restarts a model.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostBaseOf, localHostBuilder } from "../../local-host.mjs";

export const RADIANCE_PROVIDER = "radiance";
/**
 * The second route the product's setup rule requires (two routes on two servers, packages/controller/src/routing/lists.ts; no owner switch waives it). It names a local address nothing serves (the discard port), and the
 * run's fetch refuses every request to it, so a Radiance failure never moves the run to another server: the call fails, and the refusal is counted on the record.
 */
export const STANDBY_PROVIDER = "radiance-standby";
export const STANDBY_ENDPOINT = "http://127.0.0.1:9/v1";
export const RADIANCE_KIND = "radiance";
/** The secret store NAME the run keeps the Radiance key under (the value is in memory only). */
export const RADIANCE_KEY_NAME = "w09-radiance-key";
/** The grants an agent needs to work on a task of `project` (the same list the integration tests give their agents: work, effects, review, reading the task, its desk and its messages). */
export const AGENT_GRANTS = (project) => [
  { action: "attempt.work", project }, { action: "effect.perform", project }, { action: "review.request", project }, { action: "task.read", project },
  { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project },
];

/** The base address as compared: scheme, host and path, no trailing slash. Throws for one that is not http(s) or carries credentials, a query or a fragment. */
export function radianceBase(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl)); } catch { throw new Error("the Radiance address is not a URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("the Radiance address must be http or https");
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") throw new Error("the Radiance address must not carry credentials, a query or a fragment");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * The run's one fetch. Only `POST <base>/chat/completions` (exactly that address, no query) is sent; anything else is refused before it leaves the process, with the method and path only (never a header). Requests are sent one
 * at a time: the next waits until the previous reply's body has been read to its end, cancelled or failed, or its request was aborted. `onCall` is told each request (its number, whether it was streamed, its status, how
 * long it took) and must not throw (a throw is ignored).
 */
export function radianceOnlyFetch({ baseUrl, fetch: inner = globalThis.fetch, onCall, onRefused } = {}) {
  const base = radianceBase(baseUrl);
  const target = `${base}/chat/completions`;
  let chain = Promise.resolve();
  let n = 0;
  const tell = (x) => { try { onCall?.(x); } catch { /* ignored */ } };
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? "");
    const method = String(init.method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET")).toUpperCase();
    let path = "?";
    try { const u = new URL(url); path = `${u.host}${u.pathname}${u.search === "" ? "" : "?..."}`; } catch { /* not a URL */ }
    if (method !== "POST" || url.replace(/\/+$/, "") !== target) {
      try { onRefused?.({ method: method.slice(0, 10), path: path.slice(0, 200) }); } catch { /* ignored */ }
      throw new Error(`the W09 run sends only POST ${target} to the Radiance server; ${method} ${path.slice(0, 200)} was refused`);
    }
    let release;
    const mine = new Promise((ok) => { release = ok; });
    const before = chain;
    chain = chain.then(() => mine);
    await before;
    const number = ++n;
    let streamed = false;
    let tools = [];
    try {
      const parsed = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body ?? new Uint8Array()));
      streamed = parsed?.stream === true;
      // The names of the tools the request offers the model (no schema, no text): a run records what the agent could call.
      tools = Array.isArray(parsed?.tools) ? parsed.tools.map((t) => String(t?.function?.name ?? t?.name ?? "?").slice(0, 80)).slice(0, 100) : [];
    } catch { /* not JSON: told as not streamed */ }
    const t0 = Date.now();
    let freed = false;
    const free = (status) => { if (freed) return; freed = true; tell({ n: number, streamed, status, ms: Date.now() - t0, tools }); release(); };
    // Aborted while it waited its turn: the place is given back at once and nothing is sent.
    if (init.signal?.aborted === true) { free("aborted"); throw init.signal.reason ?? new DOMException("This operation was aborted", "AbortError"); }
    init.signal?.addEventListener?.("abort", () => free("aborted"), { once: true });
    let res;
    try { res = await inner(input, { ...init, redirect: "manual" }); } catch (error) { free("failed"); throw error; }
    if (res.body === null) { free(res.status); return res; }
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(c) {
        try { const { done, value } = await reader.read(); if (done) { free(res.status); c.close(); } else c.enqueue(value); } catch (error) { free("failed"); c.error(error); }
      },
      cancel(reason) { free("cancelled"); return reader.cancel(reason); },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

const memorySecrets = (seed) => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
const must = (r, what) => { if (r?.ok !== true) throw new Error(`${what} was refused: ${JSON.stringify(r?.error ?? r).slice(0, 400)}`); return r.result; };

/**
 * Starts an installation in `dataDir` (a fresh folder) the way an owner sets one up for Radiance, and returns it running with the worker host. Two starts: the first records the owner's choices (host on, the provider, the
 * route budget, the second agent's route), the second builds the host, as the launcher does for a real owner.
 *
 * @param {{ root: string, dataDir: string, baseUrl: string, model: string, contextTokens: number, maxTokens?: number, reasoningTokens?: number, apiKey?: string, fetch: typeof fetch, print?: (l: string) => void,
 *   prepareCheckout?: Function, bridgeFilter?: Function, start?: object, load?: (pkg: string) => Promise<any> }} o
 */
export async function openW09Installation(o) {
  if (!Number.isInteger(o.contextTokens) || o.contextTokens <= 0) throw new Error("contextTokens must be the route's real context window (a positive whole number)");
  if (typeof o.model !== "string" || !/^[\w.:-]{1,120}$/.test(o.model)) throw new Error("the model name must be a plain model ID");
  if (typeof o.fetch !== "function") throw new Error("give the run's fetch (radianceOnlyFetch)");
  mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  const load = o.load ?? ((pkg) => import(pathToFileURL(join(o.root, "packages", pkg, "dist", "index.js")).href));
  const { launch } = await load("controller");
  const secrets = memorySecrets(o.apiKey === undefined ? {} : { [RADIANCE_KEY_NAME]: o.apiKey });
  const config = { installation: { name: "w09", dataDir: o.dataDir }, controller: { storage: { kind: "sqlite", path: join(o.dataDir, "controller.sqlite") } }, models: { providers: {} } };
  const builder = localHostBuilder({ root: o.root, ...(o.load === undefined ? {} : { load: o.load }), ...(o.prepareCheckout === undefined ? {} : { prepareCheckout: o.prepareCheckout }), ...(o.bridgeFilter === undefined ? {} : { bridgeFilter: o.bridgeFilter }) });
  const print = o.print ?? (() => undefined);
  const route = `${RADIANCE_PROVIDER}/${o.model}`;
  const opts = { config, secrets, argv: [], env: {}, print, fetch: o.fetch, localHost: builder, ...(o.start === undefined ? {} : { start: o.start }) };
  const first = await launch(opts);
  try {
    const api = (op, args, id) => first.controller.api.handle(first.ownerToken, { v: 1, op, commandId: id, args });
    must(await api("host.local.set", { enabled: true }, "w09-host-on"), "turning the worker host on");
    must(await api("routing.provider.add", { providers: [
      { name: RADIANCE_PROVIDER, location: "local", endpoint: o.baseUrl, models: [o.model], contextTokens: o.contextTokens, paid: false, kind: RADIANCE_KIND, ...(o.apiKey === undefined ? {} : { credentialName: RADIANCE_KEY_NAME }) },
      { name: STANDBY_PROVIDER, location: "local", endpoint: STANDBY_ENDPOINT, models: [o.model], contextTokens: o.contextTokens, paid: false, kind: RADIANCE_KIND },
    ], expectedRevision: (await first.controller.services.routing.get())?.revision ?? 0 }, "w09-provider"), "recording the Radiance provider");
    if (o.maxTokens !== undefined || o.reasoningTokens !== undefined) must(await api("routing.budget.set", { route, ...(o.maxTokens === undefined ? {} : { maxTokens: o.maxTokens }), ...(o.reasoningTokens === undefined ? {} : { reasoningTokens: o.reasoningTokens }) }, "w09-budget"), "setting the route's budget");
    const owner = await first.controller.services.principals.authenticate(first.ownerToken);
    const staged = await first.controller.services.configuration.stage(owner, { commandId: "w09-reviewer", layer: "installation", set: { "report.reviewerRoute": route } });
    const applied = await first.controller.services.configuration.apply(owner, { commandId: "w09-reviewer-apply", layer: "installation", expectedRevision: staged.revision });
    if (applied.applied !== true) throw new Error("the second agent's route could not be set");
  } finally { await first.close(); }
  const launched = await launch(opts);
  if (launched.controller.dispatch === undefined) { const notes = launched.notes.join(" | ").slice(0, 600); await launched.close(); throw new Error(`the controller did not start with the worker host: ${notes}`); }
  const owner = await launched.controller.services.principals.authenticate(launched.ownerToken);
  return { launched, controller: launched.controller, owner, route, hostBase: hostBaseOf(o.dataDir), notes: launched.notes, close: () => launched.close() };
}

/** Where the product host keeps a task's checkout and its git directory (scripts/local-host.mjs, LocalWorkspaces). */
export const taskCheckout = (inst, projectId, taskId) => ({ checkout: join(inst.hostBase, "work", projectId, taskId, "checkout"), gitDir: join(inst.hostBase, "work", projectId, taskId, "task.git") });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gives one task to an agent on the running installation and waits until its first attempt has finished (W03's readmits and W11's wakes happen inside that attempt) or `timeoutMs` passes. Returns what the controller
 * recorded: the attempt (state, outcome, verifications, report, nudges, early stops), where the agent's checkout is, and whether the wall limit was reached (the attempt is then left to the caller, which closes the controller).
 *
 * @param {{ repository: string, title: string, description: string, checks?: { name: string, run: string[], timeoutSeconds: number }[], requiredEvidence?: string[], timeoutMs: number, pollMs?: number, tag?: string }} t
 */
export async function runW09Task(inst, t) {
  const c = inst.controller;
  const s = c.services;
  const owner = inst.owner;
  const tag = String(t.tag ?? "w09").replace(/[^\w-]/g, "-").slice(0, 40);
  const projectId = (await s.projects.createProject({ commandId: `${tag}-p`, actor: owner.id, name: `Bench ${tag}`.slice(0, 120), repositories: [{ id: "bench", location: t.repository }] })).id;
  await s.resources.bindResource(owner, { commandId: `${tag}-bind`, projectId, kind: "repository", label: "bench", locator: t.repository, repositoryId: "bench", access: "write" });
  const agentId = (await s.agents.create(owner, { commandId: `${tag}-agent`, friendlyName: "Bench", roles: ["author"] })).id;
  const principalId = `agent:${agentId}`;
  await s.principals.setGrants(owner, { commandId: `${tag}-grants`, principalId, expectedRevision: (await s.principals.get(principalId)).revision, grants: AGENT_GRANTS(projectId) });
  const taskId = (await s.projects.createTask({ commandId: `${tag}-t`, actor: owner.id, projectId, title: t.title, description: t.description })).id;
  const checks = t.checks ?? [];
  const evidence = t.requiredEvidence ?? [];
  if (checks.length > 0 || evidence.length > 0) await s.contracts.setContract(owner, { commandId: `${tag}-contract`, taskId, expectedVersion: 0, requiredEvidence: evidence, checks });
  await s.projects.transitionTask({ commandId: `${tag}-ready`, actor: owner.id, taskId, expectedRevision: (await s.projects.getTask(taskId)).revision, to: "ready" });
  const startedAt = Date.now();
  await s.assignments.assignTask({ commandId: `${tag}-assign`, actor: owner.id, taskId, owner: { kind: "agent", id: agentId } });
  const pollMs = t.pollMs ?? 1000;
  const deadline = startedAt + t.timeoutMs;
  let attemptId;
  let attempt;
  let timedOut = false;
  for (;;) {
    if (attemptId === undefined) attemptId = (await s.assignments.getAssignment(taskId))?.activeAttemptId;
    if (attemptId !== undefined) {
      attempt = await c.dispatch.dispatcher.get(c.dispatch.principal, attemptId);
      if (attempt?.state === "finished") break;
    }
    if (Date.now() >= deadline) { timedOut = true; break; }
    await sleep(pollMs);
  }
  if (!timedOut) await c.dispatch.dispatcher.idle().catch(() => undefined);
  if (attemptId !== undefined) attempt = await c.dispatch.dispatcher.get(c.dispatch.principal, attemptId);
  return { projectId, taskId, agentId, attemptId, attempt, timedOut, wallMs: Date.now() - startedAt, ...taskCheckout(inst, projectId, taskId) };
}

/** The parts of the attempt record a bench run keeps (bounded: no conversation, no notes' full text). */
export function attemptSummary(a) {
  if (a === undefined || a === null) return null;
  const last = (a.verifications ?? []).at(-1);
  return {
    state: a.state ?? null,
    status: a.outcome?.status ?? null,
    summary: String(a.outcome?.summary ?? "").slice(0, 500),
    reportResult: a.report?.result ?? null,
    questioning: a.report?.questioning ?? null,
    questions: (a.report?.qa ?? []).length,
    verifications: (a.verifications ?? []).map((v) => v.state),
    lastChecks: last === undefined ? [] : (last.checks ?? []).map((x) => ({ name: x.name, state: x.state })),
    nudges: a.nudgesUsed ?? 0,
    stoppedEarly: (a.stoppedEarly ?? []).length,
    readmitted: (a.stoppedEarly ?? []).filter((r) => r.readmitted).length,
    endKind: a.turnEnd?.endKind ?? null,
    notes: (a.notes ?? []).length,
  };
}
