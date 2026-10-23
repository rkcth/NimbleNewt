import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { PostgresStorage } from "@nimblenewt/controller";
import { FaultProxy } from "@nimblenewt/controller/testing";
import { ANSWER, Chaos, Clock, adapterProbe, cleanRun, engines, openAdapter, EXHAUSTIVE, piConversation, runPath, server, startProcess, stopServer, verifyFinished, withEngine, type Clean, type SliceWorld } from "./g04-fixture.js";
import { runWithRecovery, type Outcome } from "./g04-faults-suite.js";

after(stopServer);

// Card G04, real connection loss on the embedded PostgreSQL server. A relay between the controller and the server cuts the connection immediately before or
// immediately after an exact statement of the whole path (with the real Pi adapter). A cut after a COMMIT is the ambiguous commit: the transaction is durable and
// the controller never hears so.

const RUN_LIMIT_MS = 180_000;
async function withWatchdog<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${RUN_LIMIT_MS / 1000} s: a hang`)), RUN_LIMIT_MS); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const engine = engines.find((e) => e.name === "PostgreSQL")!;

interface Cut { readonly ordinal: number; readonly when: "before" | "after"; readonly statement: string }

/** One whole path through a relay that cuts at `cut` (or does not cut), with the final state verified. */
async function run(clean: Clean, proxy: FaultProxy, cut: Cut | undefined, trace = false): Promise<{ problems: string[]; outcome: Outcome; statements: number; fired: number; trace: string[] }> {
  return withEngine(engine, async (spec, dir) => {
    if (spec.kind !== "postgres") throw new Error("not PostgreSQL");
    const relayed = new URL(spec.url);
    relayed.port = String(proxy.port);
    // One connection, so statements are strictly ordered and a cut always kills the connection the next statement would have used.
    const storage = await PostgresStorage.open({ connectionString: relayed.toString(), schema: spec.schema, maxConnections: 1 });
    const { adapter } = await openAdapter(join(dir, "pi"), ANSWER);
    try {
      proxy.trace = trace ? [] : undefined;
      proxy.arm(cut === undefined ? undefined : { when: cut.when, ordinal: cut.ordinal });
      const fired0 = proxy.fired;
      const clock = new Clock();
      const world: SliceWorld = { storage, directory: dir, chaos: new Chaos(), clock: clock.now, conversation: () => piConversation(adapter) };
      const { outcome, slice } = await runWithRecovery(world, clock);
      const statements = proxy.statements;
      const traced = proxy.trace ?? [];
      const problems = (await verifyFinished(slice, world, adapterProbe(adapter), clean, undefined, /^delivery-failures /));
      return { problems, outcome, statements, fired: proxy.fired - fired0, trace: traced };
    } finally { await adapter.close(); await storage.close(); }
  });
}

test("PostgreSQL: the connection cut before and after sampled COMMITs (each of them when exhaustive), and before or after a spread of other statements, of the whole path with the real Pi adapter: nothing acknowledged is lost, nothing is applied twice", async () => {
  const clean = await withEngine(engine, (spec, dir) => cleanRun(spec, dir));
  const s = await server();
  const real = new URL(s.url());
  const proxy = await FaultProxy.start({ host: real.hostname, port: Number(real.port) });
  try {
    const reference = await run(clean, proxy, undefined, true);
    assert.deepEqual(reference.problems, []);
    assert.equal(reference.outcome, "absorbed");
    const statements = reference.statements;
    assert.ok(statements > 400, `${statements} statements`);
    const commits = reference.trace.filter((t) => / COMMIT $/.test(t)).map((t) => Number(t.split(":")[0]));
    assert.ok(commits.length > 50, `${commits.length} commits`);
    const cuts: Cut[] = [];
    // Default: every 4th commit (and the first and last); exhaustive: all of them.
    commits.forEach((ordinal, i) => { if (EXHAUSTIVE || i % 4 === 0 || i === commits.length - 1) for (const when of ["before", "after"] as const) cuts.push({ ordinal, when, statement: "COMMIT" }); });
    for (let ordinal = 1; ordinal <= statements; ordinal += EXHAUSTIVE ? 11 : 55) for (const when of ["before", "after"] as const) if (!commits.includes(ordinal)) cuts.push({ ordinal, when, statement: "other" });
    const failures: string[] = [];
    const tally: Record<string, number> = {};
    for (const cut of cuts) {
      const label = `${cut.when} statement ${cut.ordinal} (${cut.statement})`;
      if (process.env["G04_TRACE"] !== undefined) console.log(`# cut ${label}`);
      // A run that does not finish is a hang, reported as a failure naming the cut.
      const done = await withWatchdog(run(clean, proxy, cut), label).catch((error: unknown) => ({ problems: [String(error)], outcome: "restart" as Outcome, statements: 0, fired: 1, trace: [] }));
      if (done.fired !== 1) failures.push(`${label}: the cut fired ${done.fired} times`);
      for (const p of done.problems) failures.push(`${label}: ${p}`);
      const key = `${cut.statement} ${cut.when}: ${done.outcome}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    assert.deepEqual(failures, []);
    console.log(`# g04 postgres connection loss: ${cuts.length} cuts over ${statements} statements; ${JSON.stringify(tally)}`);
  } finally { await proxy.stop(); }
});
