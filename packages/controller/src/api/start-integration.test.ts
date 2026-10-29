import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("integration policy: a project gets the installation default or the profile's setting when created and keeps it; only the owner changes it; the lock holds main-automatic back (card P08)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-integration-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "project.read", project: "*" }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const make = async (name: string, id: string) => (await call(boot.token, "project.create", { name }, id)).result.id as string;

    // No default, strict profile: a human promotes.
    const a = await make("A", "c1");
    const first = (await call(boot.token, "integration.get", { project: a })).result.item;
    assert.deepEqual([first.landing, first.integrator, first.source, first.requiredChecks], ["human-promotes", "agent", "profile", ["tests", "review"]]);
    // An installation default applies to new projects only.
    assert.ok((await call(boot.token, "integration.default.set", { landing: "main-automatic", refreshRounds: 2 }, "d1")).ok);
    const b = await make("B", "c2");
    const second = (await call(boot.token, "integration.get", { project: b })).result.item;
    assert.deepEqual([second.landing, second.source, second.refreshRounds], ["main-automatic", "installation-default", 2]);
    assert.equal((await call(boot.token, "integration.get", { project: a })).result.item.landing, "human-promotes", "the earlier project is untouched");
    // The owner changes a project, with a revision check; other fields stay.
    const set = await call(boot.token, "integration.set", { project: a, landing: "integration-branch", requiredChecks: ["review", "tests", "tests"], expectedRevision: first.revision }, "s1");
    assert.ok(set.ok, JSON.stringify(set));
    const third = (await call(boot.token, "integration.get", { project: a })).result.item;
    assert.deepEqual([third.landing, third.source, third.requiredChecks, third.integrator], ["integration-branch", "owner", ["tests", "review"], "agent"]);
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "human-promotes", expectedRevision: first.revision }, "s2")).error.code, "stale_revision");
    // Promotion to main with no check at all is refused.
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "main-automatic", requiredChecks: [] }, "nochk")).error.code, "invalid_command");
    // Bad values are refused.
    for (const args of [{ landing: "yolo" }, { refreshRounds: 11 }, { requiredChecks: ["magic"] }, { integrator: "bot" }, { surprise: 1 }, {}])
      assert.equal((await call(boot.token, "integration.set", { project: a, ...args }, `bad-${JSON.stringify(args)}`)).error.code, "invalid_command", JSON.stringify(args));
    // Only the owner reads or changes it.
    for (const [op, args] of [["integration.get", { project: a }], ["integration.set", { project: a, landing: "main-automatic" }], ["integration.default.get", {}], ["integration.default.set", { landing: "human-promotes" }]] as const)
      assert.equal((await call(ann, op, args as never, op.endsWith("set") ? "ann-1" : undefined)).error.code, "forbidden", op);
    // The lock: no project may be set to main-automatic, one already so is held back, and the default cannot be main-automatic under it.
    assert.ok((await call(boot.token, "integration.default.set", { forbidMainAutomatic: true }, "d2")).ok, "the lock always applies, even over a default of main-automatic");
    const heldDefault = (await call(boot.token, "integration.default.get", {})).result.item;
    assert.deepEqual([heldDefault.landing, heldDefault.heldFrom, heldDefault.forbidMainAutomatic], ["integration-branch", "main-automatic", true], "held back where it is read, the owner's choice kept");
    assert.equal((await call(boot.token, "integration.default.set", { landing: "main-automatic" }, "d2b")).error.code, "invalid_command", "no default of main-automatic under the lock");
    assert.ok((await call(boot.token, "integration.default.set", { landing: "human-promotes" }, "d3")).ok);
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "main-automatic" }, "s3")).error.code, "forbidden");
    const held = (await call(boot.token, "integration.get", { project: b })).result.item;
    assert.deepEqual([held.landing, held.lockedMainAutomatic, held.heldFrom], ["integration-branch", true, "main-automatic"], "the owner can see what is held back");
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "integration-branch", requiredChecks: [] }, "s4")).ok, true, "no checks are fine short of main");
    assert.ok((await call(boot.token, "integration.default.set", { forbidMainAutomatic: false }, "d4")).ok);
    assert.equal((await call(boot.token, "integration.get", { project: b })).result.item.landing, "main-automatic", "lifting the lock restores what the owner chose");
    // Replay: the same command ID is the same answer.
    const beforeReplay = (await call(boot.token, "integration.get", { project: a })).result.item.revision;
    const again = await call(boot.token, "integration.set", { project: a, landing: "integration-branch", requiredChecks: ["review", "tests", "tests"], expectedRevision: first.revision }, "s1");
    assert.ok(again.ok);
    assert.equal((await call(boot.token, "integration.get", { project: a })).result.item.revision, beforeReplay, "a replay changes nothing");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("in chat, how finished work lands is shown first and applies on the owner's word; main-automatic only on the owner's own words; project.create carries the section (card P08b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-integration-chat-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes as any[]; };
    const project = (await call("project.create", { name: "Garden" }, "c1")).result.id as string;
    const landing = async () => (await call("integration.get", { project })).result.item.landing as string;
    assert.equal(await landing(), "human-promotes");
    // Shown first, even in the autonomous sense of an explicit order; nothing changes until accepted.
    const text = "let finished work in Garden land on the integration branch";
    const shown = await turn("m1", text, [{ kind: "command", op: "integration.set", args: { project, landing: "integration-branch" }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
    assert.equal(await landing(), "human-promotes");
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    assert.equal(await landing(), "integration-branch");
    // main-automatic is only set when the owner's own words say it.
    const vague = "make Garden's landing as fast as it can be";
    const refused = await turn("m3", vague, [{ kind: "command", op: "integration.set", args: { project, landing: "main-automatic" }, evidence: vague, basis: "owner" }]);
    assert.notEqual(refused[0].status, "proposed", JSON.stringify(refused));
    assert.equal(await landing(), "integration-branch");
    const plain = "land Garden's finished work on main-automatic from now on";
    const ok = await turn("m4", plain, [{ kind: "command", op: "integration.set", args: { project, landing: "main-automatic" }, evidence: plain, basis: "owner" }]);
    assert.equal(ok[0].status, "proposed", JSON.stringify(ok));
    // A new project can be drafted with the section; an agent cannot send it.
    // The words check: negations and look-alikes do not count; the clause must be affirmative.
    for (const [i, no] of ["never land Garden's work on main automatically", "do not make it main-automatic", "Garden's landing should remain automatic", "the domain automatically renews"].entries()) {
      const out = await turn(`neg${i}`, no, [{ kind: "command", op: "integration.set", args: { project, landing: "main-automatic" }, evidence: no, basis: "owner" }]);
      assert.notEqual(out[0].status, "proposed", no);
    }
    // A project is not made when its integration section cannot be set; and the section takes only its own four fields.
    const before = (await call("project.list", {})).result.items.length;
    assert.equal((await call("project.create", { name: "Bad", integration: { landing: "yolo" } }, "bad1")).error.code, "invalid_command");
    assert.equal((await call("project.create", { name: "Bad", integration: null }, "bad2")).error.code, "invalid_command");
    assert.equal((await call("project.create", { name: "Bad", integration: { projectId: project, landing: "human-promotes" } }, "bad3")).error.code, "invalid_command");
    // The rule that main-automatic needs a check is judged on the merged settings, before anything is created.
    assert.ok((await call("integration.default.set", { landing: "main-automatic", requiredChecks: ["tests"] }, "mdef")).ok);
    assert.equal((await call("project.create", { name: "Bad", integration: { requiredChecks: [] } }, "bad4")).error.code, "invalid_command");
    assert.equal((await call("project.list", {})).result.items.length, before, "nothing was created");
    assert.ok((await call("integration.default.set", { landing: "integration-branch" }, "mdef2")).ok);
    const make = "create a project Orchard where a human promotes finished work";
    const draft = await turn("m5", make, [{ kind: "command", op: "project.create", args: { name: "Orchard", integration: { landing: "human-promotes", integrator: "human", requiredChecks: ["tests"], refreshRounds: "default" } }, evidence: make, basis: "owner" }]);
    assert.equal(draft[0].status, "proposed", JSON.stringify(draft));
    const made = await turn("m6", "yes, go ahead with that", [{ kind: "apply_proposal", proposalId: draft[0].proposalId, evidence: "go ahead with that", basis: "owner" }]);
    assert.equal(made[0].status, "applied", JSON.stringify(made));
    const orchard = (await call("project.list", {})).result.items.find((p: { name: string }) => p.name === "Orchard").id as string;
    const section = (await call("integration.get", { project: orchard })).result.item;
    assert.deepEqual([section.landing, section.integrator, section.source], ["human-promotes", "human", "owner"]);
    // A project made in chat walks through its questions one at a time; an answer fills one field; "default" is not sent.
    const guided = "create a project Grove";
    say[guided] = [{ kind: "command", op: "project.create", args: { name: "Grove" }, evidence: guided, basis: "owner" }];
    let r = await c.chat!.submit(boot.token, { messageId: "g1", text: guided });
    const asked: string[] = [];
    const answers: [string, string][] = [["integration-branch", "landing"], ["agent", "integrator"], ["tests+review", "requiredChecks"], ["default", "refreshRounds"]];
    for (const [i, [choice, field]] of answers.entries()) {
      const o = r.outcomes[0] as any;
      assert.equal(o.status, "asked", JSON.stringify(r.outcomes));
      asked.push(`${o.question.slice(0, 20)}|${o.options.some((x: string) => x.startsWith("main-automatic"))}`);
      assert.ok(o.options.some((x: string) => x.startsWith(`${choice}:`)), `${field} offers ${choice}`);
      assert.match(o.question, /I suggest/);
      const reply = `${choice} is what I want`;
      say[reply] = [{ kind: "answer", turnId: r.turnId, choice, evidence: reply, basis: "owner" }];
      r = await c.chat!.submit(boot.token, { messageId: `g${i + 2}`, text: reply });
    }
    assert.equal(asked[0]!.endsWith("|true"), true, "main-automatic is offered while the lock is off");
    assert.equal((r.outcomes[0] as any).status, "proposed", JSON.stringify(r.outcomes));
    const grove = "yes, go ahead with that";
    say[grove] = [{ kind: "apply_proposal", proposalId: (r.outcomes[0] as any).proposalId, evidence: "go ahead with that", basis: "owner" }];
    assert.equal(((await c.chat!.submit(boot.token, { messageId: "g9", text: grove })).outcomes[0] as any).status, "applied");
    const groveId = (await call("project.list", {})).result.items.find((p: { name: string }) => p.name === "Grove").id as string;
    const g = (await call("integration.get", { project: groveId })).result.item;
    assert.deepEqual([g.landing, g.requiredChecks, g.refreshRounds, g.source], ["integration-branch", ["tests", "review"], 3, "owner"]);
    // With the lock on, main-automatic is not offered.
    assert.ok((await call("integration.default.set", { forbidMainAutomatic: true }, "lock1")).ok);
    const guided2 = "create a project Hedge";
    say[guided2] = [{ kind: "command", op: "project.create", args: { name: "Hedge" }, evidence: guided2, basis: "owner" }];
    const q = (await c.chat!.submit(boot.token, { messageId: "h1", text: guided2 })).outcomes[0] as any;
    assert.equal(q.options.some((x: string) => x.startsWith("main-automatic")), false);
    assert.ok((await call("integration.default.set", { forbidMainAutomatic: false }, "lock2")).ok);
    await c.services.principals.enroll(await c.services.principals.authenticate(boot.token), { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "project.create", project: "*" }] });
    const ann = (await c.services.principals.issueCredential(await c.services.principals.authenticate(boot.token), "agent:ann")).token;
    const sent = (await c.api.handle(ann, { v: 1, op: "project.create", commandId: "a1", args: { name: "Sneaky", integration: { landing: "main-automatic" } } } as never)) as any;
    assert.equal(sent.ok, false);
    assert.equal(sent.error.code, "forbidden");
    assert.equal((await call("project.list", {})).result.items.some((p: { name: string }) => p.name === "Sneaky"), false, "nothing was created");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
