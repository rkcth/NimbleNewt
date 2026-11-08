import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CUT_MARKER, HANDOFF_LIMITS, HANDOFF_SECTIONS, HandoffService, PauseService, StopService, controllerHandoffSources, type StopPorts } from "./index.js";

/**
 * Card C07h: a task passed A to B to A about 50 times. At every hop the test records what the next agent is given (the package: its size by section, and what survives in it) using the real hand-off
 * service and the real controller package source. The source reads the task's latest continuation, which gains a decision, a diagnosis and a next step at every hop, as a run's would.
 *
 * What holds today is asserted plainly. What does not hold is a finding: its test is marked `todo` with the follow-up card that fixes it, so it is reported on every run without failing the suite, and
 * the day the follow-up lands the test starts passing and the `todo` is removed. A seeded early decision and early failure detail are checked after the last hop.
 *
 * The first-call size sent to a worker, the stored conversation size and the resume note, which belong to the context and dispatch services, are measured over 50 hand-offs in `dispatch/first-call-hops.test.ts` (card C07l).
 */
after(stopServer);

const HOPS = 50;
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

const OWNER_WORDS = "OWNER-WORDS: never delete a customer file; ask first";
const PERMISSIONS = "PERMISSIONS: may edit files under importer/, may not run network tools";
const OPEN_QUESTION = "OPEN-QUESTION: which encoding do the oldest fixtures use";
const PER_HOP = 4;

/** A record ID of the shape the continuation service accepts (`dsk-` and 20 characters of the base32 alphabet a-z, 2-7), made from a number; different numbers give different IDs. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const recordId = (number: number): string => {
  let k = number; let out = "";
  for (let i = 0; i < 20; i++) { out = ALPHABET[k % 32]! + out; k = Math.floor(k / 32); }
  const id = `dsk-${out}`;
  if (!/^[a-z]{2,5}-[a-z2-7]{20}$/.test(id)) throw new Error(`${id} is not a record ID the continuation service would accept`);
  return id;
};
/** The desk: what each decision ID stands for. The package carries the ID, as the real continuation does; the text is read back from the desk by the reference. */
const desk = new Map<string, string>();
const decisionId = (hop: number, i: number): string => {
  const id = recordId(hop * 10 + i);
  const text = (i === PER_HOP - 1 ? `LATEST-DIAGNOSIS-${hop}: the retry at hop ${hop} failed on the lease, the cause is the stale cursor` : hop === 1 && i === 0 ? "SEEDED-EARLY-DECISION: the importer reads UTF-8 only" : hop === 2 && i === 0 ? "SEEDED-EARLY-FAILURE: fixture 7 off by one, header row counted twice" : `Decision ${hop}.${i}: strict column order, rejected rows listed with line numbers`);
  if (desk.has(id) && desk.get(id) !== text) throw new Error(`record ID ${id} is used for two different decisions`);
  desk.set(id, text);
  return id;
};
const EARLY_DECISION = decisionId(1, 0);
const EARLY_FAILURE = decisionId(2, 0);
const latestDiagnosis = (hop: number): string => recordId(hop * 10 + PER_HOP - 1);

/** What the continuation holds after `hop` hops: every earlier decision (four are recorded in each attempt, up to the service's limit of 200), the newest being that attempt's diagnosis, and the next step. */
const continuation = (hop: number) => ({
  seq: hop, capturedAt: "2026-10-28T10:00:00.000Z",
  continuation: {
    artifacts: [recordId(hop * 10 + 9)],
    decisions: Array.from({ length: Math.min(200, hop * PER_HOP) }, (_, k) => { const h = Math.floor(k / PER_HOP) + 1; return decisionId(h, k % PER_HOP); }),
    pendingEffects: [{ effectId: recordId(hop * 10 + 8), state: "unknown" }],
    nextStep: `NEXT-ACTION-${hop}: rerun fixture batch ${hop}`,
  },
  manifest: { routingRevision: 1, environmentRevision: 1 },
  checkpoint: { runtime: { name: "pi", version: "1" } },
  nonCheckpointableTools: [],
});

/** What one hop gave the next agent: the package, and (card C07j) what each cut section's marker leads to when read back, beside what the source said before any cut. */
interface Hop { readonly hop: number; readonly sizes: Record<string, number>; readonly total: number; readonly sections: Record<string, string>; readonly raw: Record<string, string>; readonly archives: Record<string, string> }

for (const backend of backends) {
  const simulate = async (): Promise<Hop[]> => {
    const world = await backend.open();
    try {
      const options = { clock: () => "2026-10-28T10:00:00.000Z", pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
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
      const sources = controllerHandoffSources({ getTask: (id) => projects.getTask(id), contracts: contracts as never, agentState: async () => "active", more: async () => ({ audience: PERMISSIONS, outstandingQuestions: OPEN_QUESTION }) });
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
        const now = await assignments.getAssignment(task);
        assert.equal(now?.owner?.id, to.id, `hop ${hop}: the task is with the one it was handed to`);
        const sections = { ...(done.package?.sections ?? {}) };
        const sizes = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length]));
        // What the source gives for this hop before any cut (the continuation is the same until the next hop), and every archive a marker names, read back part by part as a reader would.
        const raw = { ...(await sources.collect({ taskId: task, from: to === b ? a : b, to })).sections };
        const archives: Record<string, string> = {};
        for (const text of Object.values(sections)) {
          const m = CUT_MARKER.exec(text);
          if (m === null) continue;
          let whole = ""; let parts = 1;
          for (let part = 0; part < parts; part++) { const got = await handoffs.archive(mgr, { archiveId: m[3]!, part }); assert.ok(got !== undefined, `hop ${hop}: the archive ${m[3]} a marker names cannot be read`); whole += got.text; parts = got.parts; }
          archives[m[3]!] = whole;
        }
        hops.push({ hop, sizes, total: Object.values(sizes).reduce((s, x) => s + x, 0), sections, raw, archives });
      }
      return hops;
    } finally { await world.close(); }
  };

  /** One simulation per backend, shared by the checks below. */
  let cached: Promise<Hop[]> | undefined;
  const run = (): Promise<Hop[]> => (cached ??= simulate());
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const everything = (h: Hop): string => Object.values(h.sections).join("\n");
  /** An item is kept if its text is there whole in the package, or in the original of a section a marker says was cut, read back through the archive the marker names (card C07j). */
  const kept = (h: Hop, item: string): boolean => everything(h).includes(item) || Object.values(h.archives).some((x) => x.includes(item));
  /** Strictly in what the next agent is shown, not only in an archive. */
  const shown = (h: Hop, item: string): boolean => everything(h).includes(item);

  test(`${backend.name}: 50 hand-offs: every package has only the fixed sections, each inside the section limit`, async () => {
    const hops = await run();
    assert.equal(hops.length, HOPS);
    for (const h of hops) {
      for (const [name, size] of Object.entries(h.sizes)) {
        assert.ok((HANDOFF_SECTIONS as readonly string[]).includes(name), `hop ${h.hop}: section ${name} is not a fixed section`);
        assert.ok(size <= HANDOFF_LIMITS.section, `hop ${h.hop}: ${name} is ${size} over ${HANDOFF_LIMITS.section}`);
      }
    }
  });

  test(`${backend.name}: 50 hand-offs: the owner's words, goal, permissions, open question, acceptance criteria and next action are in every package`, async () => {
    for (const h of await run()) {
      assert.ok(kept(h, OWNER_WORDS), `hop ${h.hop}: the owner's words are missing`);
      assert.ok(kept(h, "Goal: every fixture imports"), `hop ${h.hop}: the goal is missing`);
      assert.ok(kept(h, "Rejected rows are listed"), `hop ${h.hop}: an acceptance criterion is missing`);
      assert.ok(kept(h, `NEXT-ACTION-${h.hop}`), `hop ${h.hop}: the next action is missing`);
      assert.ok(kept(h, PERMISSIONS), `hop ${h.hop}: the permissions are missing`);
      assert.ok(kept(h, OPEN_QUESTION), `hop ${h.hop}: the open question is missing`);
    }
  });

  test(`${backend.name}: 50 hand-offs: the most recent diagnosis is in every package`, async () => {
    for (const h of await run()) { const id = latestDiagnosis(h.hop); assert.ok(shown(h, id), `hop ${h.hop}: the most recent diagnosis (${id}) was cut`); assert.match(desk.get(id) ?? "", new RegExp(`^LATEST-DIAGNOSIS-${h.hop}:`), "the reference does not lead to this hop's diagnosis"); }
  });

  // Since card C07j a cut keeps the newest entries, so the early ones are found through the marker's archive: the check reads it back, as the next agent would.
  test(`${backend.name}: 50 hand-offs: the seeded early decision and early failure are still found after the last hop`, async () => {
    const last = (await run())[HOPS - 1]!;
    assert.ok(kept(last, EARLY_DECISION) && /SEEDED-EARLY-DECISION/.test(desk.get(EARLY_DECISION) ?? ""), "the seeded early decision cannot be found again by its reference");
    assert.ok(kept(last, EARLY_FAILURE) && /SEEDED-EARLY-FAILURE/.test(desk.get(EARLY_FAILURE) ?? ""), "the seeded early failure detail cannot be found again by its reference");
  });

  test(`${backend.name}: 50 hand-offs: a section that was cut says so and names where the original can be read`, async () => {
    const hops = await run();
    // Whether a section had to be cut is judged from what the source gave, not from the package (a cut section under its marker is shorter than the limit).
    const cutHops = hops.filter((h) => Object.values(h.raw).some((s) => s.length > HANDOFF_LIMITS.section));
    assert.ok(cutHops.length > 0, "the simulation never reached the limit, so it proves nothing about cuts");
    for (const h of hops) {
      for (const [name, text] of Object.entries(h.sections)) {
        const raw = h.raw[name] ?? "";
        if (raw.length <= HANDOFF_LIMITS.section) { assert.equal(text, raw, `hop ${h.hop}: ${name} fits and is given whole`); continue; }
        const m = /^\[cut: (\d+) of (\d+) entries, archive (\S+)\]/.exec(text);
        assert.ok(m !== null, `hop ${h.hop}: ${name} was cut with no marker`);
        const lines = raw.split("\n");
        assert.equal(Number(m[2]), lines.length, `hop ${h.hop}: the marker counts the entries of the original`);
        assert.equal(Number(m[1]), lines.length - (text.split("\n").length - 1), `hop ${h.hop}: the marker counts what was left out`);
        assert.equal(h.archives[m[3]!], raw, `hop ${h.hop}: the archive of ${name} reads back the original whole`);
        // Every line under the marker is an entry of the original, in its order.
        let at = 0;
        for (const line of text.split("\n").slice(1)) { const i = lines.indexOf(line, at); assert.ok(i >= at, `hop ${h.hop}: ${JSON.stringify(line)} is not an entry of the original, in order`); at = i + 1; }
      }
    }
  });

  test(`${backend.name}: 50 hand-offs: the average package size of the last 10 hops is no more than 5 percent above the first 10`, { todo: "C07k: lifecycle/handoff-sources.ts:48-49 lists every decision and nothing summarises the decisions, so the package grows with every hand-off until it reaches the section limit" }, async () => {
    const hops = await run();
    const first = mean(hops.slice(0, 10).map((h) => h.total));
    const lastTen = mean(hops.slice(-10).map((h) => h.total));
    assert.ok(lastTen <= first * 1.05, `first 10 average ${Math.round(first)}, last 10 average ${Math.round(lastTen)}: the package grows with the number of hand-offs`);
  });
}
