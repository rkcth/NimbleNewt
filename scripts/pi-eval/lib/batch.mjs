// The bench's batch loop (card W01): runs the jobs, at most `concurrency` at once, and stops starting new runs when
// - the server gate refuses (Radiance busy past the wait, unreadable, or not serving the pinned model), or
// - the batch's token budget is spent (input + output tokens of the finished runs; cache reads are not counted, as they
//   cost the server little and dominate the totals).
// A run already started is never cut short by either: it ends at its own wall-clock limit. With a gate the loop runs one
// job at a time, so the bench never has more than one agent (and so one request) on the shared server. The gate is asked
// twice per run: before the checkout is prepared (so a busy server costs no build), and again by the run itself right
// before its agent starts (runJob's beforeAgent), since preparing, the setup build and a test-slot wait can take minutes.
// A run the second check refuses never started its agent: it is not recorded (it is no result) and the batch stops.
// With a budget, a run whose agent started but whose token use is unknown also stops the batch (the budget fails closed).

/** What a record keeps of a server reading: when, and the counters (not the model list). */
const kept = (x) => (x ? { at: x.at, stats: x.stats } : null);

/** Input + output tokens of a record (cache reads left out). */
export const spentTokens = (rec) => (Number(rec?.tokens?.input) || 0) + (Number(rec?.tokens?.output) || 0);

/** A run whose agent started (startedAt set) without finite input and output token counts: its use is unknown. */
const tokensUnknown = (rec) => rec?.startedAt != null && !(Number.isFinite(rec?.tokens?.input) && Number.isFinite(rec?.tokens?.output));

/**
 * jobs: [[task, variant, repeat], ...]; runJob(task, variant, repeat, { beforeAgent }) -> record; onRecord(record) is
 * awaited per record. With a gate, beforeAgent() -> {ok, why, ...} must be called right before the agent starts, and a
 * refusal must leave the record's gateRefused set (the why) without starting the agent.
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
  const stop = (reason, notStarted = 0) => { if (stopped === null) { stopped = { reason, at: new Date().toISOString(), remaining: jobs.length - next + notStarted }; log(`batch stopped: ${reason} (${stopped.remaining} run(s) not started)`); } };
  const worker = async () => {
    while (stopped === null && next < jobs.length) {
      if (spent >= tokenBudget) { stop(`token budget spent: ${spent} of ${tokenBudget} input+output tokens`); break; }
      let server;
      if (gate) {
        const g = await gate.before();
        if (!g.ok) { stop(`Radiance gate: ${g.why}`); break; }
        server = { before: kept(g.reading), waitedMs: g.waitedMs ?? 0 };
      }
      if (stopped !== null || next >= jobs.length) break;
      const [t, v, r] = jobs[next++];
      // The second check, right before the agent starts: the reading kept is the one the agent started on.
      let cleared = false;
      const beforeAgent = gate ? async () => { const g = await gate.before(); server.waitedMs += g.waitedMs ?? 0; if (g.ok) { cleared = true; server.before = kept(g.reading); } return g; } : undefined;
      const rec = await runJob(t, v, r, { beforeAgent });
      if (gate && rec?.gateRefused !== undefined) { stop(`Radiance gate: ${rec.gateRefused}`, 1); break; }
      // A run that started its agent without the second check cleared it is a bench fault, not a result: stop loudly.
      if (gate && rec?.startedAt != null && !cleared) throw new Error(`run ${rec.runId ?? next} started its agent without the Radiance gate's check before the agent`);
      if (gate) { server.after = kept(await gate.after()); rec.server = server; }
      if (Number.isFinite(tokenBudget) && tokensUnknown(rec)) { records.push(rec); await onRecord(rec); stop(`token use of run ${rec.runId ?? next} is unknown, so the budget cannot be kept`); break; }
      spent += spentTokens(rec);
      rec.batchTokensSpent = spent;
      records.push(rec);
      await onRecord(rec);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { records, stopped, spent };
}
