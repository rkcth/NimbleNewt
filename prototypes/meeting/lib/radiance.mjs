// Radiance helpers for the throwaway meeting prototype (card M00, third local batch). Radiance is the owner's local model server.
// - The key is read from Pi's own configuration (~/.pi/agent/models.json, provider "radiance"), as card G10's bench does. It is
//   returned to the caller only to be put in the Authorization header; nothing here prints or writes it.
// - The server has no llama.cpp /slots route, so the idle check reads GET /stats instead: a run starts only when the server says
//   nothing is in flight, running or waiting. Missing or non-numeric counts count as busy.
// - Only GET /stats and GET /sessions are sent. Nothing here loads, unloads, switches, resets or restarts anything.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function radianceConfig(home = homedir()) {
  const models = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"));
  const p = models?.providers?.radiance;
  if (!p || typeof p.apiKey !== "string" || p.apiKey.length === 0) throw new Error("no radiance provider with an apiKey in Pi's models.json");
  return { baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "http://127.0.0.1:8002/v1", apiKey: p.apiKey };
}

// The server root: the OpenAI base URL without its trailing /v1.
export const serverRoot = (baseUrl) => String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");

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
