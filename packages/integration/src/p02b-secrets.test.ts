import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets, type LocalHostBuilder, type LocalHostContext } from "@nimblenewt/controller";

// Card P02b: what the launcher hands a worker host builder so the backup's file scan sees the secret store's VALUES in use and the push credential is read by NAME only. Fake secrets made at run time; no sandbox needed.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const start = { facts, filesystem: ext4, features: [] } as const;
const fake = (label: string): string => `${label}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

test("the host builder gets the secret values in use (provider keys, the owner's credential, the push credentials owners named) and reads one secret by name, never the owner's credential through the push path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-p02b-sec-"));
  const values = new Map<string, string>([["backup-key", fake("bk")], ["garden-token", fake("gt")], ["unrelated", fake("un")]]);
  const secrets: LauncherSecrets = { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) };
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
    primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
    backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
  } } };
  let context: LocalHostContext | undefined;
  const builder: LocalHostBuilder = async (ctx) => { context = ctx; return { problem: "captured for the test" }; };
  try {
    const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start });
    assert.equal((await first.controller.api.handle(first.ownerToken, { v: 1, op: "host.local.set", commandId: "host-on", args: { enabled: true } } as never)).ok, true);
    await first.close();
    const l = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, localHost: builder });
    assert.ok(context !== undefined, "the builder was asked");
    const before = await context!.secretValues();
    const names = before.map((s) => s.name);
    assert.ok(names.includes("backup-key"), names.join(","));
    assert.ok(names.some((n) => n.startsWith("nimblenewt-owner")), "the owner's own credential must never reach a remote either");
    assert.ok(!names.includes("unrelated") && !names.includes("garden-token"), "only secrets the configuration or an owner's record names are read; the store is never listed");
    assert.equal(before.find((s) => s.name === "backup-key")?.value, values.get("backup-key"));
    // An owner names a push credential: it joins the values the scan looks for. Its value is read at the call, not before.
    const on = await l.controller.api.handle(l.ownerToken, { v: 1, op: "wip.backup.set", commandId: "wip-on", args: { project: await projectOf(l), enabled: true, remote: "https://git.example.com/me/wip.git", credential: "garden-token" } } as never) as { ok: boolean };
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.equal((await context!.secretValues()).find((s) => s.name === "garden-token")?.value, values.get("garden-token"));
    assert.equal(await context!.secret("garden-token"), values.get("garden-token"));
    assert.equal(await context!.secret("not-there"), undefined);
    await assert.rejects(context!.secret(before.find((s) => s.name.startsWith("nimblenewt-owner"))!.name), /reserved for the owner's credential/);
    // A secret that is gone from the store is simply not in the list (the scan still checks credential shapes).
    values.delete("garden-token");
    assert.ok(!(await context!.secretValues()).some((s) => s.name === "garden-token"));
    await l.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

async function projectOf(l: Awaited<ReturnType<typeof launch>>): Promise<string> {
  const owner = await l.controller.services.principals.authenticate(l.ownerToken);
  return (await l.controller.services.projects.createProject({ commandId: "p-sec", actor: owner.id, name: "Garden" })).id;
}
