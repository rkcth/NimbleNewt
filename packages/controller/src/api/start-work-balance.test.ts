import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { STATUS_KINDS } from "../status/index.js";
import { OPERATIONS, startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

/**
 * Card B01 through the composed controller: the owner changes the P/PC allocation in free words in chat (a setting change, proposed and applied on the owner's yes), the admission that the
 * dispatcher uses reads it at its next decision, and the owner asks in free words whether improvement work is being starved and is answered from the admission record.
 */
test("the owner sets the P/PC allocation in chat, admission keeps the reserved place for improvement work, and the capacity view in chat says whether improvement work is short and why (card B01)", async () => {
  assert.match(STATUS_KINDS["capacity"]!.about, /P\/PC work balance/, "the interpreter is told the capacity view answers this");
  assert.match(OPERATIONS.find((o) => o.name === "status.ask")!.summary, /P\/PC work balance/);
  const d = mkdtempSync(join(tmpdir(), "nn-balance-"));
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
    const turn = async (text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as unknown as { status: string; proposalId?: string; lines?: readonly { text: string; cites: readonly unknown[] }[] }[]; };
    const QUESTION = "is improvement work getting starved?";
    const ask = async (): Promise<string> => {
      const o = (await turn(QUESTION, [{ kind: "status", request: { kind: "capacity" }, evidence: QUESTION, basis: "owner" }]))[0]!;
      assert.equal(o.status, "answered", JSON.stringify(o));
      assert.ok((o.lines ?? []).length <= 30 && (o.lines ?? []).every((l) => l.cites.length > 0));
      return (o.lines ?? []).map((l) => l.text).join("\n");
    };
    assert.match(await ask(), /^P\/PC work balance: no allocation is set \(workClass.pcFloor and workClass.pcCeiling\), so no place is kept for improvement \(PC\) work and none is capped by kind; 0 production and 0 improvement attempt\(s\) running, 0 and 0 waiting\.$/m);

    // The allocation is changed in the owner's own words: a setting, shown first and applied on the owner's yes.
    const words = "keep a quarter of the places for improvement work";
    const proposed = await turn(words, [
      { kind: "policy_edit", change: { type: "setting", layer: "installation", key: "workClass.pcFloor", value: 25 }, evidence: words, basis: "owner" },
    ]);
    assert.ok(["proposed", "applied"].includes(proposed[0]!.status), JSON.stringify(proposed));
    if (proposed[0]!.status === "proposed") {
      const yes = await turn("yes, do that", [{ kind: "apply_proposal", proposalId: proposed[0]!.proposalId, evidence: "do that", basis: "owner" }]);
      assert.equal(yes[0]!.status, "applied", JSON.stringify(yes));
    }
    const words2 = "let improvement work use at most half the places";
    const ceiling = await turn(words2, [{ kind: "policy_edit", change: { type: "setting", layer: "installation", key: "workClass.pcCeiling", value: 50 }, evidence: words2, basis: "owner" }]);
    if (ceiling[0]!.status === "proposed") {
      const yes = await turn("yes, apply it", [{ kind: "apply_proposal", proposalId: ceiling[0]!.proposalId, evidence: "apply it", basis: "owner" }]);
      assert.equal(yes[0]!.status, "applied", JSON.stringify(yes));
    } else assert.equal(ceiling[0]!.status, "applied", JSON.stringify(ceiling));

    // Admission on the controller's own storage (the dispatcher's admission reads the same settings) now keeps one of the four places for improvement work.
    const admission = AdmissionService.withEpoch(c.storage, c.epoch);
    await admission.setCapacity({ commandId: "cap", actor: rob.id, host: "host:h1", capacity: { cpus: 16, memoryMb: 65_536 } });
    await admission.setLimits({ commandId: "lim", actor: rob.id, limits: { productive: 4, perHost: 4, control: 2, queue: 100, depth: 3, children: 4, patience: 5 } });
    const request = (commandId: string, workClass: "P" | "PC") => admission.request({ commandId, actor: "dispatcher", class: "productive", workClass, host: "host:h1", cpus: 1, memoryMb: 512 });
    for (let i = 0; i < 4; i++) assert.equal((await request(`p${i}`, "P")).state, "running", "no improvement work waits, so the fourth place is lent");
    const pc = await request("pc0", "PC");
    assert.equal(pc.state, "waiting");
    const answer = await ask();
    assert.match(answer, /^P\/PC work balance \(your allocation: improvement floor 25%, ceiling 50% of 4 productive places\): 1 place\(s\) kept for improvement work, at most 2 improvement attempt\(s\) at once, 2 place\(s\) production always keeps; 4 production and 0 improvement attempt\(s\) running, 0 and 1 waiting\.$/m);
    assert.match(answer, /^1 production attempt\(s\) run in places lent from the improvement reserve/m);
    assert.match(answer, /^Improvement work is short of 1 reserved place\(s\): .*every productive place is taken.*nothing running is stopped to make room.*$/m);
    // The lent attempt ends: its place goes back to improvement work, and the answer says the reserve is met.
    const lent = (await admission.snapshot()).running.find((e) => e.lent !== undefined)!;
    await admission.release({ commandId: "rel", actor: "dispatcher", requestId: lent.id, reason: "done" });
    assert.equal((await admission.where(pc.id)).state, "running");
    assert.match(await ask(), /^Improvement work is not short of its reserved places now\.$/m);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
