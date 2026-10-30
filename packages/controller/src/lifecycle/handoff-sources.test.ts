import assert from "node:assert/strict";
import { test } from "node:test";
import { controllerHandoffSources } from "./handoff-sources.js";

const records = new Map<string, unknown>();
const sources = (extra: Record<string, unknown> = {}) => controllerHandoffSources({
  getTask: async () => ({ id: "task-1", revision: 1, title: "Ship it", description: "The importer.", projectId: "prj-1" } as never),
  contracts: { runner: { get: async (kind: string, id: string) => { const body = records.get(`${kind}:${id}`); return body === undefined ? undefined : { body }; } } } as never,
  agentState: async () => "active",
  ...extra,
});
const from = { kind: "agent", id: "a" }, to = { kind: "agent", id: "b" };

test("the package takes the sections only the run knows from the task's latest complete continuation, and invents nothing without one (card L03g)", async () => {
  records.clear();
  records.set("task-contract:task-1", { version: 4, acceptanceCriteria: ["Fixtures load"], requiredEvidence: ["test log"] });
  const bare = (await sources().collect({ taskId: "task-1", from, to })).sections;
  assert.deepEqual(Object.keys(bare).sort(), ["acceptanceCriteria", "brief", "risks", "versions"]);
  records.set("continuation-head:task-1", { latestCompleteId: "con-2" });
  records.set("continuation:con-2", {
    seq: 2, capturedAt: "2026-10-22T10:00:00.000Z",
    continuation: { artifacts: ["art-1"], decisions: ["use the CSV path"], pendingEffects: [{ effectId: "eff-1", state: "unknown" }], nextStep: "Run the fixtures." },
    manifest: { routingRevision: 3, environmentRevision: 5 }, checkpoint: { runtime: { name: "pi", version: "1.2" } },
    nonCheckpointableTools: [{ name: "browser", reason: "holds a live session" }],
  });
  const s = (await sources().collect({ taskId: "task-1", from, to })).sections;
  assert.match(s["nextAction"]!, /^Run the fixtures\. \(from continuation 2/);
  assert.match(s["unfinishedWork"]!, /eff-1 \(unknown\)/);
  assert.equal(s["backgroundOperations"], "eff-1: unknown");
  assert.equal(s["completedWork"], "Decision: use the CSV path\nArtifact: art-1");
  assert.match(s["risks"]!, /^Evidence still required: test log\nTools whose effects a resume does not reproduce: browser \(holds a live session\)/);
  assert.match(s["versions"]!, /^task contract version 4\nruntime pi 1.2, routing revision 3, environment revision 5/);
  // Nothing pending is said as a fact about the checkpoint, not as "all work is done".
  records.set("continuation:con-2", { ...(records.get("continuation:con-2") as object), continuation: { artifacts: [], decisions: [], pendingEffects: [], nextStep: "  " } });
  const quiet = (await sources().collect({ taskId: "task-1", from, to })).sections;
  assert.equal(quiet["unfinishedWork"], undefined, "nothing pending does not say nothing is unfinished, so the section stays a gap");
  assert.equal(quiet["nextAction"], undefined, "an empty next step is not a next action");
  assert.equal(quiet["backgroundOperations"], undefined);
  // A source given by the caller still has the last word.
  const over = (await sources({ more: async () => ({ nextAction: "Do this instead." }) }).collect({ taskId: "task-1", from, to })).sections;
  assert.equal(over["nextAction"], "Do this instead.");
});

test("locks the sender holds are listed in the package, a failing or empty source leaves the section a gap, and the source is asked for the sender's task and project (card L03h)", async () => {
  records.clear();
  const asked: unknown[] = [];
  const held = (await sources({ locks: async (r: unknown) => { asked.push(r); return ["checkout of task-1: refresh in progress", "resource res-1: claimed by responsibility rsp-1"]; } }).collect({ taskId: "task-1", from, to })).sections;
  assert.equal(held["locks"], "checkout of task-1: refresh in progress\nresource res-1: claimed by responsibility rsp-1");
  assert.deepEqual(asked, [{ taskId: "task-1", projectId: "prj-1", from }]);
  assert.equal((await sources({ locks: async () => [] }).collect({ taskId: "task-1", from, to })).sections["locks"], undefined, "no known hold is not the claim of no locks");
  assert.equal((await sources({ locks: async () => { throw new Error("down"); } }).collect({ taskId: "task-1", from, to })).sections["locks"], undefined);
});
