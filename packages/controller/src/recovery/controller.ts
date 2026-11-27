import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { isStorageError, type Aggregate, type AggregateRef, type ControllerStorage, type JsonObject } from "../storage/index.js";
import { compareToManifest, describeProblem, type BlobCheck, type Problem } from "./assess.js";
import { readRecoveryManifest, RecoveryManifestBad, type ReadManifest } from "./manifest.js";
import { snapshotSource } from "./source.js";
import { RecoveryWriteRefused, writeFencedRecoveryManifest } from "./writer.js";

/**
 * Controller promotion (card K05, first slice): which controller may use a store after the one that held it is given up for lost, with the old one fenced BEFORE the new one is named.
 *
 * Database failover (card K04, `promoteDatabase`) only makes a standby's database writable and leaves the epoch and holder as they were: it authorizes no controller. This step is separate and
 * runs against the store the new controller will use (the same SQLite file or PostgreSQL schema, or a database K04 promoted). Its order:
 *
 * 1. Nothing is changed while it checks: the store must have been used by a controller (epoch 1 or more) and must not be held by a database transfer; the successor's name must differ from the
 *    holder being replaced; the recovery manifest must be whole and written under the epoch of the controller being replaced (an earlier epoch is a stale manifest and is refused, a later one
 *    means this store is an older copy and is refused); the store must hold every record and counter it lists and the successor's artifact store every file.
 * 2. The fence: the epoch is taken by compare-and-set from the one the checks read, with a holder that names this promotion and the replaced epoch. From that commit on every write of the old
 *    controller is refused by the store itself (`stale_epoch`), its dispatcher stops at its next round, and a start of any controller but the successor is refused (`assertStartAllowed`).
 * 3. The record (`controller-authority/primary`) is written as `fenced` at the fence epoch.
 * 4. A fresh manifest is written from the store, which cannot change any more (only the fence holds the epoch), and the successor's artifact store is checked against it: the decision is made on a
 *    manifest written after the fence, never on one the old controller may have left behind.
 * 5. Only then the record says `promoted`, naming the successor.
 *
 * A failure after step 2 leaves the store fenced with no controller allowed to start (the record says why): nothing runs until the promotion is run again and goes through. There is no option that
 * skips the fence or a check, and no owner consent can stand in for one. Nothing here runs by itself: there is no automatic controller failover.
 */
export const CONTROLLER_AUTHORITY: AggregateRef = { kind: "controller-authority", id: "primary" };
export const PROMOTION_FENCE_PREFIX = "promotion-fence:";
const AUTHORITY_FORMAT = 1;
const HOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const RESERVED_PREFIXES = [PROMOTION_FENCE_PREFIX, "transferred-out:", "rolled-back:", "transfer-pending:"] as const;
const REASON_MAX = 300;
const REASONS_KEPT = 5;

export type AuthorityState = "fenced" | "promoted";

/** The durable record of the last controller promotion of this store. */
export interface ControllerAuthority {
  readonly format: 1;
  readonly promotionId: string;
  readonly state: AuthorityState;
  /** The holder name the new controller starts with. While the state is `fenced` it is only the intended successor and may not start either. */
  readonly successor: string;
  /** The epoch of the controller that was replaced, and its holder name when the store still said it (null when a fence of an earlier, unfinished promotion stood in between). */
  readonly fencedEpoch: number;
  readonly fencedHolder: string | null;
  /** The epoch the promotion took to fence it. */
  readonly fenceEpoch: number;
  readonly at: string;
  /** The manifest written after the fence that the decision was made on (absent while it was not written). */
  readonly manifest?: { readonly createdAt: string; readonly epoch: number; readonly auditSeq: number; readonly deliverySeq: number; readonly records: number; readonly blobs: number };
  /** For `fenced`: why the promotion did not go through. Bounded sentences, no paths. */
  readonly reasons?: readonly string[];
}

export interface ControllerPromotionOptions {
  readonly storage: ControllerStorage;
  /** The recovery manifest folder (absolute). The fresh manifest written after the fence replaces the one in it. */
  readonly manifestDirectory: string;
  /** The artifact store the successor will use: every file the manifests list must verify there. */
  readonly blobs: BlobCheck;
  /** The holder name the successor controller will be started with (`StartOptions.holder`). It must differ from the holder being replaced. */
  readonly successor: string;
  readonly promotionId?: string;
  readonly actor?: string;
  readonly now?: () => Date;
}

export interface ControllerPromotionResult {
  readonly controller: "promoted";
  readonly promotionId: string;
  readonly successor: string;
  readonly fencedEpoch: number;
  readonly fencedHolder: string | null;
  readonly fenceEpoch: number;
  readonly manifest: NonNullable<ControllerAuthority["manifest"]>;
  readonly notes: readonly string[];
}

/** A promotion that did not go through. `fenced` says whether the old controller was fenced before it stopped: when true no controller may start on the store until a promotion goes through. */
export class ControllerPromotionRefused extends Error {
  constructor(readonly fenced: boolean, readonly reasons: readonly string[], readonly problems: readonly Problem[] = []) {
    super(`${fenced ? "the old controller was fenced, but no controller was promoted" : "nothing was changed: no controller was fenced or promoted"}: ${reasons.join("; ")}`);
    this.name = "ControllerPromotionRefused";
  }
}

const bound = (text: string): string => text.replace(/\s+/g, " ").slice(0, REASON_MAX);
const said = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return bound(error instanceof Error ? error.message : "unknown");
};
const isReserved = (holder: string): boolean => RESERVED_PREFIXES.some((p) => holder.startsWith(p));

/**
 * `promotion-fence:<promotionId>:<replaced epoch>[:<replaced holder>]`: the replaced epoch, and the replaced holder's name when it is a plain holder name, are in the fence itself, so a promotion that
 * stopped before its record was written can be run again and still refuses a successor with the replaced controller's name (review of K05).
 */
export function fenceHolder(promotionId: string, fencedEpoch: number, fencedHolder?: string | null): string {
  return `${PROMOTION_FENCE_PREFIX}${promotionId}:${fencedEpoch}${typeof fencedHolder === "string" && HOLDER_PATTERN.test(fencedHolder) ? `:${fencedHolder}` : ""}`;
}
export function parseFenceHolder(holder: string | null | undefined): { readonly promotionId: string; readonly fencedEpoch: number; readonly fencedHolder: string | null } | undefined {
  if (typeof holder !== "string" || !holder.startsWith(PROMOTION_FENCE_PREFIX)) return undefined;
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]{0,47}):([1-9][0-9]{0,15})(?::([A-Za-z0-9][A-Za-z0-9._-]{0,79}))?$/.exec(holder.slice(PROMOTION_FENCE_PREFIX.length));
  if (m === null) return undefined;
  const fencedEpoch = Number(m[2]);
  return Number.isSafeInteger(fencedEpoch) ? { promotionId: m[1]!, fencedEpoch, fencedHolder: m[3] ?? null } : undefined;
}

async function readState(storage: ControllerStorage): Promise<{ epoch: number; holder: string | null; auditSeq: number; deliverySeq: number }> {
  const snap = await storage.snapshot();
  try {
    const [row] = await snap.read("state", { limit: 1 });
    if (row === undefined) return { epoch: 0, holder: null, auditSeq: 0, deliverySeq: 0 };
    return { epoch: Number(row["epoch"]), holder: (row["holder"] as string | null) ?? null, auditSeq: Number(row["audit_seq"]), deliverySeq: Number(row["delivery_seq"]) };
  } finally { await snap.close(); }
}

/** The record as stored, checked field by field; a record that does not read is treated as a fence (fail closed). */
export function parseAuthority(aggregate: Aggregate | undefined): ControllerAuthority | "unreadable" | undefined {
  if (aggregate === undefined) return undefined;
  const b = aggregate.body as Record<string, unknown>;
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  if (b["format"] !== AUTHORITY_FORMAT || (b["state"] !== "fenced" && b["state"] !== "promoted") || typeof b["promotionId"] !== "string" || typeof b["successor"] !== "string" || !HOLDER_PATTERN.test(b["successor"])
    || !count(b["fencedEpoch"]) || !count(b["fenceEpoch"]) || (b["fencedHolder"] !== null && typeof b["fencedHolder"] !== "string") || typeof b["at"] !== "string") return "unreadable";
  return b as unknown as ControllerAuthority;
}

/** Reads the record of the last controller promotion, if any (read only; for status and the start check). */
export async function readControllerAuthority(storage: Pick<ControllerStorage, "getAggregate">): Promise<ControllerAuthority | "unreadable" | undefined> {
  return parseAuthority(await storage.getAggregate(CONTROLLER_AUTHORITY));
}

/**
 * Promotes `successor` to the controller of this store, fencing the controller that held it first (see the module comment for the order). Throws `ControllerPromotionRefused` with `fenced`
 * saying whether anything was changed; an error from the store whose outcome cannot be read back is raised as it is (the store then says, by its holder, whether the fence was taken).
 */
export async function promoteController(options: ControllerPromotionOptions): Promise<ControllerPromotionResult> {
  const now = (): string => (options.now?.() ?? new Date()).toISOString();
  // The manifest reader names the folder in some of its reasons; a refusal and the stored record say "its folder" instead (no path, review of K05).
  const folder = typeof options.manifestDirectory === "string" && options.manifestDirectory.length > 1 ? options.manifestDirectory : undefined;
  const plain = (text: string): string => bound(folder === undefined ? text : text.split(folder).join("its folder"));
  const refusal = (reasons: string[], problems: readonly Problem[] = []): ControllerPromotionRefused => new ControllerPromotionRefused(false, reasons.map(plain), problems);
  const { storage } = options;
  if (typeof options.successor !== "string" || !HOLDER_PATTERN.test(options.successor) || isReserved(options.successor)) throw refusal(["successor: the holder name the new controller starts with (letters, digits, dot, dash or underscore, at most 80)"]);
  if (typeof options.manifestDirectory !== "string" || !isAbsolute(options.manifestDirectory)) throw refusal(["manifestDirectory: an absolute path"]);
  if (typeof options.blobs?.verify !== "function") throw refusal(["blobs: the successor's artifact store"]);
  const promotionId = options.promotionId ?? randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
  if (!ID_PATTERN.test(promotionId)) throw refusal(["promotionId: letters, digits, dash or underscore, at most 48"]);
  const actor = options.actor ?? "recovery";

  // 1. checks; nothing is changed
  const state = await readState(storage);
  if (state.epoch < 1) throw refusal(["no controller has ever used this store, so there is nothing to take over: start the controller on it normally"]);
  if (state.holder !== null && isReserved(state.holder) && !state.holder.startsWith(PROMOTION_FENCE_PREFIX)) throw refusal(["a database transfer holds this store: finish or undo the transfer first"]);
  const priorFence = parseFenceHolder(state.holder);
  if (state.holder !== null && state.holder.startsWith(PROMOTION_FENCE_PREFIX) && priorFence === undefined) throw refusal(["the store is held by a promotion fence that cannot be read"]);
  const authority = await readControllerAuthority(storage);
  if (authority === "unreadable") throw refusal(["the record of an earlier controller promotion cannot be read"]);
  // The controller being replaced: the holder of the epoch, or, when an earlier promotion fenced the store and did not finish, the one that fence replaced.
  const fencedEpoch = priorFence?.fencedEpoch ?? state.epoch;
  const fencedHolder = priorFence === undefined ? state.holder : (priorFence.fencedHolder ?? (authority !== undefined && authority.fenceEpoch === state.epoch ? authority.fencedHolder : null));
  if (fencedHolder !== null && fencedHolder === options.successor) throw refusal([`the successor's name is the name of the controller being replaced (${fencedHolder}): give the new controller its own holder name, or a returning old controller could not be told from it`]);
  let manifest: ReadManifest;
  try { manifest = readRecoveryManifest(options.manifestDirectory); } catch (error) {
    if (error instanceof RecoveryManifestBad) throw refusal([error.message]);
    throw refusal([`the recovery manifest folder cannot be read (${said(error)})`]);
  }
  const m = manifest!.manifest.watermark;
  if (m.epoch < fencedEpoch) throw refusal([`the recovery manifest is stale: it was written under epoch ${m.epoch}, and the controller being replaced holds epoch ${fencedEpoch}, so what that controller wrote may not be in it`]);
  if (m.epoch > state.epoch) throw refusal([`the recovery manifest was written under epoch ${m.epoch}, later than this store's epoch ${state.epoch}: this store is an older copy than the one the manifest describes`]);
  // Between the replaced epoch and the store's, every epoch was a promotion's fence (a fence is only carried on from another fence), under which only promotion records and manifests were written:
  // a manifest of any of them was written from the frozen store. Without an earlier fence the two checks above leave only the store's own epoch.
  const first = await compareWith(manifest!, storage, options.blobs);
  if (first.problems.length > 0) throw refusal([`before the fence: ${first.text}`], first.problems);

  // 2. the fence
  const fence = fenceHolder(promotionId, fencedEpoch, fencedHolder);
  let fenceEpoch: number;
  try { fenceEpoch = (await storage.acquireEpoch({ holder: fence, at: now(), expectedEpoch: state.epoch })).epoch; } catch (error) {
    if (isStorageError(error, "stale_epoch")) throw refusal(["the store's epoch moved while it was checked (a controller started or another promotion ran): nothing was fenced; look again and run the promotion again"]);
    // the answer may have been lost after the commit: the store says by its holder
    const after = await readState(storage);
    if (after.holder !== fence) throw refusal([`the fence could not be taken (${said(error)})`]);
    fenceEpoch = after.epoch;
  }
  // From here the old controller is fenced; every failure leaves it so and says so.
  const stopFenced = async (reasons: string[], problems: readonly Problem[] = [], written?: ControllerAuthority["manifest"]): Promise<never> => {
    const kept = reasons.map(plain);
    await writeAuthority(storage, fenceEpoch, actor, now(), { promotionId, state: "fenced", successor: options.successor, fencedEpoch, fencedHolder, fenceEpoch, ...(written === undefined ? {} : { manifest: written }), reasons: kept.slice(0, REASONS_KEPT) }).catch((error: unknown) => kept.push(plain(`the record of the fence could not be updated (${said(error)})`)));
    throw new ControllerPromotionRefused(true, kept, problems);
  };

  // 3. the record says fenced before anything else is tried
  try { await writeAuthority(storage, fenceEpoch, actor, now(), { promotionId, state: "fenced", successor: options.successor, fencedEpoch, fencedHolder, fenceEpoch, reasons: ["the promotion is under way"] }); } catch (error) {
    throw new ControllerPromotionRefused(true, [plain(`the record of the fence could not be written (${said(error)}); the store stays fenced by its holder, run the promotion again`)]);
  }

  // 4. a manifest written now, from the store no one else can change, and the successor's files against it
  let fresh: ReadManifest;
  try {
    await writeFencedRecoveryManifest({ storage, epoch: fenceEpoch, directory: options.manifestDirectory, now: () => options.now?.() ?? new Date() });
    fresh = readRecoveryManifest(options.manifestDirectory);
  } catch (error) {
    return stopFenced([error instanceof RecoveryWriteRefused || error instanceof RecoveryManifestBad ? `the manifest written after the fence: ${error.message}` : `the manifest could not be written after the fence (${said(error)})`]);
  }
  const fw = fresh.manifest.watermark;
  const written = { createdAt: fresh.manifest.createdAt, epoch: fw.epoch, auditSeq: fw.auditSeq, deliverySeq: fw.deliverySeq, records: fresh.manifest.aggregates.rows, blobs: fresh.manifest.blobs.rows };
  if (fw.epoch !== fenceEpoch) return stopFenced([`the manifest in the folder after the fence is of epoch ${fw.epoch}, not the fence's ${fenceEpoch}`], [], written);
  const second = await compareWith(fresh, storage, options.blobs).catch((error: unknown) => ({ problems: [] as Problem[], text: "", failed: said(error) }));
  if ("failed" in second) return stopFenced([`the store could not be compared with the manifest written after the fence (${second.failed})`], [], written);
  if (second.problems.length > 0) return stopFenced([`after the fence: ${second.text}`], second.problems, written);

  // 5. the successor is named
  try { await writeAuthority(storage, fenceEpoch, actor, now(), { promotionId, state: "promoted", successor: options.successor, fencedEpoch, fencedHolder, fenceEpoch, manifest: written }); } catch (error) {
    throw new ControllerPromotionRefused(true, [plain(`the successor could not be recorded (${said(error)}); the store stays fenced, run the promotion again`)]);
  }
  const notes = [
    `the controller of epoch ${fencedEpoch}${fencedHolder === null ? "" : ` (${fencedHolder})`} was fenced at epoch ${fenceEpoch} before ${options.successor} was named; start ${options.successor} with that holder name, no other controller may start on this store`,
    ...(first.checked.blobs < written.blobs ? [`the manifest written after the fence lists ${written.blobs - first.checked.blobs} more artifact file(s) than the one found in the folder, all checked`] : []),
  ];
  return { controller: "promoted", promotionId, successor: options.successor, fencedEpoch, fencedHolder, fenceEpoch, manifest: written, notes };
}

async function compareWith(manifest: ReadManifest, storage: ControllerStorage, blobs: BlobCheck): Promise<{ problems: readonly Problem[]; text: string; checked: { records: number; blobs: number } }> {
  const source = snapshotSource(storage);
  try {
    const c = await compareToManifest(manifest, source, blobs);
    const text = c.problems.length === 0 ? "" : `the store or the successor's artifact store does not hold everything the recovery manifest of ${manifest.manifest.createdAt} lists (${c.problems.length}${c.truncated ? "+" : ""} problem${c.problems.length === 1 ? "" : "s"}): ${c.problems.slice(0, 3).map(describeProblem).join("; ")}`;
    return { problems: c.problems, text, checked: c.checked };
  } finally { await source.close().catch(() => undefined); }
}

async function writeAuthority(storage: ControllerStorage, epoch: number, actor: string, at: string, body: Omit<ControllerAuthority, "format" | "at">): Promise<void> {
  const current = await storage.getAggregate(CONTROLLER_AUTHORITY);
  const full = { format: AUTHORITY_FORMAT, ...body, at } as unknown as JsonObject;
  const change = current === undefined ? { type: "create" as const, ref: CONTROLLER_AUTHORITY, body: full } : { type: "update" as const, ref: CONTROLLER_AUTHORITY, expectedRevision: current.revision, body: full };
  const opId = `controller-promotion:${body.promotionId}:${body.state}:${current?.revision ?? 0}`;
  await storage.applyOperation({
    operationId: opId, epoch, actor, correlationId: `controller-promotion:${body.promotionId}`, at, changes: [change],
    audit: [{ type: body.state === "promoted" ? "controller.promoted" : "controller.fenced", subject: CONTROLLER_AUTHORITY, detail: { promotionId: body.promotionId, successor: body.successor, fencedEpoch: body.fencedEpoch, fenceEpoch: body.fenceEpoch, ...(body.reasons === undefined ? {} : { reasons: [...body.reasons] }) } }],
    outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  });
}

/**
 * The start check (card K05): run before a controller takes the epoch, with the epoch the start's other checks read (`seenEpoch`), so the start's compare-and-set epoch take fails if a promotion
 * fences the store after this check. Refuses, in words, a start of any controller but the promoted successor once a store was promoted, and every start while a promotion's fence stands without a
 * successor (a returning old controller cannot dispatch, and neither can anything else, until a promotion goes through).
 */
export async function assertStartAllowed(storage: ControllerStorage, holder: string, seenEpoch: number | undefined): Promise<void> {
  const state = await readState(storage);
  const no = (why: string): Error => new Error(`NimbleNewt will not start: ${why}`);
  if (seenEpoch !== undefined && state.epoch !== seenEpoch) throw no("the store's epoch moved while the controller was starting (another controller or a promotion took it); start it again");
  const authority = await readControllerAuthority(storage);
  if (authority === "unreadable") throw no("the record of a controller promotion on this store cannot be read, so whether this controller may use it is not known");
  const fence = parseFenceHolder(state.holder);
  if (state.holder !== null && state.holder.startsWith(PROMOTION_FENCE_PREFIX) && fence === undefined) throw no("the store is held by a promotion fence that cannot be read");
  if (fence !== undefined) {
    if (authority === undefined || authority.fenceEpoch !== state.epoch || authority.promotionId !== fence.promotionId || authority.state !== "promoted") {
      throw no(`a controller promotion fenced this store (the controller of epoch ${fence.fencedEpoch}) and has not named a successor${authority !== undefined && authority.fenceEpoch === state.epoch && authority.reasons !== undefined ? ` (${authority.reasons.slice(0, 2).join("; ")})` : ""}: no controller may start until the promotion is run again and goes through`);
    }
  }
  if (authority === undefined) return;
  if (authority.state === "fenced") throw no(`the controller promotion ${authority.promotionId} fenced this store and did not finish: no controller may start until a promotion goes through`);
  if (holder !== authority.successor) throw no(`the controller promotion ${authority.promotionId} named ${authority.successor} as the controller of this store and fenced the controller of epoch ${authority.fencedEpoch}${authority.fencedHolder === null ? "" : ` (${authority.fencedHolder})`}; this controller starts as ${holder}, so it may not use this store`);
}
