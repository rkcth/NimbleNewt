import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { HANDOFF_LIMITS, HANDOFF_SECTIONS, HandoffService, PauseService, StopService, controllerHandoffSources, type StopPorts } from "./index.js";

/**
 * Card C07h: a task passed A to B to A about 50 times. At every hop the test records what the next agent is given (the package: its size by section, and what survives in it) using the real hand-off
 * service and the real controller package source. The source reads the task's latest continuation, which gains a decision, a diagnosis and a next step at every hop, as a run's would.
 *
 * What holds today is asserted plainly. What does not hold is a finding: its test is marked `todo` with the follow-up card that fixes it, so it is reported on every run without failing the suite, and
 * the day the follow-up lands the test starts passing and the `todo` is removed. A seeded early decision and early failure detail are checked after the last hop.
 *
 * Not in this slice (recorded on the card): the first-call size sent to a worker, the stored conversation size and the resume note, which belong to the context and dispatch services.
 */
after(stopServer);

const HOPS = 50;
const CEILING = HANDOFF_SECTIONS.length * HANDOFF_LIMITS.section;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const stub: StopPorts = {
  unsupported: () => undefined,
  release: async () => undefined,
  inventory: async () => [],
  cleanup: async () => ({ remaining: [] }),
  checkpoint: async () => ({ checkpointId: "cp", durable: true, artifactsDurable: true }),
  terminate: async () => ({ ended: true, unresolved: [] }),
} as unknown as StopPorts;

const EARLY_DECISION = "SEEDED-EARLY-DECISION: the importer reads UTF-8 only, never guess the encoding";
const EARLY_FAILURE = "SEEDED-EARLY-FAILURE: fixture 7 failed with an off-by-one in the row counter (diagnosis: header row counted twice)";
const OWNER_WORDS = "OWNER-WORDS: never delete a customer file; ask first";

/** What the continuation holds after `hop` hops: every earlier decision, and the newest diagnosis and next step, as a run that records as it goes would leave it. */
const continuation = (hop: number) => ({
  seq: hop, capturedAt: "2026-10-28T10:00:00.000Z",
  continuation: {
    artifacts: [`artifact-${hop}.csv`],
    decisions: [
      ...(hop >= 1 ? [EARLY_DECISION] : []),
      ...(hop >= 2 ? [EARLY_FAILURE] : []),
      ...Array.from({ length: Math.max(0, hop - 2) }, (_, i) => `Decision ${i + 3}: after reviewing fixture batch ${i + 3} the importer keeps the strict column order and records the rejected rows with their line numbers`),
      `LATEST-DIAGNOSIS-${hop}: the retry at hop ${hop} failed on the lease and the cause is the stale cursor`,
    ],
    pendingEffects: [{ effectId: `eff-${hop}`, state: "unknown" }],
    nextStep: `NEXT-ACTION-${hop}: rerun fixture batch ${hop}`,
  },
  manifest: { routingRevision: 1, environmentRevision: 1 },
  checkpoint: { runtime: { name: "pi", version: "1" } },
  nonCheckpointableTools: [],
});

interface Hop { readonly hop: number; readonly sizes: Record<string, number>; readonly total: number; readonly sections: Record<string, string> }

for (const backend of backends) {
  const simulate = async (): Promise<Hop[]> => {
    const world = await backend.open();
    try {
      const options = { clock: () => "2026-10-28T10:00:00.000Z", pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      GrantService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "mgr", grants: [] });
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "mgr2", grants: [{ action: "assignment.manage", project }, { action: "assignment.read", project }] });
      const mgr: Principal = await principals.authenticate((await principals.issueCredential(owner, "agent:mgr2")).token);
      const a = { kind: "agent", id: (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id };
      const b = { kind: "agent", id: (await agents.create(owner, { commandId: cid("ag"), friendlyName: "B" })).id };
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Ship the importer", description: `${OWNER_WORDS}. Goal: every fixture imports.` })).id;
      await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
      await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: a });

      let hop = 0;
      const contracts = {
        runner: {
          get: async (kind: string) => {
            if (kind === "continuation-head") return { body: { latestCompleteId: "c" } };
            if (kind === "continuation") return { body: continuation(hop) };
            if (kind === "task-contract") return { body: { version: 1, acceptanceCriteria: ["Every fixture imports", "Rejected rows are listed"], requiredEvidence: ["fixture report"] } };
            return undefined;
          },
        },
      };
      const sources = controllerHandoffSources({ getTask: (id) => projects.getTask(id), contracts: contracts as never, agentState: async () => "active" });
      const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
      const stops = StopService.withEpoch(world.storage, epoch, pauses, stub, options);
      const handoffs = HandoffService.withEpoch(world.storage, epoch, { pauses, stops, assignments, sources, responsibilities: { check: async () => undefined, apply: async () => ({ moved: [], failed: [] }) }, onTransferred: async () => undefined }, options);

      const hops: Hop[] = [];
      for (hop = 1; hop <= HOPS; hop++) {
        const to = hop % 2 === 1 ? b : a;
        const prepared = await handoffs.prepare(mgr, { commandId: cid("h"), taskId: task, to, reason: `hop ${hop}` });
        assert.equal(prepared.phase, "ready", `hop ${hop}`);
        const done = await handoffs.complete(mgr, { commandId: cid("c"), handoffId: prepared.id });
        assert.equal(done.phase, "transferred", `hop ${hop}`);
        const sections = { ...(done.package?.sections ?? {}) };
        const sizes = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length]));
        hops.push({ hop, sizes, total: Object.values(sizes).reduce((s, x) => s + x, 0), sections });
      }
      return hops;
    } finally { await world.close(); }
  };

  /** One simulation per backend, shared by the checks below. */
  let cached: Promise<Hop[]> | undefined;
  const run = (): Promise<Hop[]> => (cached ??= simulate());
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const everything = (h: Hop): string => Object.values(h.sections).join("\n");
  /** An item is kept if it is there whole, or the section carries a cut marker that names an archived original that can be read back. */
  const kept = (h: Hop, item: string): boolean => everything(h).includes(item);

  test(`${backend.name}: 50 hand-offs: every package stays inside the fixed sections and the section limit`, async () => {
    const hops = await run();
    assert.equal(hops.length, HOPS);
    for (const h of hops) {
      assert.ok(h.total <= CEILING, `hop ${h.hop}: package of ${h.total} is over ${CEILING}`);
      for (const [name, size] of Object.entries(h.sizes)) {
        assert.ok((HANDOFF_SECTIONS as readonly string[]).includes(name), `hop ${h.hop}: section ${name} is not a fixed section`);
        assert.ok(size <= HANDOFF_LIMITS.section, `hop ${h.hop}: ${name} is ${size} over ${HANDOFF_LIMITS.section}`);
      }
    }
  });

  test(`${backend.name}: 50 hand-offs: the owner's words, the goal, the acceptance criteria and the next action are in every package`, async () => {
    for (const h of await run()) {
      assert.ok(kept(h, OWNER_WORDS), `hop ${h.hop}: the owner's words are missing`);
      assert.ok(kept(h, "Goal: every fixture imports"), `hop ${h.hop}: the goal is missing`);
      assert.ok(kept(h, "Rejected rows are listed"), `hop ${h.hop}: an acceptance criterion is missing`);
      assert.ok(kept(h, `NEXT-ACTION-${h.hop}`), `hop ${h.hop}: the next action is missing`);
    }
  });

  test(`${backend.name}: 50 hand-offs: the most recent diagnosis is in every package`, { todo: "C07j: a hand-off section is cut at its tail with a plain slice, so once decisions pile up the newest ones are the ones lost" }, async () => {
    for (const h of await run()) assert.ok(kept(h, `LATEST-DIAGNOSIS-${h.hop}`), `hop ${h.hop}: the most recent diagnosis was cut`);
  });

  // Holds today only because the cut keeps the head of a section; the day a section is summarised or cut from the front, this is the check that must still pass.
  test(`${backend.name}: 50 hand-offs: the seeded early decision and early failure are still found after the last hop`, async () => {
    const last = (await run())[HOPS - 1]!;
    assert.ok(kept(last, EARLY_DECISION), "the seeded early decision is gone");
    assert.ok(kept(last, EARLY_FAILURE), "the seeded early failure detail is gone");
  });

  test(`${backend.name}: 50 hand-offs: a section that was cut says so and names where the original can be read`, { todo: "C07j: the cut at lifecycle/handoff.ts #collect is a plain slice with no marker and no archive" }, async () => {
    const cutHops = (await run()).filter((h) => Object.values(h.sizes).some((s) => s >= HANDOFF_LIMITS.section));
    assert.ok(cutHops.length > 0, "the simulation never reached the limit, so it proves nothing about cuts");
    for (const h of cutHops) for (const [name, text] of Object.entries(h.sections)) if (text.length >= HANDOFF_LIMITS.section) assert.match(text, /\[cut: .*archive/i, `hop ${h.hop}: ${name} was cut with no marker`);
  });

  test(`${backend.name}: 50 hand-offs: the average package size of the last 10 hops is no more than 5 percent above the first 10`, { todo: "C07k: nothing summarises the decisions, so the package grows with every hand-off until it reaches the section limit" }, async () => {
    const hops = await run();
    const first = mean(hops.slice(0, 10).map((h) => h.total));
    const lastTen = mean(hops.slice(-10).map((h) => h.total));
    assert.ok(lastTen <= first * 1.05, `first 10 average ${Math.round(first)}, last 10 average ${Math.round(lastTen)}: the package grows with the number of hand-offs`);
  });
}
