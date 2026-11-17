// The bench's guard for the shared Radiance server (card W01; the approach of the G10 bench and the M00 prototype).
// Radiance is the owner's local model server, shared with other agents. Before each run the bench reads GET /stats and
// GET /v1/models: a run starts only when the server says nothing is in flight, running or waiting, and the pinned model is
// one the server already serves. Nothing here loads, unloads, switches, resets or restarts anything: only those two GETs
// are ever sent. The bench runs one agent at a time, and a Pi agent sends one request at a time, so with the gate on the
// bench adds at most one request to the server at any moment.
// The key is read from Pi's own configuration (~/.pi/agent/models.json, provider "radiance") and is only ever put in the
// Authorization header; nothing here prints it, logs it or writes it to a file (errors carry the path and status only).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Pi's Radiance provider: its OpenAI base URL and key. Throws (without the key) when there is none. */
export function radianceConfig(home = homedir(), provider = "radiance") {
  const file = join(home, ".pi", "agent", "models.json");
  let models;
  // A parse error's message quotes the text around the fault, which may be the key: only the path is reported.
  try { models = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`Pi's models.json (${file}) could not be read as JSON${e?.code ? ` (${e.code})` : ""}`); }
  const p = models?.providers?.[provider];
  if (!p || typeof p.apiKey !== "string" || p.apiKey.length === 0) throw new Error(`no ${provider} provider with an apiKey in Pi's models.json`);
  // A header carries printable ASCII only, and fetch's refusal of any other character quotes the whole header value.
  if (!/^[\x21-\x7e]+$/.test(p.apiKey)) throw new Error(`the ${provider} apiKey in Pi's models.json holds a character an HTTP header cannot carry (a space, line break or non-ASCII)`);
  return { baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "http://127.0.0.1:8002/v1", apiKey: p.apiKey };
}

/** The server root: the OpenAI base URL without its trailing /v1. */
export const serverRoot = (baseUrl) => String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");

const PICK = ["version", "in_flight", "running", "waiting", "max_num_seqs", "total_requests", "kv_tokens_used", "kv_tokens_total", "kv_tokens_cached", "prefix_evictions", "checkpoints_written", "hit_cut_tokens", "linear_cached_tokens"];
/** The counters a record keeps (nothing else from the server's answer is stored). */
export const statsOf = (s) => (s && typeof s === "object" ? Object.fromEntries(PICK.filter((k) => k in s).map((k) => [k, s[k]])) : {});

/** Idle only when in_flight, running and waiting are all stated and 0; a missing or non-numeric count is busy. */
export function radianceIdle(stats) {
  const bad = ["in_flight", "running", "waiting"].map((k) => [k, stats?.[k]]).filter(([, v]) => v !== 0);
  if (bad.length === 0) return { ok: true, why: "in_flight, running and waiting are all 0" };
  return { ok: false, why: `the server is not idle or does not say so (${bad.map(([k, v]) => `${k}=${typeof v === "number" ? v : "missing"}`).join(", ")})` };
}

/** One GET, the key only in the Authorization header, redirects not followed, bounded in time. */
async function getJson(url, apiKey, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const path = new URL(url).pathname;
  // A failure is reported by its kind and code only: fetch's own messages can quote the request's header values.
  const failed = (what, e) => new Error(`GET ${path} ${what} (${[e?.name, e?.cause?.code ?? e?.code].filter((x) => typeof x === "string" && /^[\w.-]{1,40}$/.test(x)).join(" ") || "error"})`);
  let res;
  try { res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { throw failed("could not be sent", e); }
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  try { return await res.json(); } catch (e) { throw failed("did not answer JSON", e); }
}

/** Reads /stats and /v1/models once. */
export async function readRadiance(cfg, opts = {}) {
  const root = serverRoot(cfg.baseUrl);
  const stats = statsOf(await getJson(`${root}/stats`, cfg.apiKey, opts));
  let models = null;
  try { const m = await getJson(`${root}/v1/models`, cfg.apiKey, opts); models = Array.isArray(m?.data) ? m.data.map((d) => String(d?.id)) : null; } catch { models = null; }
  return { at: new Date().toISOString(), stats, models };
}

/**
 * Waits until the server is idle and serves the model, polling every pollMs for at most maxWaitMs.
 * Returns { ok, why, reading, waitedMs }. A model the server does not serve is refused at once (never waited for, and
 * never loaded: switching the server's model is not the bench's to do). An unreadable server is retried like a busy one.
 */
export async function waitForIdle({ read, model, maxWaitMs = 30 * 60_000, pollMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), log = () => {} }) {
  if (typeof model !== "string" || model === "") throw new Error("the Radiance gate needs the pinned model's name");
  const t0 = now();
  let why = "not read";
  for (;;) {
    let reading;
    try { reading = await read(); } catch (e) { reading = null; why = `the server could not be read (${String(e?.message ?? e).slice(0, 200)})`; }
    if (reading) {
      // The served models must be read: a list the server did not give is not a confirmation (retried like a busy server).
      if (!Array.isArray(reading.models)) why = "the server's model list (GET /v1/models) could not be read";
      else if (!reading.models.includes(model)) return { ok: false, why: `the server does not serve ${model}; the bench never loads or switches a model`, reading, waitedMs: now() - t0 };
      if (Array.isArray(reading.models)) {
        const idle = radianceIdle(reading.stats);
        if (idle.ok) return { ok: true, why: idle.why, reading, waitedMs: now() - t0 };
        why = idle.why;
      }
    }
    if (now() - t0 + pollMs > maxWaitMs) return { ok: false, why: `still not idle after ${Math.round((now() - t0) / 60000)} min: ${why}`, reading, waitedMs: now() - t0 };
    log(`Radiance busy (${why}); waiting ${Math.round(pollMs / 1000)} s`);
    await sleep(pollMs);
  }
}

/** What happened on the server between two readings (other users' requests in between are included). */
export function serverDelta(before, after) {
  const n = (o, k) => (typeof o?.stats?.[k] === "number" ? o.stats[k] : NaN);
  const d = (k) => { const v = n(after, k) - n(before, k); return Number.isFinite(v) ? v : null; };
  return { requests: d("total_requests"), checkpointsWritten: d("checkpoints_written"), prefixEvictions: d("prefix_evictions"), restarted: Number.isFinite(n(after, "total_requests")) && n(after, "total_requests") < n(before, "total_requests") };
}

/** The gate the batch loop calls before (and after) each run, built on Pi's config and the real server. */
export function radianceGate({ model, maxWaitMs, pollMs, log, home, fetchImpl } = {}) {
  if (typeof model !== "string" || model === "") throw new Error("the Radiance gate needs the pinned model's name");
  const cfg = radianceConfig(home);
  const read = () => readRadiance(cfg, { fetchImpl });
  return {
    before: () => waitForIdle({ read, model, maxWaitMs, pollMs, log }),
    after: async () => { try { return await read(); } catch { return null; } },
  };
}
