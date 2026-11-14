// Slot-state guard for runs against the local model server (card M00; the local cache measurement belongs to G10).
// llama.cpp style servers answer GET <base>/slots with one object per slot. A run must never evict another user's cached
// conversation, so it starts only when enough slots are idle and empty, and it never loads, unloads or switches a model.
// A slot counts as free only when it says it is not processing AND says it holds no cached prompt; a missing, malformed or
// unknown field counts as busy (a wrong refusal costs a retry, a wrong pass evicts someone's cache).

const CACHE_FIELDS = ["n_past", "n_cached", "cache_n"];

function slotIsFree(s) {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return false;
  // Idle must be stated: is_processing === false, or (older servers) state 0 / "idle" with no is_processing field.
  const idle = s.is_processing === false || (s.is_processing === undefined && (s.state === 0 || s.state === "idle"));
  if (!idle) return false;
  // Empty must be stated too: at least one cache count or a prompt string present, every count a number equal to 0, no non-empty prompt.
  const counts = [...CACHE_FIELDS.map((k) => s[k]), s.next_token?.n_past].filter((v) => v !== undefined && v !== null);
  if (counts.length === 0 && typeof s.prompt !== "string") return false;
  if (!counts.every((v) => v === 0)) return false;
  if (s.prompt !== undefined && s.prompt !== null && s.prompt !== "") return false;
  return true;
}

export function slotsFree(slots, needed = 1) {
  if (!Number.isInteger(needed) || needed < 1) return { ok: false, free: 0, total: 0, why: `the number of slots needed (${needed}) is not a whole number of at least 1` };
  if (!Array.isArray(slots) || slots.length === 0) return { ok: false, free: 0, total: 0, why: "the slot list is missing or empty, so nothing is known about who is using the server" };
  const free = slots.filter(slotIsFree).length;
  return free >= needed
    ? { ok: true, free, total: slots.length, why: `${free} of ${slots.length} slots are idle and empty, ${needed} needed` }
    : { ok: false, free, total: slots.length, why: `only ${free} of ${slots.length} slots are idle and empty, ${needed} needed; a run would evict a cached conversation` };
}

// Sends one GET of <base>/slots and nothing else; a redirect is not followed (it counts as a refusal).
export async function checkSlots(baseUrl, needed = 1, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/slots`;
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, free: 0, total: 0, why: `the slot list answered ${res.status}` };
    return slotsFree(await res.json(), needed);
  } catch (e) {
    return { ok: false, free: 0, total: 0, why: `the slot list could not be read (${e?.name ?? "error"})` };
  }
}
