import { findWritablePrimary, lsnToBigInt, probeNode, promoteStandby, readControllerState, type ControllerStateReader, type DatabasePromotion, type NodeFacts } from "../storage/postgres/index.js";
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
  /** The old primary's address, when known. If it still answers as a writable database, promoting would make two writable databases, and is refused. Unknown (not given) is recorded in the result. */
  readonly oldPrimaryUrl?: string;
  /** How long the standby may take to replay WAL it has already received before the check reads it (a standby that has not caught up is not judged). Default 30 s. */
  readonly replayWaitMs?: number;
  /** For tests: the steps, replaceable. Production code leaves them. */
  readonly steps?: {
    probe?(url: string): Promise<NodeFacts>;
    state?(url: string, schema: string): RecoverySource & ControllerStateReader;
    promote?(url: string): Promise<DatabasePromotion>;
    writablePrimary?(urls: readonly string[]): ReturnType<typeof findWritablePrimary>;
  };
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
 * a standby; the old primary, if its address is given, must not still answer as a writable database; the standby must have replayed what it received; every artifact file and workflow
 * record the manifest lists must be on this node. Any failure refuses with the reasons and changes nothing. There is no override: a missing artifact file or workflow record is not
 * something the owner's say-so can make safe (the owner restores the file, or writes a newer manifest after deciding what to give up).
 *
 * This is database failover only. The result says `controller: "not_promoted"`: no epoch is taken and no holder recorded here.
 */
export async function promoteDatabase(options: PromotionOptions): Promise<PromotionResult> {
  const steps = options.steps ?? {};
  const probe = steps.probe ?? probeNode;
  const state = steps.state ?? ((url: string, schema: string) => readControllerState(url, schema));
  const promote = steps.promote ?? ((url: string) => promoteStandby(url));
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
    const found = await (steps.writablePrimary ?? findWritablePrimary)([options.oldPrimaryUrl]);
    if (found.url !== undefined) throw new PromotionRefused(["the old primary still answers as a writable database: promoting would leave two writable databases (stop or fence it first)"]);
    try {
      const old = await probe(options.oldPrimaryUrl);
      if (old.systemIdentifier !== facts.systemIdentifier) throw new PromotionRefused(["the address given for the old primary is not the primary this standby copies"]);
    } catch (error) { if (error instanceof PromotionRefused) throw error; /* unreachable: nothing to compare */ }
  }
  // a standby that has received more WAL than it has replayed is not judged yet
  const deadline = Date.now() + (options.replayWaitMs ?? 30_000);
  while (!reached(facts)) {
    if (Date.now() > deadline) throw new PromotionRefused([`the standby has received WAL it has not replayed (replayed to ${facts.positionLsn}, received ${facts.receivedLsn ?? "?"}) and did not finish within ${Math.round((options.replayWaitMs ?? 30_000) / 1000)} s (is replay paused?)`]);
    await sleep(25);
    facts = await probe(options.standby.url);
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
