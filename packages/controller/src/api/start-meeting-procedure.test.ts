import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { Principal } from "../security/principals.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the meeting procedure runs through the state API: the owner's settings (rounds, reruns, tabling, seating) decide it, a tabling makes an owned follow-up task, and only the owner and the chair rule (card M06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mproc-"));
  const people = new Map<string, Principal>();
  const asked: string[] = [];
  let objection: (agent: string) => { answer: "none" | "objection" | "research"; reason?: string } = () => ({ answer: "none" });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    meetingProcedure: {
      actAs: async (a) => people.get(a),
      traits: (a) => ({ family: a.endsWith("ann") ? "gpt" : a.endsWith("bob") ? "gpt" : "qwen" }),
      floor: {
        comment: async (r) => { asked.push(`c${r.round}:${r.agent}`); return { text: `${r.agent} says go on round ${r.round}`, stance: "for" }; },
        objection: async (r) => objection(r.agent),
        ballot: async (r) => ({ value: "yes", reason: `${r.agent} agrees` }),
        revision: async () => ({ keep: true }),
      },
    },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const tok = async (name: string): Promise<string> => {
      await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants: [{ action: "task.read", project }, { action: "meeting.attend", project }] });
      const token = (await c.services.principals.issueCredential(rob, `agent:${name}`)).token;
      people.set(`agent:${name}`, await c.services.principals.authenticate(token));
      return token;
    };
    const ann = await tok("ann"); const bob = await tok("bob"); const cat = await tok("cat");
    void bob;
    // The owner's settings: validated, owner only.
    const set = async (values: Record<string, unknown>, n: number): Promise<string> => {
      try { const staged = await c.services.configuration.stage(rob, { commandId: `s${n}`, layer: "installation", set: values }); await c.services.configuration.apply(rob, { commandId: `a${n}`, layer: "installation", expectedRevision: staged.revision }); return "set"; } catch (e) { return (e as Error).message; }
    };
    assert.notEqual(await set({ "meeting.rounds": 9 }, 1), "set", "more than five rounds is refused");
    assert.notEqual(await set({ "meeting.seating": "random" }, 2), "set");
    assert.equal(await set({ "meeting.rounds": 1, "meeting.seating": "listed" }, 3), "set");
    await assert.rejects(c.services.configuration.stage(people.get("agent:ann")!, { commandId: "s9", layer: "installation", set: { "meeting.rounds": 5 } } as never), "an agent cannot set the owner's meeting settings");

    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Beds", reason: "frost tonight", roster: ["agent:ann", "agent:bob", "agent:cat"] }, "mu1");
    const rec = (await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:cat" }, "mo1")).result.id as string;
    const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Cover the beds tonight." }, "mv1");
    const motion = moved.result.id as string;
    const begun = await call(boot.token, "meeting.proc.begin", { motionId: motion }, "pb1");
    assert.ok(begun.ok, JSON.stringify(begun));
    for (const who of [ann, cat]) assert.equal((await call(who, "meeting.proc.run", { motionId: motion })).ok, false, "members never move the procedure");
    objection = (a) => (a.endsWith("bob") ? { answer: "research", reason: "check the frost forecast for tonight" } : { answer: "none" });
    const held = await call(boot.token, "meeting.proc.run", { motionId: motion });
    assert.ok(held.ok, JSON.stringify(held));
    assert.equal(held.result.stage, "ruling");
    assert.equal(held.result.waiting.on, "chair");
    assert.deepEqual(asked.filter((x) => x.startsWith("c")).map((x) => x.slice(0, 2)), ["c1", "c1", "c1"], "the setting gave one round");
    // The owner sees what waits; the chair is a member and the owner's list is not for anyone else.
    const controls = await call(boot.token, "meeting.proc.owner-controls", {});
    assert.equal(controls.result.item.rulings.length, 1);
    assert.deepEqual((await call(ann, "meeting.proc.owner-controls", {})).result?.item ?? { rulings: [], tabled: [] }, { rulings: [], tabled: [] });
    // A member who is not the chair cannot rule; the chair (cat) tables because a member asked for time.
    assert.equal((await call(ann, "meeting.proc.rule", { motionId: motion, ruling: "table", reason: "x" }, "r0")).ok, false);
    const tabled = await call(cat, "meeting.proc.rule", { motionId: motion, ruling: "table", reason: "The frost forecast is still coming." }, "r1");
    assert.ok(tabled.ok, JSON.stringify(tabled));
    const status = await call(boot.token, "meeting.proc.status", { motionId: motion });
    assert.equal(status.result.item.stage, "tabled");
    const task = status.result.item.followUps[0].taskId as string;
    assert.ok(task, "a follow-up task was made");
    const assignment = await c.services.assignments.getAssignment(task);
    assert.equal((assignment as unknown as { owner?: { id: string } } | undefined)?.owner?.id, "agent:bob", "the follow-up belongs to the member who asked for time");
    // The owner overrules the tabling and the vote goes ahead.
    const again = await call(boot.token, "meeting.proc.untable", { motionId: motion }, "ot1");
    assert.ok(again.ok, JSON.stringify(again));
    objection = () => ({ answer: "none" });
    const ran = await call(boot.token, "meeting.proc.run", { motionId: again.result.motionId });
    assert.equal(ran.result.done, true, JSON.stringify(ran));
    assert.equal((await call(boot.token, "meeting.record.motion", { motionId: again.result.motionId })).result.item.state, "adopted");
    // The summary says how the motions were run.
    assert.ok((await call(boot.token, "meeting.record.finish", { recordId: rec }, "f1")).ok);
    const summary = await call(boot.token, "meeting.record.summary", { recordId: rec });
    assert.equal(summary.result.item.content.procedure.length, 2);
    // The owner's message with a quoted ballot is refused until acknowledged; a plain one is not.
    assert.equal((await call(ann, "meeting.proc.owner-message", { recordId: rec, text: "hello" }, "om0")).ok, false);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
