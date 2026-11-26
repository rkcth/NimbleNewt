import { lsnToBigInt, probeNode, promoteStandby, readControllerState, type ControllerStateReader, type DatabasePromotion, type NodeFacts } from "../storage/postgres/index.js";
import { describeProblem, compareToManifest, type BlobCheck, type Comparison, type Problem } from "./assess.js";
import { readRecoveryManifest, RecoveryManifestBad } from "./manifest.js";
import type { RecoverySource } from "./source.js";

/** A promotion that was refused. Nothing was changed: the standby is as it was. */
export class PromotionRefused extends Error {
  readonly changed = false;
  constructor(readonly reasons: readonly string[], readonly problems: readonly Problem[] = []) {
    super(`the standby was not promoted: ${reasons.join("; ")}`);
    this.name = "PromotionRefused";
  }
}

export interface PromotionOptions {
  /** The folder the recovery manifest was written into (see `writeRecoveryManifest`); it must be readable and whole. */
  readonly manifestDirectory: string;
  readonly standby: { readonly url: string; readonly schema: string };
  /** The artifact store on the standby's own host. Every blob the manifest lists must verify there. */
  readonly blobs: BlobCheck;
  /**
   * The old primary's address, when known. If it still answers and is not itself in recovery, promoting would make two primaries, and is refused (also when it is only read-only by
   * default: a session there can still write). Not given, or not answering, is recorded in the result's notes: a node that does not answer may still be running (a partition).
   */
  readonly oldPrimaryUrl?: string;
  /** How long the standby may take to replay WAL it has already received before the check reads it (a standby that has not caught up is not judged). Default 30 s, at most 10 minutes. */
  readonly replayWaitMs?: number;
}

/** The steps a promotion takes, replaceable only by this card's own tests (not exported from the recovery index: no caller can swap a check out). */
export interface PromotionSteps {
  probe(url: string): Promise<NodeFacts>;
  state(url: string, schema: string): RecoverySource & ControllerStateReader;
  promote(url: string): Promise<DatabasePromotion>;
}

export interface PromotionResult {
  /** The database is now writable. */
  readonly database: "promoted";
  /** The controller is not promoted: which controller may use this database, and fencing the old one, are card K05's (the epoch and holder are untouched). */
  readonly controller: "not_promoted";
  readonly positionLsn: string;
  readonly comparison: Comparison;
  /** What was not checked, in words (for example the old primary's address was not given). */
  readonly notes: readonly string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const reached = (facts: NodeFacts): boolean => facts.receivedLsn === undefined || lsnToBigInt(facts.positionLsn) >= lsnToBigInt(facts.receivedLsn);

/**
 * Promotes a PostgreSQL standby to the writable database, only when that is safe by what the recovery manifest says (card K04). The order is: the manifest must be whole; the node must be
 * a standby; the old primary, if its address is given, must not still answer as a primary (anything not in recovery, read-only by default included); the standby must have replayed what it received; every artifact file and workflow
 * record the manifest lists must be on this node. Any failure refuses with the reasons and changes nothing. There is no override: a missing artifact file or workflow record is not
 * something the owner's say-so can make safe (the owner restores the file, or writes a newer manifest after deciding what to give up).
 *
 * This is database failover only. The result says `controller: "not_promoted"`: no epoch is taken and no holder recorded here.
 */
export async function promoteDatabase(options: PromotionOptions): Promise<PromotionResult> {
  return promoteDatabaseWith(options, REAL_STEPS);
}

const REAL_STEPS: PromotionSteps = { probe: probeNode, state: (url, schema) => readControllerState(url, schema), promote: (url) => promoteStandby(url) };

/** `promoteDatabase` with its steps given: for the tests of the refusal order only. */
export async function promoteDatabaseWith(options: PromotionOptions, steps: PromotionSteps): Promise<PromotionResult> {
  const { probe, state, promote } = steps;
  const waitMs = options.replayWaitMs ?? 30_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 600_000) throw new PromotionRefused(["replayWaitMs: whole milliseconds, 0 to 600000"]);
  let manifest;
  try { manifest = readRecoveryManifest(options.manifestDirectory); } catch (error) {
    if (error instanceof RecoveryManifestBad) throw new PromotionRefused([error.message]);
    throw error;
  }
  const notes: string[] = [];
  let facts: NodeFacts;
  try { facts = await probe(options.standby.url); } catch (error) { throw new PromotionRefused([`the standby does not answer (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`]); }
  if (!facts.inRecovery) throw new PromotionRefused([facts.writable ? "this node is already a writable database, not a standby" : "this node is not a standby"]);
  if (options.oldPrimaryUrl === undefined) notes.push("the old primary's address was not given, so whether it still accepts writes was not checked");
  else {
    let old: NodeFacts | undefined;
    try { old = await probe(options.oldPrimaryUrl); } catch {
      notes.push("the old primary did not answer: if it is still running where this check cannot reach it (a network partition), it was not stopped by this promotion (fencing is card K05's)");
    }
    if (old !== undefined && !old.inRecovery) {
      throw new PromotionRefused([old.writable
        ? "the old primary still answers as a writable database: promoting would leave two writable databases (stop or fence it first)"
        : "the old primary still answers and is not in recovery (it is read-only only by default, which a session can change): promoting would leave two primaries (stop or fence it first)"]);
    }
    if (old !== undefined && old.systemIdentifier !== facts.systemIdentifier) throw new PromotionRefused(["the address given for the old primary is not the primary this standby copies"]);
  }
  // a standby that has received more WAL than it has replayed is not judged yet
  const deadline = Date.now() + waitMs;
  while (!reached(facts)) {
    if (Date.now() >= deadline) throw new PromotionRefused([`the standby has received WAL it has not replayed (replayed to ${facts.positionLsn}, received ${facts.receivedLsn ?? "?"}) and did not finish within ${Math.round(waitMs / 1000)} s (is replay paused?)`]);
    await sleep(25);
    try { facts = await probe(options.standby.url); } catch (error) { throw new PromotionRefused([`the standby stopped answering while it replayed (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`]); }
    if (!facts.inRecovery) throw new PromotionRefused(["the node stopped being a standby while it was checked (something else promoted it)"]);
  }
  const comparison = await compareToManifest(manifest, state(options.standby.url, options.standby.schema), options.blobs);
  if (comparison.problems.length > 0) {
    throw new PromotionRefused([
      `the standby does not hold everything the recovery manifest of ${manifest.manifest.createdAt} lists (${comparison.problems.length}${comparison.truncated ? "+" : ""} problem${comparison.problems.length === 1 ? "" : "s"}): ${comparison.problems.slice(0, 3).map(describeProblem).join("; ")}`,
    ], comparison.problems);
  }
  const done = await promote(options.standby.url);
  return { database: "promoted", controller: "not_promoted", positionLsn: done.positionLsn, comparison, notes };
}
