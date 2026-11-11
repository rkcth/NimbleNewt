import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { landingPolicyFrom } from "./landing-policy.js";
import { OPERATION_BY_NAME } from "./operations.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CALL = { taskId: "task-abcdefghijklmnopqrst", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" };

test("landingPolicyFrom: task value over installation, permit required unless explicitly false, nothing guessed (card H12s)", async () => {
  const values: Record<string, unknown> = {};
  const task: Record<string, unknown> = {};
  const pick = (src: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, src[k]]));
  const p = landingPolicyFrom({ installationValues: async (ks) => pick(values, ks), taskValues: async (ks) => pick({ ...values, ...task }, ks) });
  assert.deepEqual(await p(CALL), { requirePermit: true, protectDefaults: true }, "no branch is set: none is invented");
  values["workspace.landing.branch"] = "main"; values["workspace.landing.requirePermit"] = false; values["workspace.landing.protectedPaths"] = []; values["workspace.landing.protectDefaults"] = false;
  assert.deepEqual(await p(CALL), { branch: "main", requirePermit: false, protectDefaults: false, protectedPaths: [] }, "the owner switched the built-in list off");
  task["workspace.landing.branch"] = "integration";
  assert.equal((await p(CALL)).branch, "integration");
  const failing = landingPolicyFrom({ installationValues: async () => { throw new Error("unreadable"); }, taskValues: async () => undefined });
  await assert.rejects(() => failing(CALL), /unreadable/);
});

test("the local host builder gets the landing policy from the owner's settings, read fresh at each call (card H12s)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-h12s-"));
  let policy: ((call: typeof CALL) => Promise<unknown>) | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, build: (s: { landingPolicy: typeof policy }) => { policy = s.landingPolicy; return { name: "fake", capabilities: () => ({}), run: async () => undefined } as never; } } },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    assert.deepEqual(await policy!(CALL), { requirePermit: true, protectDefaults: true, protectedPaths: [] }, "nothing set: no branch, permit required");
    let rev: number | undefined;
    const put = async (id: string, set: Record<string, unknown>) => {
      const staged = await c.services.configuration.stage(owner, { commandId: `st-${id}`, layer: "installation", ...(rev === undefined ? {} : { expectedRevision: rev }), set } as never);
      const applied = await c.services.configuration.apply(owner, { commandId: `ap-${id}`, layer: "installation", expectedRevision: staged.revision } as never);
      assert.equal(applied.applied, true);
      rev = applied.revision;
    };
    await put("1", { "workspace.landing.branch": "main", "workspace.landing.protectedPaths": ["docs/"] });
    assert.deepEqual(await policy!(CALL), { branch: "main", requirePermit: true, protectDefaults: true, protectedPaths: ["docs/"] });
    await put("2", { "workspace.landing.branch": "integration", "workspace.landing.protectedPaths": ["x/"] });
    assert.deepEqual(await policy!(CALL), { branch: "integration", requirePermit: true, protectDefaults: true, protectedPaths: ["x/"] }, "the owner's change counts from the next call");
    // The owner's status view of the landing policy (chat's status kind landing): the values in force, each marked as the owner's or the default; nobody else is shown it.
    const ask = async (token: string) => (await c.api.handle(token, { v: 1, op: "status.ask", args: { request: { kind: "landing" } } } as never)) as { ok: boolean; result?: { item: { lines: { text: string; cites: unknown[] }[] } }; error?: { code: string } };
    const seen = await ask(boot.token);
    assert.equal(seen.ok, true, JSON.stringify(seen));
    const text = seen.result!.item.lines.map((l) => l.text).join("\n");
    assert.match(text, /Landing branch: "?integration"? \(you set it\)/);
    assert.match(text, /Review permit: required \(the default\)/);
    assert.match(text, /kept for your review \(the default\)/);
    assert.match(text, /Your extra protected paths, kept for your review: "?x\/"?\./);
    assert.ok(seen.result!.item.lines.every((l) => l.cites.length > 0), "every line cites the installation layer");
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "agt-aaaaaaaaaaaaaaaaaaaa", grants: [{ action: "config.read", project: "*" }] } as never);
    const agentToken = (await c.services.principals.issueCredential(owner, "agent:agt-aaaaaaaaaaaaaaaaaaaa")).token;
    const other = await ask(agentToken);
    assert.match(OPERATION_BY_NAME.get("status.ask")!.summary, /`landing` \(owner only/, "status.ask describes the same kind");
    assert.equal(other.error?.code, "not_found", `an agent, even one that may read configuration, is not shown the landing view: ${JSON.stringify(other)}`);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
