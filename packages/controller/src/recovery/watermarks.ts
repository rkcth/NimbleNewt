/**
 * Measuring the loss window of a failover (card K04). A loss window is not a promise, it is a measurement after the fact: the writes the controller was told were committed
 * (it recorded each sequence number and when the answer came) against what the new primary holds.
 */
export interface Acknowledged { readonly seq: number; /** Milliseconds since the epoch at which the commit was acknowledged. */ readonly ackedAtMs: number }

export interface LossMeasurement {
  readonly acknowledged: number;
  readonly surviving: number;
  readonly lost: number;
  readonly lostSeqs: readonly number[];
  /** From the last acknowledged write that survived to the last acknowledged write overall: the stretch of work the failover took back. 0 when nothing was lost. */
  readonly windowMs: number;
}

/** `surviving` is the set of sequence numbers found on the new primary. */
export function measureLoss(acknowledged: readonly Acknowledged[], surviving: ReadonlySet<number>): LossMeasurement {
  const sorted = [...acknowledged].sort((a, b) => a.seq - b.seq);
  const lost = sorted.filter((a) => !surviving.has(a.seq));
  const survivors = sorted.filter((a) => surviving.has(a.seq));
  const lastSurvivor = survivors.length === 0 ? undefined : survivors[survivors.length - 1]!;
  const last = sorted.length === 0 ? undefined : sorted[sorted.length - 1]!;
  const windowMs = lost.length === 0 || last === undefined ? 0 : Math.max(0, last.ackedAtMs - (lastSurvivor?.ackedAtMs ?? sorted[0]!.ackedAtMs));
  return { acknowledged: sorted.length, surviving: survivors.length, lost: lost.length, lostSeqs: lost.map((a) => a.seq), windowMs };
}
