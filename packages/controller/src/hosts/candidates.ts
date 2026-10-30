/**
 * Choosing a host from an ordered candidate list (card H07b). The caller supplies the candidates in preference order and a judge that says,
 * for one candidate, whether it would take the attempt; the first that takes it is chosen, every earlier refusal is kept with its reason, and
 * when all refuse the result is one wait with a single reason. Pure: no I/O of its own, so the order and the fallback are testable with fakes.
 */

export type HostVerdict =
  | { readonly kind: "take" }
  /** `kind: "revoked"` is a host that will never take work again; `lasting` says whether the reason stays until something is changed (policy, capability) or passes by itself (not connected, not heard from lately). */
  | { readonly kind: "refuse"; readonly reason: string; readonly lasting: boolean; readonly revoked?: boolean };

export interface HostRefusal { readonly hostId: string; readonly reason: string; readonly lasting: boolean; readonly revoked: boolean }

export type HostChoice<T> =
  | { readonly kind: "chosen"; readonly candidate: T; /** The refusals of the candidates tried before it, in order. */ readonly refusals: readonly HostRefusal[] }
  | {
    readonly kind: "wait";
    readonly refusals: readonly HostRefusal[];
    /** The one reason the attempt waits, every candidate's reason in order. */
    readonly reason: string;
    /** No candidate, or every one revoked: only a change of hosts helps. */
    readonly blocked: boolean;
    /** Every candidate refused for a lasting reason (revoked counts): the owner should be told after the allowed ticks. A mix with passing reasons is a plain wait. */
    readonly lastingRefusal: boolean;
  };

export async function chooseHost<T extends { readonly hostId: string }>(candidates: readonly T[], judge: (candidate: T) => Promise<HostVerdict>): Promise<HostChoice<T>> {
  const refusals: HostRefusal[] = [];
  for (const candidate of candidates) {
    const verdict = await judge(candidate);
    if (verdict.kind === "take") return { kind: "chosen", candidate, refusals };
    refusals.push({ hostId: candidate.hostId, reason: verdict.reason, lasting: verdict.lasting, revoked: verdict.revoked === true });
  }
  const revoked = refusals.filter((r) => r.revoked).length;
  const lasting = refusals.filter((r) => r.lasting && !r.revoked).length;
  return {
    kind: "wait",
    refusals,
    reason: refusals.length === 0 ? "no worker host is configured" : refusals.map((r) => r.reason).join("; "),
    blocked: candidates.length === 0 || revoked === candidates.length,
    lastingRefusal: lasting > 0 && lasting + revoked === candidates.length,
  };
}
