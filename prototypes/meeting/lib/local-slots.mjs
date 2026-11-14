// Slot-state guard for runs against the local model server (card M00; the local cache measurement belongs to G10).
// llama.cpp style servers answer GET <base>/slots with one object per slot. A run must never evict another user's cached
// conversation, so it starts only when enough slots are idle and empty, and it never loads, unloads or switches a model.
// A slot counts as free when it is not processing and holds no cached prompt tokens; anything unreadable counts as busy.

export function slotsFree(slots, needed = 1) {
  if (!Array.isArray(slots) || slots.length === 0) return { ok: false, free: 0, total: 0, why: "the slot list is missing or empty, so nothing is known about who is using the server" };
  const isFree = (s) => {
    if (s === null || typeof s !== "object") return false;
    if (s.is_processing === true || s.state === 1 || s.state === "processing") return false;
    const cached = Number(s.n_past ?? s.n_cached ?? s.cache_n ?? s.next_token?.n_past ?? 0) || 0;
    const prompt = typeof s.prompt === "string" ? s.prompt.length : 0;
    return cached === 0 && prompt === 0 && !(s.is_processing === undefined && s.state === undefined);
  };
  const free = slots.filter(isFree).length;
  return free >= needed
    ? { ok: true, free, total: slots.length, why: `${free} of ${slots.length} slots are idle and empty, ${needed} needed` }
    : { ok: false, free, total: slots.length, why: `only ${free} of ${slots.length} slots are idle and empty, ${needed} needed; a run would evict a cached conversation` };
}

export async function checkSlots(baseUrl, needed = 1, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/slots`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, free: 0, total: 0, why: `the slot list answered ${res.status}` };
    return slotsFree(await res.json(), needed);
  } catch (e) {
    return { ok: false, free: 0, total: 0, why: `the slot list could not be read (${e?.name ?? "error"})` };
  }
}
