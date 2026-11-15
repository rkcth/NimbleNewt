/**
 * The pure rules of the meeting procedure (card M06), so they can be tested without any storage.
 *
 * - Seating: where a roster allows, the speaking and ballot order puts members of different model families (then different information) next to each other (m00 proposal 10; ASSUMPTION: a default the owner can switch off).
 * - Round summary: a plain, factual digest of one comment round for the objection check (the chair's own neutral summary is M05's; this one is mechanical so that the check never waits on a model).
 * - Quoting a ballot: whether an owner's message repeats the words of a ballot cast in an open vote.
 * - Echo: whether a meeting looked like an echo (every first-round stance and every ballot identical, m00 proposal 10).
 */

export interface SeatTraits { readonly family?: string; readonly info?: string }

/**
 * The order members sit in. `listed` keeps the roster's order. `diverse` interleaves groups so that, as far as the roster allows, no two members next to each other share a model family (and, within a family, the same information
 * source): the largest group first, then round-robin, ties kept in roster order. Members whose traits are unknown form one group of their own, so a roster with no traits is seated as listed.
 */
export function seatOrder(members: readonly string[], mode: "diverse" | "listed", traits: (member: string) => SeatTraits | undefined = () => undefined): string[] {
  if (mode === "listed" || members.length < 3) return [...members];
  const interleave = (list: readonly string[], key: (m: string) => string): string[] => {
    const groups = new Map<string, string[]>();
    for (const m of list) groups.set(key(m), [...(groups.get(key(m)) ?? []), m]);
    const ordered = [...groups.values()].map((g, i) => ({ g, i })).sort((a, b) => b.g.length - a.g.length || a.i - b.i).map((x) => [...x.g]);
    const out: string[] = [];
    while (ordered.some((g) => g.length > 0)) for (const g of ordered) { const next = g.shift(); if (next !== undefined) out.push(next); }
    return out;
  };
  const families = new Map<string, string[]>();
  for (const m of members) { const f = traits(m)?.family ?? ""; families.set(f, [...(families.get(f) ?? []), m]); }
  // Inside a family the members are first spread over their information; then the families are interleaved.
  const spread = [...families.values()].map((g) => interleave(g, (m) => traits(m)?.info ?? ""));
  const out: string[] = [];
  const order = spread.map((g, i) => ({ g: [...g], i })).sort((a, b) => b.g.length - a.g.length || a.i - b.i);
  while (order.some((x) => x.g.length > 0)) for (const x of order) { const next = x.g.shift(); if (next !== undefined) out.push(next); }
  return out;
}

const words = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 0);

/** A factual digest of one round: each speaker's opening words, attributed, in the order they spoke. No recommendation and nothing about how to vote. */
export function roundSummary(round: number, turns: readonly { readonly speaker: string; readonly text: string }[], skipped: readonly string[], each = 160): string {
  const lines = turns.map((t) => `${t.speaker}: ${t.text.replace(/\s+/g, " ").trim().slice(0, each)}${t.text.replace(/\s+/g, " ").trim().length > each ? "..." : ""}`);
  const gone = skipped.length === 0 ? "" : ` Not heard (absent or silent): ${skipped.join(", ")}.`;
  return `Round ${round}: ${turns.length} member${turns.length === 1 ? "" : "s"} spoke.${gone}${lines.length === 0 ? "" : `\n${lines.join("\n")}`}`;
}

/**
 * Whether `message` repeats a cast ballot's reason: a run of at least `min(5, words in the reason)` (never fewer than 3) of the reason's words, in order, appears in the message. A message that only says "the vote is open" quotes nothing.
 */
export function quotesBallot(message: string, reason: string): boolean {
  const r = words(reason);
  if (r.length < 3) return false;
  const run = Math.min(5, r.length);
  const m = ` ${words(message).join(" ")} `;
  for (let i = 0; i + run <= r.length; i++) if (m.includes(` ${r.slice(i, i + run).join(" ")} `)) return true;
  return false;
}

/**
 * The echo flag: at least three voters, every first-round stance the same (all stances known) and every ballot the same value. It says the meeting added little beyond one view, not that anything was wrong; with a stance missing
 * or fewer than three voters it is not raised.
 */
export function looksLikeEcho(stances: readonly string[], ballots: readonly string[], seats: number): boolean {
  if (seats < 3 || ballots.length < 3 || stances.length < Math.min(seats, ballots.length)) return false;
  return new Set(stances).size === 1 && new Set(ballots).size === 1;
}
