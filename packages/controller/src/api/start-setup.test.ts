import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

type Item = { id: string; state: string; required: boolean; detail: string };
type Readiness = { ready: boolean; items: Item[]; next?: string };

test("setup.readiness lists what is missing on a fresh installation and follows each step to ready; only the owner reads it (card U14)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-setup-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result: any; error?: { code: string } }>;
    const read = async (): Promise<Readiness> => { const r = await call(boot.token, "setup.readiness", {}); assert.ok(r.ok, JSON.stringify(r)); return r.result.item; };
    const state = (r: Readiness, id: string): Item => r.items.find((i) => i.id === id)!;

    // A fresh installation has an owner and nothing else; the defaults are named as defaults, not as gaps.
    const fresh = await read();
    assert.equal(fresh.ready, false);
    assert.equal(fresh.next, "project");
    assert.equal(state(fresh, "owner").state, "done");
    assert.equal(state(fresh, "profile").state, "default");
    assert.match(state(fresh, "profile").detail, /strict/);
    assert.equal(state(fresh, "notifications").state, "default");
    for (const id of ["project", "model-route", "host", "agent"]) assert.equal(state(fresh, id).state, "missing", id);
    assert.equal(state(fresh, "task").state, "optional");
    assert.deepEqual(fresh.items.filter((i) => i.required).map((i) => i.id), ["owner", "project", "model-route", "host", "agent"]);

    // Each step moves the view on.
    const project = await call(boot.token, "project.create", { name: "Demo", goal: "try it" }, "p1");
    assert.ok(project.ok, JSON.stringify(project));
    let r = await read();
    assert.equal(state(r, "project").state, "done");
    assert.match(state(r, "project").detail, /1 active project, 0 with a repository/);
    assert.equal(r.next, "model-route");

    await c.services.routing.setTable(rob, { commandId: "rt1", expectedRevision: 0, table: { providers: { local: { enabled: true, paid: false, location: "local" }, spare: { enabled: true, paid: false, location: "local" } }, routes: { "local/small": { contextTokens: 32000, capabilities: ["tools"] }, "spare/big": { contextTokens: 128000, capabilities: ["tools"] } }, profiles: { easy: ["local/small", "spare/big"] }, roles: { coordinator: "easy", "safety-supervisor": "easy" } } });
    r = await read();
    assert.equal(state(r, "model-route").state, "done");
    assert.equal(r.next, "host");

    await c.services.principals.enroll(rob, { commandId: "h1", kind: "host", name: "laptop", grants: [] });
    r = await read();
    assert.equal(state(r, "host").state, "missing");
    assert.match(state(r, "host").detail, /none has announced/);

    // The host announces itself with its capabilities; only then is it counted.
    const hostPrincipal = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "host:laptop")).token);
    await HostService.withEpoch(c.storage, c.epoch, c.services.assignments).announce(hostPrincipal, { commandId: "an1", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["none"], tools: ["read-file"], workspaces: ["main"] } });
    r = await read();
    assert.equal(state(r, "host").state, "done");
    assert.equal(r.next, "agent");

    const agent = await call(boot.token, "agent.create", { friendlyName: "Ann" }, "a1");
    assert.ok(agent.ok, JSON.stringify(agent));
    r = await read();
    assert.equal(state(r, "agent").state, "done");
    assert.equal(r.ready, true);
    assert.equal(r.next, undefined);

    const settings = (await call(boot.token, "notifications.settings", {})).result.item;
    await call(boot.token, "notifications.configure", { digestTimes: ["08:00"], expectedRevision: settings.revision }, "n1");
    assert.equal(state(await read(), "notifications").state, "done");

    // Only the owner reads it; an agent and a bad argument are refused; reading changes nothing.
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.equal((await call(ann, "setup.readiness", {})).error?.code, "forbidden");
    assert.equal((await call(boot.token, "setup.readiness", { x: 1 })).error?.code, "invalid_command");
    assert.deepEqual(await read(), await read());
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
