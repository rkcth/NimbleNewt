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

test("an agent can pass on an owner's message through the state API when chat is set up; the owner cannot, and without chat it is unavailable (card U04c)", async () => {
  for (const withChat of [false, true]) {
    const d = mkdtempSync(join(tmpdir(), "nn-fwd-"));
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], ...(withChat ? { chat: { interpreter: new ScriptedInterpreter(() => []) } } : {}) });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
      const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
      const call = async (token: string, args: Record<string, unknown>, commandId: string) => (await c.api.handle(token, { v: 1, op: "policy.forward", commandId, args } as never)) as any;
      const args = { threadId: "thr-aaaaaaaaaaaaaaaaaaaa", seq: 1 };
      const byAgent = await call(ann, args, "f1");
      assert.equal(byAgent.error.code, withChat ? "not_found" : "unavailable", JSON.stringify(byAgent));
      if (withChat) assert.equal((await call(boot.token, args, "f2")).error.code, "forbidden", "only an agent passes a message on");
    } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
});
