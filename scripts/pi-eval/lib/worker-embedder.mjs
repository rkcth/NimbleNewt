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
 * W09 bench measurement: each sent request is also told with `ok` (a 2xx reply), `bytes` (of the reply body read), `usage` (the provider's own counts read from the reply, `usageOf`, or null) and `outage` (the server was not
 * there: the connection failed before any reply, or it answered 502, 503 or 504; see `OUTAGE_STATUSES`). Nothing of the reply's text is kept beyond the bounded scan the counts are read from.
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
    // The next request waits for the one before this one AND this one, so a request that leaves the queue early never lets the next one start while an earlier one is still out.
    chain = chain.then(() => mine);
    const signal = init.signal;
    const abortedError = () => signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
    // Aborted while it waits its turn: it is refused at once (its caller is not kept waiting for the request in flight), it gives its place back, nothing is sent and it is told as not sent.
    if (signal !== undefined && signal !== null) {
      let onAbort;
      const aborted = new Promise((ok) => { onAbort = () => ok(true); if (signal.aborted === true) ok(true); else signal.addEventListener?.("abort", onAbort, { once: true }); });
      const gotAborted = await Promise.race([before.then(() => false), aborted]);
      signal.removeEventListener?.("abort", onAbort);
      if (gotAborted || signal.aborted === true) { tell({ n: null, sent: false, streamed: false, status: "aborted", ms: 0, tools: [] }); release(); throw abortedError(); }
    } else await before;
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
    let res;
    let replied = false;
    const scan = replyScan();
    const onSentAbort = () => free("aborted");
    const free = (status) => {
      if (freed) return; freed = true; signal?.removeEventListener?.("abort", onSentAbort);
      // An outage: nothing answered (the connection failed before any reply) or the reply's status says the server is not there (whatever error page came with it). A 2xx reply that broke part way is a failed call, not an outage.
      const outage = replied ? OUTAGE_STATUSES.includes(res.status) : status === "failed";
      tell({ n: number, sent: true, streamed, status, ms: Date.now() - t0, tools, ok: replied && res.ok === true, bytes: scan.bytes(), usage: scan.usage(), outage });
      release();
    };
    signal?.addEventListener?.("abort", onSentAbort, { once: true });
    try { res = await inner(input, { ...init, redirect: "manual" }); replied = true; } catch (error) { free("failed"); throw error; }
    if (res.body === null) { free(res.status); return res; }
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(c) {
        try { const { done, value } = await reader.read(); if (done) { free(res.status); c.close(); } else { scan.add(value); c.enqueue(value); } } catch (error) { free("failed"); c.error(error); }
      },
      cancel(reason) { free("cancelled"); return reader.cancel(reason); },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** W09 bench measurement: the reply statuses that say the server is not there (a gateway in front of it, or the server itself, answering that it cannot serve). ASSUMPTION: 503 and 504 count with 502; a 500 or 4xx is the server answering. */
export const OUTAGE_STATUSES = Object.freeze([502, 503, 504]);
const SCAN_BYTES = 16 * 1024;

/**
 * The provider's own token counts in a reply's text (OpenAI style, as Radiance answers: `prompt_tokens`, `completion_tokens`, `cached_tokens`, `reasoning_tokens`; Anthropic style `input_tokens`/`output_tokens` with the cache
 * counts added), the largest figure of each name (a stream repeats or grows them). Null when the reply states no input or output count. Each figure is at most 9 digits, so no count is read from a cut or a hostile number.
 */
export function usageOf(text) {
  const most = (name) => { let best = 0; for (const m of String(text).matchAll(new RegExp(`"${name}"\\s*:\\s*(\\d{1,9})(?=[,}\\s])`, "g"))) best = Math.max(best, Number(m[1])); return best; };
  const cacheRead = most("cache_read_input_tokens");
  const input = most("prompt_tokens") || most("input_tokens") + cacheRead + most("cache_creation_input_tokens");
  const output = most("completion_tokens") || most("output_tokens");
  if (input === 0 && output === 0) return null;
  return { input, output, cacheRead: most("cached_tokens") || cacheRead, reasoning: most("reasoning_tokens") };
}

/** The first and last 16 KiB of a reply as it is read (the counts are at a stream's end or in a small plain reply), and its size. */
function replyScan() {
  const head = []; let headBytes = 0; let tail = new Uint8Array(0); let bytes = 0;
  return {
    add(piece) {
      if (!(piece instanceof Uint8Array)) return;
      bytes += piece.length;
      if (headBytes < SCAN_BYTES) { const part = piece.slice(0, SCAN_BYTES - headBytes); head.push(part); headBytes += part.length; }
      const joined = new Uint8Array(tail.length + Math.min(piece.length, SCAN_BYTES));
      joined.set(tail); joined.set(piece.length > SCAN_BYTES ? piece.subarray(-SCAN_BYTES) : piece, tail.length);
      tail = joined.subarray(-SCAN_BYTES);
    },
    bytes: () => bytes,
    usage() {
      if (bytes === 0) return null;
      const d = new TextDecoder();
      return usageOf(`${head.map((h) => d.decode(h, { stream: true })).join("")}${d.decode()}\u0001${new TextDecoder().decode(tail)}`);
    },
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
  // The standby route must stay unreachable: the run's fetch lets through only the Radiance address, so the two may never be the same server.
  if (new URL(radianceBase(o.baseUrl)).host === new URL(STANDBY_ENDPOINT).host) throw new Error("the Radiance address must not be the standby route's address");
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
  // Card W09b: the attempt's checkout tool calls, counted by action and how each ended (`run:uncertain`), from the controller's operation records: no arguments, no output.
  let checkoutCalls = null;
  if (attemptId !== undefined) {
    try {
      checkoutCalls = {};
      for (const o of (await c.dispatch.dispatcher.operations(c.dispatch.principal, attemptId)) ?? []) {
        const name = String(o.tool?.name ?? "");
        if (!name.startsWith("nimblenewt.checkout-")) continue;
        const key = `${name.slice("nimblenewt.checkout-".length)}:${o.state}`;
        checkoutCalls[key] = (checkoutCalls[key] ?? 0) + 1;
      }
    } catch { checkoutCalls = null; }
  }
  // W09 bench measurement: the time the attempt's tool calls took, by checkout action, and the day's spend record under the daily cap, both read while the installation is still open (it is removed after the run).
  let toolTime = null;
  if (attemptId !== undefined) {
    try { toolTime = toolTimeOf((await c.dispatch.dispatcher.operations(c.dispatch.principal, attemptId)) ?? []); } catch { toolTime = null; }
  }
  const dailySpend = await dailySpendOf(inst);
  return { projectId, taskId, agentId, attemptId, attempt, timedOut, wallMs: Date.now() - startedAt, checkoutCalls, toolTime, dailySpend, ...taskCheckout(inst, projectId, taskId) };
}

/** The most figures `msStats` keeps of a run, and the most keys `toolTimeOf` makes (a hostile or broken record cannot make a results line large). */
export const MEASURE_LIMITS = Object.freeze({ samples: 1000, toolKeys: 12 });
const ms = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), Number.MAX_SAFE_INTEGER) : undefined);

/**
 * W09 bench measurement: the count, median, 95th percentile (nearest rank), largest and total of a list of durations in milliseconds; a figure that is not a duration (not a number, negative, not finite) is left out and counted as
 * `dropped`. With none the figures are null.
 */
export function msStats(values) {
  const xs = []; let dropped = 0;
  for (const v of Array.isArray(values) ? values : []) { const m = ms(v); if (m === undefined) dropped++; else xs.push(m); }
  xs.sort((a, b) => a - b);
  const n = xs.length;
  const at = (p) => xs[Math.max(0, Math.ceil(p * n) - 1)];
  const median = n === 0 ? null : n % 2 ? xs[(n - 1) / 2] : Math.round((xs[n / 2 - 1] + xs[n / 2]) / 2);
  return { calls: n, medianMs: median, p95Ms: n === 0 ? null : at(0.95), maxMs: n === 0 ? null : xs[n - 1], totalMs: Math.min(xs.reduce((a, x) => a + x, 0), Number.MAX_SAFE_INTEGER), ...(dropped > 0 ? { dropped } : {}) };
}

/**
 * W09 bench measurement: how long the attempt's tool calls took, from the controller's operation records: the checkout tool's calls by action (`read`, `write`, `edit`, `run`, ...), every other tool together as `other`. A call's time
 * is the controller's own measure (`usage.durationMs`), else its end less its start; a call with neither (still running, uncertain) is counted `untimed`. At most `MEASURE_LIMITS.toolKeys` keys; the rest go to `other`.
 */
export function toolTimeOf(operations) {
  const groups = new Map();
  for (const o of Array.isArray(operations) ? operations : []) {
    const name = String(o?.tool?.name ?? "");
    let key = name.startsWith("nimblenewt.checkout-") ? name.slice("nimblenewt.checkout-".length).replace(/[^a-z0-9-]/g, "-").slice(0, 20) : "other";
    if (key === "" || (!groups.has(key) && key !== "other" && groups.size >= MEASURE_LIMITS.toolKeys - 1)) key = "other";
    if (!groups.has(key)) groups.set(key, { times: [], untimed: 0 });
    const g = groups.get(key);
    let took = ms(o?.usage?.durationMs);
    if (took === undefined && typeof o?.startedAt === "string" && typeof o?.endedAt === "string") took = ms(Date.parse(o.endedAt) - Date.parse(o.startedAt));
    if (took === undefined) g.untimed++; else g.times.push(took);
  }
  const out = {};
  for (const [k, g] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) { const st = msStats(g.times); out[k] = { calls: st.calls + g.untimed, timed: st.calls, totalMs: st.totalMs, medianMs: st.medianMs, p95Ms: st.p95Ms, maxMs: st.maxMs, untimed: g.untimed }; }
  return out;
}

/**
 * W09 bench measurement: the day's spend record under the daily cap on the controller's own model calls (the second agent's), as the owner reads it (`chat.budget.get`): the UTC day, the tokens and calls counted, the cap and what is
 * left. Read before the installation is closed; a failure gives `{ error }` (bounded, scrubbed), never a throw.
 */
export async function dailySpendOf(inst) {
  const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  try {
    const r = await inst.controller.api.handle(inst.launched.ownerToken, { v: 1, op: "chat.budget.get", args: {} });
    const item = r?.ok === true ? r.result?.item : undefined;
    if (item === undefined || item === null || typeof item !== "object") return { error: scrubbed(`chat.budget.get answered ${JSON.stringify(r?.error ?? r ?? null)}`, 200) };
    return { day: /^\d{4}-\d{2}-\d{2}$/.test(String(item.day)) ? item.day : null, tokens: num(item.tokens), calls: num(item.calls), maxTokensPerDay: num(item.maxTokensPerDay), remaining: num(item.remaining) };
  } catch (error) { return { error: scrubbed(`chat.budget.get failed: ${String(error?.message ?? error)}`, 200) }; }
}

/** Text the bench keeps from a record: control characters made spaces, anything that looks like a key or a bearer token replaced, cut to `max` (the controller already redacted it; this is a second guard for the results file). */
export function scrubbed(text, max = 300) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\b(?:sk|pk|rk|api|key|tok)[-_][A-Za-z0-9_-]{12,}/gi, "[redacted]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]").slice(0, max);
}

/** The reply-cut record of the attempt's last turn (W09 fixes), checked; null when there is none. */
function replyCutOf(v) {
  const ok = (n) => Number.isSafeInteger(n) && n >= 0;
  return v !== null && typeof v === "object" && ok(v.cuts) && ok(v.limit) && ok(v.ceiling) ? { cuts: v.cuts, limit: v.limit, ceiling: v.ceiling } : null;
}

/** The attempt's own tally (`used`: cost in micro-units and compute in ms), checked; null when there is none. */
function usedOf(v) {
  const ok = (n) => Number.isSafeInteger(n) && n >= 0;
  return v !== null && typeof v === "object" && ok(v.costMicros) && ok(v.computeMs) ? { costMicros: v.costMicros, computeMs: v.computeMs } : null;
}

/** The parts of the attempt record a bench run keeps (bounded: no conversation, no notes' full text). */
export function attemptSummary(a) {
  if (a === undefined || a === null) return null;
  const last = (a.verifications ?? []).at(-1);
  // W09 fixes: why the second agent's questioning did not run, and its named cause, from the report (or the questioning when no report was recorded), so a `not-run` says why without --keep.
  const why = a.report?.why ?? a.interrogation?.why;
  const cause = a.report?.cause ?? a.interrogation?.cause;
  return {
    state: a.state ?? null,
    status: a.outcome?.status ?? null,
    summary: String(a.outcome?.summary ?? "").slice(0, 500),
    reportResult: a.report?.result ?? null,
    questioning: a.report?.questioning ?? null,
    questions: (a.report?.qa ?? []).length,
    questioningWhy: why === undefined || why === null ? null : scrubbed(why, 300),
    questioningCause: typeof cause === "string" ? scrubbed(cause, 40) : null,
    verifications: (a.verifications ?? []).map((v) => v.state),
    lastChecks: last === undefined ? [] : (last.checks ?? []).map((x) => ({ name: x.name, state: x.state })),
    nudges: a.nudgesUsed ?? 0,
    stoppedEarly: (a.stoppedEarly ?? []).length,
    readmitted: (a.stoppedEarly ?? []).filter((r) => r.readmitted).length,
    endKind: a.turnEnd?.endKind ?? null,
    replyCut: replyCutOf(a.turnEnd?.replyCut),
    notes: (a.notes ?? []).length,
    // W09 bench measurement: what the controller tallied for the attempt (cost and compute; a local worker reports no token counts, so those are counted at the run's fetch).
    used: usedOf(a.used),
  };
}
