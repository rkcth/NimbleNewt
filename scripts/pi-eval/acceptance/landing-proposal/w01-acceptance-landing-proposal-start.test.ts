import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { LANDING_MEANS } from "../chat/commands.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("through startController: main-automatic in any wording is a proposal that says what it does, applied only on confirmation; the project question offers the same sentences", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-w01-landing-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes as any[]; };
    const project = (await call("project.create", { name: "Garden" }, "c1")).result.id as string;
    const landing = async () => (await call("integration.get", { project })).result.item.landing as string;
    const before = await landing();
    assert.notEqual(before, "main-automatic");

    for (const [i, text] of ["make Garden's landing as fast as it can be", "from now on Garden's finished work should just get itself onto main once the checks pass", "do not make it main-automatic", "the domain automatically renews"].entries()) {
      const out = await turn(`m${i}`, text, [{ kind: "command", op: "integration.set", args: { project, landing: "main-automatic" }, evidence: text, basis: "owner" }]);
      assert.equal(out[0].status, "proposed", `${text}: ${JSON.stringify(out)}`);
      assert.match((out[0].preview ?? []).join(" "), /no human step/i);
      assert.equal(await landing(), before, `${text} changes nothing until confirmed`);
      await turn(`x${i}`, `no, drop that ${i}`, [{ kind: "discard_proposal", proposalId: out[0].proposalId, evidence: `drop that ${i}`, basis: "owner" }]);
    }
    const plain = "Garden's work can go onto main by itself after its checks";
    const shown = await turn("p1", plain, [{ kind: "command", op: "integration.set", args: { project, landing: "main-automatic" }, evidence: plain, basis: "owner" }]);
    assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
    const applied = await turn("p2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    assert.equal(await landing(), "main-automatic");

    // A project made in chat asks how its work lands; each offered landing is described with the LANDING_MEANS sentence.
    const guided = "create a project Grove";
    say[guided] = [{ kind: "command", op: "project.create", args: { name: "Grove" }, evidence: guided, basis: "owner" }];
    const r = await c.chat!.submit(boot.token, { messageId: "g1", text: guided });
    const o = r.outcomes[0] as any;
    assert.equal(o.status, "asked", JSON.stringify(r.outcomes));
    for (const l of ["integration-branch", "human-promotes", "main-automatic"]) {
      assert.ok((o.options as string[]).some((x) => x.startsWith(l) && x.includes(LANDING_MEANS[l]!)), `${l} is offered with its sentence: ${JSON.stringify(o.options)}`);
    }
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
