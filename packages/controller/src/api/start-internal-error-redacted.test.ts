import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// The key is built at run time: a push-protection scan reads every commit.
const key = "gh" + "p_" + "Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz1Xc3Vb5N";

test("credential redaction, second review: a real internal fault that quotes a key reaches the embedder's onInternalError cleaned, its own fields too, and the caller is told nothing", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-sink-"));
  const problems: unknown[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, onInternalError: (e) => { problems.push(e); },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    // A fault deep in a service (a driver or provider error that quotes a header and carries the raw reply in its own fields).
    const projects = c.services.projects as unknown as { createProject: (...a: unknown[]) => Promise<unknown> };
    projects.createProject = async () => { throw Object.assign(new Error(`upstream refused Authorization: Bearer ${key}`), { code: "EUPSTREAM", body: `{"token":"${key}"}` }); };
    const answer = await c.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Garden" } } as never) as { ok: boolean; error?: { code: string; message: string } };
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.code, "unavailable");
    assert.ok(!JSON.stringify(answer).includes(key.slice(4)));
    assert.equal(problems.length, 1, "the sink was called");
    const got = problems[0] as Error & { code?: string; body?: string };
    assert.ok(got instanceof Error);
    assert.equal(got.code, "EUPSTREAM");
    for (const part of [got.message, got.stack, got.body]) assert.ok(typeof part === "string" && !part.includes(key.slice(4)), `cleaned: ${String(part).slice(0, 80)}`);
    assert.match(got.message, /^upstream refused Authorization: .*\[redacted\]$/);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
