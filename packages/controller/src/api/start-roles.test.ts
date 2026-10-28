import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a started controller has the six standard role templates on a new installation, keeps them across restarts, and the owner labels one through the state API (card H11b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-roles-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const first = await open();
    const boot = await first.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await first.services.principals.authenticate(boot.token);
    const names = async (c: typeof first) => (await c.services.agents.listRoles(rob, { limit: 50 })).items.map((r) => r.name).sort();
    assert.deepEqual(await names(first), ["author", "director", "docs", "integrator", "qa", "reviewer"]);
    await first.services.agents.setRoleLabel(rob, { commandId: "lbl-1", name: "director", label: "CTO" });
    await first.close();
    const second = await open();
    assert.deepEqual(await names(second), ["author", "director", "docs", "integrator", "qa", "reviewer"], "a restart adds nothing and removes nothing");
    assert.equal((await second.services.agents.getRole(rob, "director"))!.label, "CTO", "the label survived the restart");
    await second.close();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
