// The bench's batch loop (card W01): runs the jobs, at most `concurrency` at once, and stops starting new runs when
// - the server gate refuses (Radiance busy past the wait, unreadable, or not serving the pinned model), or
// - the batch's token budget is spent (input + output tokens of the finished runs; cache reads are not counted, as they
//   cost the server little and dominate the totals).
// A run already started is never cut short by either: it ends at its own wall-clock limit. With a gate the loop runs one
// job at a time, so the bench never has more than one agent (and so one request) on the shared server.

/** What a record keeps of a server reading: when, and the counters (not the model list). */
const kept = (x) => (x ? { at: x.at, stats: x.stats } : null);

/** Input + output tokens of a record (cache reads left out). */
export const spentTokens = (rec) => (Number(rec?.tokens?.input) || 0) + (Number(rec?.tokens?.output) || 0);

/**
 * jobs: [[task, variant, repeat], ...]; runJob(task, variant, repeat) -> record; onRecord(record) is awaited per record.
 * gate: optional { before() -> {ok, why, reading, waitedMs}, after() -> reading|null }.
 * Returns { records, stopped: null | { reason, at, remaining }, spent }.
 */
export async function runBatch({ jobs, runJob, onRecord = async () => {}, gate = null, tokenBudget = Infinity, concurrency = 1, log = () => {} }) {
  if (gate && concurrency !== 1) throw new Error("with the Radiance gate on, runs go one at a time (--concurrency 1)");
  if (!(tokenBudget > 0)) throw new Error("the token budget must be a positive number");
  const records = [];
  let spent = 0;
  let next = 0;
  let stopped = null;
  const stop = (reason) => { if (stopped === null) { stopped = { reason, at: new Date().toISOString(), remaining: jobs.length - next }; log(`batch stopped: ${reason} (${stopped.remaining} run(s) not started)`); } };
  const worker = async () => {
    while (stopped === null && next < jobs.length) {
      if (spent >= tokenBudget) { stop(`token budget spent: ${spent} of ${tokenBudget} input+output tokens`); break; }
      let server;
      if (gate) {
        const g = await gate.before();
        if (!g.ok) { stop(`Radiance gate: ${g.why}`); break; }
        server = { before: kept(g.reading), waitedMs: g.waitedMs };
      }
      if (stopped !== null || next >= jobs.length) break;
      const [t, v, r] = jobs[next++];
      const rec = await runJob(t, v, r);
      if (gate) { server.after = kept(await gate.after()); rec.server = server; }
      spent += spentTokens(rec);
      rec.batchTokensSpent = spent;
      records.push(rec);
      await onRecord(rec);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { records, stopped, spent };
}
