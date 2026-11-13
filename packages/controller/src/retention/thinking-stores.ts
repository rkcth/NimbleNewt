import type { PiStateSource } from "../backup/pi-state.js";

/**
 * Where the model's stored thinking lives besides the controller's own record of it (card K06c): the conversation store each attempt keeps in its home (Pi Durable's JSON-lines folder, one per attempt, named by the attempt ID),
 * on this machine or on a remote host. Pi's own API only appends; the store's folder is rewritten by `removeStoredThinking` of the Pi adapter, which the host composition gives as `purge`. The controller never imports the adapter.
 *
 * `purged`: the thinking is gone from the store. `none`: no store of that attempt was found anywhere that answered (a store that was never made, or already removed with its home). `pending`: it could not be done now (a host did not answer,
 * the attempt is running, the rewrite failed): the retention rule tries again on its next run.
 */
export type ThinkingPurgeStatus = "purged" | "none" | "pending";
export interface ThinkingPurgeAnswer {
  readonly status: Readonly<Record<string, ThinkingPurgeStatus>>;
  /** Thinking blocks removed from the stores. */
  readonly blocks: number;
  /** Why something is pending, in plain words (bounded; no path of this machine). */
  readonly problems: readonly string[];
}
export interface ThinkingStorePort {
  purge(attemptIds: readonly string[]): Promise<ThinkingPurgeAnswer>;
}

const MAX_PROBLEMS = 20;
const say = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/[\\/][^\s"']{3,}/g, "(path)").slice(0, 200);

/** The conversation stores of this machine: found through the same listing a backup uses, so a store a backup would copy is a store this reaches. */
export function localThinkingStores(options: {
  readonly source: PiStateSource;
  /** The rewrite of one store folder (the Pi adapter's `removeStoredThinking`). */
  readonly purge: (dir: string) => Promise<{ readonly blocks: number }>;
  /** The attempts with a call in flight here: their stores are written by a live agent and are left alone. */
  readonly busy?: () => Promise<readonly string[]> | readonly string[];
}): ThinkingStorePort {
  return {
    async purge(attemptIds) {
      const status: Record<string, ThinkingPurgeStatus> = {}; const problems: string[] = []; let blocks = 0;
      const wanted = new Set(attemptIds);
      const busy = new Set(options.busy === undefined ? [] : await options.busy());
      let stores: readonly { readonly id: string; readonly dir: string }[];
      try { stores = await options.source.list(); } catch (error) {
        for (const id of wanted) status[id] = "pending";
        return { status, blocks, problems: [`the conversation stores of this machine could not be listed (${say(error)})`] };
      } finally { await options.source.release?.(); }
      const byId = new Map(stores.map((s) => [s.id, s.dir] as const));
      for (const id of wanted) {
        const dir = byId.get(id);
        if (dir === undefined) { status[id] = "none"; continue; }
        if (busy.has(id)) { status[id] = "pending"; if (problems.length < MAX_PROBLEMS) problems.push(`the attempt ${id} is running, so its conversation was left alone`); continue; }
        try { blocks += (await options.purge(dir)).blocks; status[id] = "purged"; } catch (error) { status[id] = "pending"; if (problems.length < MAX_PROBLEMS) problems.push(`the conversation of attempt ${id} could not be cleaned (${say(error)})`); }
      }
      return { status, blocks, problems };
    },
  };
}

/** Several places, asked in turn (this machine, then the remote hosts): an attempt is `purged` where any of them purged it, `none` only when every one said it keeps none, and `pending` when any could not answer or failed. */
export function combineThinkingStores(...ports: readonly (ThinkingStorePort | undefined)[]): ThinkingStorePort | undefined {
  const real = ports.filter((p): p is ThinkingStorePort => p !== undefined);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0]!;
  return {
    async purge(attemptIds) {
      const status: Record<string, ThinkingPurgeStatus> = {}; const problems: string[] = []; let blocks = 0;
      const answers: ThinkingPurgeAnswer[] = [];
      for (const p of real) {
        let a: ThinkingPurgeAnswer;
        try { a = await p.purge(attemptIds); } catch (error) { a = { status: Object.fromEntries(attemptIds.map((id) => [id, "pending" as const])), blocks: 0, problems: [`a place for conversation stores did not answer (${say(error)})`] }; }
        answers.push(a); blocks += a.blocks; for (const x of a.problems) if (problems.length < MAX_PROBLEMS) problems.push(x);
      }
      for (const id of attemptIds) {
        const each = answers.map((a) => a.status[id] ?? "pending");
        status[id] = each.includes("pending") ? "pending" : each.includes("purged") ? "purged" : "none";
        // One place purged it and another could not answer: the store that was reached is clean, the other may hold a copy, so it is tried again.
      }
      return { status, blocks, problems };
    },
  };
}
