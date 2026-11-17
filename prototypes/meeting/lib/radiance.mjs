// Radiance helpers for the throwaway meeting prototype (card M00, third local batch). Radiance is the owner's local model server.
// - The key is read from Pi's own configuration (~/.pi/agent/models.json, provider "radiance"), as card G10's bench does. It is
//   returned to the caller only to be put in the Authorization header; nothing here prints or writes it.
// - The server has no llama.cpp /slots route, so the idle check reads GET /stats instead: a run starts only when the server says
//   nothing is in flight, running or waiting. Missing or non-numeric counts count as busy.
// - Only GET /stats and GET /sessions are sent. Nothing here loads, unloads, switches, resets or restarts anything.
import { readFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

export function radianceConfig(home = homedir()) {
  const models = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"));
  const p = models?.providers?.radiance;
  if (!p || typeof p.apiKey !== "string" || p.apiKey.length === 0) throw new Error("no radiance provider with an apiKey in Pi's models.json");
  return { baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "http://127.0.0.1:8002/v1", apiKey: p.apiKey };
}

// The server root: the OpenAI base URL without its trailing /v1.
export const serverRoot = (baseUrl) => String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");

// Whether an OpenAI base URL names the Radiance server in Pi's config (same port, same host, any spelling of this machine counting as
// one: the whole 127/8 range, localhost and *.localhost with or without a trailing dot, ::1, the unspecified addresses, IPv4-mapped
// loopback, and this machine's own host name and interface addresses, since the server listens on every interface).
// No Pi config (or an unreadable URL) means no known Radiance address, so false.
const OWN = () => {
  try { return new Set([hostname().toLowerCase(), ...Object.values(networkInterfaces()).flat().map((a) => a.address.toLowerCase().replace(/%.*$/, ""))]); } catch { return new Set(); }
};
const isThisMachine = (h) => {
  const bare = h.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return /^127\.\d+\.\d+\.\d+$/.test(bare) || bare === "0.0.0.0" || bare === "::" || bare === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(bare)
    || bare === "localhost" || bare.endsWith(".localhost") || OWN().has(bare);
};
export function isRadianceAddress(baseUrl, home = homedir()) {
  if (typeof baseUrl !== "string") return false;
  let target, mine;
  try { target = new URL(serverRoot(baseUrl)); mine = new URL(serverRoot(radianceConfig(home).baseUrl)); } catch { return false; }
  const host = (u) => (isThisMachine(u.hostname) ? "this machine" : u.hostname.replace(/\.$/, ""));
  const port = (u) => u.port || (u.protocol === "https:" ? "443" : "80");
  return host(target) === host(mine) && port(target) === port(mine);
}

const PICK = ["version", "in_flight", "running", "waiting", "max_num_seqs", "total_requests", "kv_tokens_used", "kv_tokens_total", "kv_tokens_cached", "prefix_evictions", "checkpoints_written", "ckpt_evictions", "ckpt_refused", "hit_cuts", "hit_cut_tokens", "linear_cached_tokens"];
export const statsOf = (s) => (s && typeof s === "object" ? Object.fromEntries(PICK.map((k) => [k, s[k]])) : {});

// Idle only when all three counts are stated and are 0; anything else is busy (a wrong pass would share the server with someone).
export function radianceIdle(stats) {
  const counts = ["in_flight", "running", "waiting"].map((k) => [k, stats?.[k]]);
  const bad = counts.filter(([, v]) => v !== 0);
  if (bad.length === 0) return { ok: true, why: "in_flight, running and waiting are all 0" };
  return { ok: false, why: `the server is not idle or does not say so (${bad.map(([k, v]) => `${k}=${typeof v === "number" ? v : "missing"}`).join(", ")})` };
}

// The cache footprint other users care about: how many conversations the server keeps and how many resumable snapshots they hold.
export function sessionsOf(body) {
  const list = Array.isArray(body?.sessions) ? body.sessions : [];
  return { count: list.length, snapshots: list.reduce((s, e) => s + (Number(e?.snapshots) || 0), 0), tokens: list.reduce((s, e) => s + (Number(e?.tokens) || 0), 0) };
}

// One GET each of /stats and /sessions, key only in the Authorization header, redirects not followed.
export async function readRadiance(root, apiKey, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const get = async (path) => {
    const res = await fetchImpl(`${serverRoot(root)}${path}`, { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return res.json();
  };
  const stats = await get("/stats");
  let sessions;
  try { sessions = sessionsOf(await get("/sessions")); } catch { sessions = undefined; }
  return { at: new Date().toISOString(), stats: statsOf(stats), sessions };
}

// The refusal of the idle check; run.mjs and checkpoint.mjs turn it into exit code 3 before anything else is sent or written.
export class RadianceRefused extends Error {
  constructor(why) { super(`Radiance check: REFUSED (${why})`); this.name = "RadianceRefused"; this.why = why; }
}

// The idle check, once per process, on every way of reaching Radiance: run.mjs --provider radiance, a radiance:<model> spec in a
// mixed roster (--chair / --members), and checkpoint.mjs --spec radiance:<model>. specs.mjs awaits it before it builds a Radiance
// provider, so no route can build one without it. The result (or the refusal) is kept, so the reading is taken only once.
let gate;
export function radianceGate({ read = readRadiance } = {}) {
  gate ??= (async () => {
    const cfg = radianceConfig();
    let before;
    try { before = await read(cfg.baseUrl, cfg.apiKey); } catch (e) { throw new RadianceRefused(e.message); }
    const idle = radianceIdle(before.stats);
    if (!idle.ok) throw new RadianceRefused(idle.why);
    return { cfg, before, why: idle.why };
  })();
  return gate;
}

// One request at a time on the shared server: every call through any Radiance provider in this process waits until the previous one
// has ended, whatever the variant's `parallel` says (the blind round and the ballots otherwise run up to 4 calls at once).
let tail = Promise.resolve();
export function oneAtATime(provider) {
  return {
    ...provider,
    chat(req) {
      const run = tail.then(() => provider.chat(req));
      tail = run.catch(() => {});
      return run;
    },
  };
}

// What one run did to the shared server, from a reading before and one after (other users' requests in between are included).
export function serverDelta(before, after) {
  const n = (o, k) => (typeof o?.stats?.[k] === "number" ? o.stats[k] : NaN);
  const ev = (o, k) => (typeof o?.stats?.ckpt_evictions?.[k] === "number" ? o.stats.ckpt_evictions[k] : NaN);
  return {
    requests: n(after, "total_requests") - n(before, "total_requests"),
    checkpointsWritten: n(after, "checkpoints_written") - n(before, "checkpoints_written"),
    evictionsRetention: ev(after, "retention") - ev(before, "retention"),
    evictionsStoreFull: ev(after, "store_full") - ev(before, "store_full"),
    sessionsBefore: before?.sessions?.count, sessionsAfter: after?.sessions?.count,
    snapshotsBefore: before?.sessions?.snapshots, snapshotsAfter: after?.sessions?.snapshots,
  };
}
