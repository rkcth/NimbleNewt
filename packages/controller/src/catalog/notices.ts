import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import type { CommandRunner } from "../domain/runner.js";
import type { Principal } from "../security/principals.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";

/**
 * An agent's toolbox inbox (card T08): what the controller has told it about the shared toolbox without being asked, newest last. A maintainer's decision on its proposal, and the revocation of a shared version it keeps a
 * personal copy of, are written here when they happen (in the decision's own write; for a revocation, right after it). The agent reads it with `toolbox.notices`. At most `kept` notices stay; older ones fall off.
 */
export const NOTICE_LIMITS = { kept: 100, text: 600, page: 100 } as const;
/** `release`: a newer version of a shared tool the agent is pinned to; `pin`: its pinned version was set aside, or the owner moved its pin (card T08). */
export type NoticeKind = "proposal" | "revocation" | "release" | "pin";
export interface ToolboxNotice {
  /** Increases by one per notice in this inbox; pass the last one seen as `after` to read only newer ones. */
  readonly seq: number;
  readonly at: string;
  readonly kind: NoticeKind;
  /** The shared tool the notice is about. */
  readonly name: string;
  readonly version?: string;
  readonly proposalId?: string;
  readonly text: string;
  /** What makes two notices the same (a repeat of the same event adds nothing). */
  readonly key: string;
}
export interface ToolboxInboxBody { readonly owner: string; readonly next: number; readonly items: readonly ToolboxNotice[] }
export const inboxRef = (principalId: string): AggregateRef => ({ kind: "toolbox-inbox", id: derivedId("tbi", principalId) });

/**
 * The change that adds a notice to `to`'s inbox, for a command that writes it together with its own changes; `undefined` when a notice with the same key is already there (nothing to add). The write is guarded by the inbox's
 * revision, so two notices at the same moment make one command retry.
 */
export async function noticeChange(runner: CommandRunner, to: string, notice: Omit<ToolboxNotice, "seq" | "at">): Promise<Change | undefined> {
  const ref = inboxRef(to);
  const found = await runner.get(ref.kind, ref.id);
  const inbox = found?.body as unknown as ToolboxInboxBody | undefined;
  if (inbox !== undefined && inbox.items.some((i) => i.key === notice.key)) return undefined;
  const next = inbox?.next ?? 1;
  const item: ToolboxNotice = { ...notice, text: notice.text.slice(0, NOTICE_LIMITS.text), seq: next, at: runner.now() };
  const body: ToolboxInboxBody = { owner: to, next: next + 1, items: [...(inbox?.items ?? []), item].slice(-NOTICE_LIMITS.kept) };
  return found === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject };
}

/** Writes one notice on its own (used after a revocation). The command ID is derived from the recipient and the key, so sending it again changes nothing. */
export async function pushNotice(runner: CommandRunner, to: string, notice: Omit<ToolboxNotice, "seq" | "at">): Promise<void> {
  const commandId = `tbn-${createHash("sha256").update(`${to}\0${notice.key}`).digest("hex").slice(0, 40)}`;
  await runner.command("toolbox.notice", { commandId, actor: "controller" }, async () => ({
    payload: { to, key: notice.key },
    build: async () => {
      const change = await noticeChange(runner, to, notice);
      const ref = inboxRef(to);
      if (change === undefined) {
        const found = await runner.get(ref.kind, ref.id);
        return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found!.revision }], detail: { to, key: notice.key, already: true } };
      }
      return { ref, creates: change.type === "create", changes: [change], detail: { to, key: notice.key, kind: notice.kind } };
    },
  }));
}

/** The caller's own notices (an agent), oldest first, after `after` when given. */
export async function readNotices(runner: CommandRunner, by: Principal, query: { after?: number; limit?: number } = {}): Promise<{ items: ToolboxNotice[]; last: number }> {
  if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} has no toolbox inbox; it belongs to agents`);
  const after = query.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new DomainError("invalid_command", "after: must be a whole number from 0", { field: "after" });
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTICE_LIMITS.page) throw new DomainError("invalid_command", `limit: must be 1 to ${NOTICE_LIMITS.page}`, { field: "limit" });
  const ref = inboxRef(by.id);
  const inbox = (await runner.get(ref.kind, ref.id))?.body as unknown as ToolboxInboxBody | undefined;
  const items = (inbox?.items ?? []).filter((i) => i.seq > after).slice(0, limit);
  return { items: items.map(({ key: _key, ...rest }) => { void _key; return rest as ToolboxNotice; }), last: (inbox?.next ?? 1) - 1 };
}
