import { join } from "node:path";
import {
  ANSWER, Chaos, Clock, acknowledgedSurvive, adapterProbe, around, cleanRun, describe, openAdapter, openStore, piConversation, runChild, runPath, startProcess, verifyFinished,
  type Clean, type StoreSpec,
} from "./g04-fixture.js";

// Card G04: the controller and the Pi adapter in one process, killed with a real SIGKILL at a numbered boundary, then restarted on the same database
// and the same Pi storage.

export interface Killed { readonly index: number; readonly problems: string[]; readonly resumed: number }

/** Kills a child at boundary `crashAt`, looks at the database without running any command, restarts the whole path and verifies it. */
export async function killAndRestart(spec: StoreSpec, directory: string, clean: Clean, crashAt: number): Promise<Killed> {
  const child = await runChild(spec, directory, crashAt);
  const label = describe(clean, crashAt);
  if (!child.killed || child.out.includes("finished")) return { index: crashAt, problems: [`${label}: the child was not killed (${child.err.slice(0, 300)})`], resumed: 0 };
  const storage = await openStore(spec);
  const { adapter } = await openAdapter(join(directory, "pi"), ANSWER);
  try {
    const problems = (await acknowledgedSurvive(storage, clean, crashAt)).map((p) => `${label}: ${p}`);
    const clock = new Clock();
    clock.advance(10 * 60_000);
    let resumed = 0;
    const world = { storage, directory, chaos: new Chaos(), clock: clock.now, conversation: () => { const c = piConversation(adapter); return { ...c, recover: async (reason: string) => { resumed += 1; await c.recover!(reason); } }; } };
    const slice = await startProcess(world, "restarted");
    await runPath(slice);
    problems.push(...(await verifyFinished(slice, world, adapterProbe(adapter), clean, clean.labels[crashAt])).map((p) => `${label}: ${p}`));
    return { index: crashAt, problems, resumed };
  } finally { await adapter.close(); await storage.close(); }
}

export const ADMISSION = ["task.assign", "inbox.receive", "attempt.admit", "inbox.admit"];
export const RESULT = ["effect.settle", "artifact.publish", "recovery-point.record", "attempt.finish"];

/** Boundaries that matter most: around admission, the model request, the outside effect and the result (the first operation of each kind), and the bridge, target and blob boundaries. */
export function keyPoints(clean: Clean): number[] {
  const named = clean.labels.flatMap((l, i) => (l.startsWith("bridge:") || l.startsWith("outside:") ? [i] : []));
  const firsts = [...ADMISSION, ...RESULT, "effect.intend", "effect.claim"].flatMap((type) => around(clean, [type], 1));
  return [...new Set([...firsts, ...named])].sort((a, b) => a - b);
}

/** The default stride of the spread over the rest of the path (the exhaustive run takes every boundary). */
export const STRIDE = 8;
