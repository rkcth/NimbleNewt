import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ModelInterpreter, ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { STATUS_KINDS } from "../status/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

/**
 * Card B01, second slice, through the composed controller: the owner lends the improvement reserve to urgent production in free words (an emergency borrow with reason, expiry and review date,
 * shown first and applied on the owner's yes), the dispatcher's admission reads it at its next decision, the capacity view in chat says what it did and when to review it, and the owner ends it in
 * free words. The controller runs on the real clock, so every time here is relative to it.
 */
test("the owner borrows the improvement reserve in chat, admission lends the place, the capacity view shows the borrow and its review date, and the owner ends it in chat (card B01)", async () => {
  // The interpreter is told the control exists, with its arguments, and the capacity view says it shows a borrow.
  let system = "";
  await new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]).interpret({ text: "hello", quoted: [], focus: {}, proposals: [] });
  assert.ok(system.includes("; capacity.borrow(reason, places, projectId, until, reviewBy, end) - Lend improvement places to urgent production, or end it;"), "the operation line is in the prompt");
  assert.match(STATUS_KINDS["capacity"]!.about, /an emergency borrow \(capacity\.borrow\) with its review date/);

  const d = mkdtempSync(join(tmpdir(), "nn-borrow-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-h1", kind: "host", name: "h1", grants: [] });
    let m = 0;
    type Outcome = { status: string; proposalId?: string; message?: string; lines?: readonly { text: string; cites: readonly unknown[] }[] };
    const turn = async (text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as unknown as Outcome[]; };
    const agreed = async (words: string, intents: unknown[]): Promise<Outcome> => {
      const o = (await turn(words, intents))[0]!;
      assert.equal(o.status, "proposed", `a borrow is always shown first: ${JSON.stringify(o)}`);
      const yes = (await turn(`yes, go ahead ${m}`, [{ kind: "apply_proposal", proposalId: o.proposalId, evidence: "go ahead", basis: "owner" }]))[0]!;
      return yes;
    };
    const ask = async (): Promise<string> => {
      const q = "is improvement work getting starved?";
      const o = (await turn(q, [{ kind: "status", request: { kind: "capacity" }, evidence: q, basis: "owner" }]))[0]!;
      assert.equal(o.status, "answered", JSON.stringify(o));
      assert.ok((o.lines ?? []).length <= 30 && (o.lines ?? []).every((l) => l.cites.length > 0));
      return (o.lines ?? []).map((l) => l.text).join("\n");
    };
    const policy = async (key: string, value: number) => {
      const words = `set ${key} to ${value}`;
      const o = (await turn(words, [{ kind: "policy_edit", change: { type: "setting", layer: "installation", key, value }, evidence: words, basis: "owner" }]))[0]!;
      if (o.status === "proposed") { const y = (await turn(`yes, apply change ${m}`, [{ kind: "apply_proposal", proposalId: o.proposalId, evidence: "yes, apply", basis: "owner" }]))[0]!; assert.equal(y.status, "applied", JSON.stringify(y)); }
      else assert.equal(o.status, "applied", JSON.stringify(o));
    };
    await policy("workClass.pcFloor", 25);
    await policy("workClass.pcCeiling", 50);
    const admission = AdmissionService.withEpoch(c.storage, c.epoch);
    await admission.setCapacity({ commandId: "cap", actor: rob.id, host: "host:h1", capacity: { cpus: 16, memoryMb: 65_536 } });
    await admission.setLimits({ commandId: "lim", actor: rob.id, limits: { productive: 4, perHost: 4, control: 2, queue: 100, depth: 3, children: 4, patience: 5 } });
    const request = (commandId: string, workClass: "P" | "PC", priority = 5) => admission.request({ commandId, actor: "dispatcher", class: "productive", workClass, priority, host: "host:h1", cpus: 1, memoryMb: 512 });
    const p = [await request("p0", "P"), await request("p1", "P"), await request("p2", "P"), await request("p3", "P")];
    const pc = await request("pc0", "PC");
    const urgent = await request("urgent", "P", 9);

    // A borrow whose reason the owner did not say is refused before anything is shown.
    const now = Date.now();
    const until = new Date(now + 3 * 3_600_000).toISOString(), reviewBy = new Date(now + 27 * 3_600_000).toISOString();
    const invented = await turn("let urgent work use the improvement place for three hours, review it tomorrow", [{ kind: "command", op: "capacity.borrow", args: { reason: "the customer demo is at five", places: 1, until, reviewBy }, evidence: "let urgent work use the improvement place", basis: "owner" }]);
    assert.notEqual(invented[0]!.status, "proposed", JSON.stringify(invented));
    assert.equal((await admission.balance(rob)).borrow, undefined);

    const words = "the customer demo is at five, let urgent work use the improvement place for three hours and I will review it tomorrow";
    const yes = await agreed(words, [{ kind: "command", op: "capacity.borrow", args: { reason: "the customer demo is at five", places: 1, until, reviewBy }, evidence: words, basis: "owner" }]);
    assert.equal(yes.status, "applied", JSON.stringify(yes));
    await admission.release({ commandId: "rel0", actor: "dispatcher", requestId: p[0]!.id, reason: "done" });
    const w = await admission.where(urgent.id);
    assert.ok(w.state === "running" && w.entry.borrowed !== undefined, `the urgent production work took the place the borrow lends: ${JSON.stringify(w)}`);
    assert.equal((await admission.where(pc.id)).state, "waiting");
    const answer = await ask();
    assert.match(answer, /^Emergency borrow brw-[a-z2-7]{20} in force \(your reason: "the customer demo is at five"\): production work may take 1 of the reserved place\(s\) until \S+; it let in 1 attempt\(s\), 1 still running; review it by \S+\. You can end it now \(capacity\.borrow with end\)\.$/m);
    // The fourth place was lent before the borrow (no improvement work waited then); the urgent work came in under the borrow.
    assert.match(answer, /^2 production attempt\(s\) run in places lent from the improvement reserve \(1 under your emergency borrow, the rest because no improvement work could use them\)/m);
    assert.match(answer, /^Improvement work is short of 1 reserved place\(s\): .*2 production attempts were lent a reserved place \(1 under your emergency borrow, the rest while no improvement work could use it\)/m);

    // Asking again for the same thing is refused while it is in force, with the way out named.
    const again = await turn("lend it again for a day", [{ kind: "command", op: "capacity.borrow", args: { reason: "lend it again", places: 1, until, reviewBy }, evidence: "lend it again for a day", basis: "owner" }]);
    if (again[0]!.status === "proposed") {
      const no = (await turn("yes, lend it", [{ kind: "apply_proposal", proposalId: again[0]!.proposalId, evidence: "lend it", basis: "owner" }]))[0]!;
      assert.notEqual(no.status, "applied", JSON.stringify(no));
      assert.match(no.message ?? "", /never extended or stacked.*lower workClass\.pcFloor itself/);
      const dropped = (await turn("drop that lending proposal", [{ kind: "discard_proposal", proposalId: again[0]!.proposalId, evidence: "drop that lending proposal", basis: "owner" }]))[0]!;
      assert.ok(["discarded", "applied"].includes(dropped.status), JSON.stringify(dropped));
    } else assert.match(again[0]!.message ?? "", /never extended or stacked/);

    // The owner ends it in free words: the place comes back when the borrowed attempt ends.
    const ended = await agreed("stop lending the improvement place", [{ kind: "command", op: "capacity.borrow", args: { end: true }, evidence: "stop lending the improvement place", basis: "owner" }]);
    assert.equal(ended.status, "applied", JSON.stringify(ended));
    const after = await ask();
    assert.match(after, /^Last emergency borrow brw-[a-z2-7]{20} \(your reason: "the customer demo is at five"\) lent 1 place\(s\) from \S+ to \S+ \(you ended it early\) and let in 1 attempt\(s\), 1 still running; review it by \S+\. The floor may be lent again from \S+\.$/m);
    assert.ok(!/^Emergency borrow brw-/m.test(after), "no borrow is in force now");
    await admission.release({ commandId: "rel-urgent", actor: "dispatcher", requestId: urgent.id, reason: "done" });
    assert.equal((await admission.where(pc.id)).state, "running", "the borrowed place went back to improvement work when its attempt ended");
    void p;
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
