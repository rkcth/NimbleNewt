import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string } };

test("through the running controller: the owner sets an HTTP probe, a due check is taken by the controller itself with no task, a bad answer is an incident (clearing is tested in projects/p04i); an agent cannot set or read a probe (card P04i)", async () => {
  let status = 200;
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(status); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const d = mkdtempSync(join(tmpdir(), "nn-p04i-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "responsibility.read", project: "*" }, { action: "responsibility.write", project: "*" }] });
    const annToken = (await c.services.principals.issueCredential(owner, "agent:ann")).token;
    const as = (token: string) => (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const call = as(boot.token); const asAnn = as(annToken);
    const project = (await call("project.create", { name: "Ops" }, "p1")).result.id as string;
    // A one-minute schedule, so the first check is due a minute after creation.
    const duty = (await call("responsibility.create", { projectId: project, title: "Keep web up", objective: "Up", desiredCondition: "health answers 200", everyMinutes: 1, ownerId: "agent:ann" }, "r1")).result.id as string;

    assert.equal((await asAnn("responsibility.probe.set", { responsibilityId: duty, url: `http://127.0.0.1:${port}/health` }, "a1")).error?.code, "forbidden");
    assert.equal((await asAnn("responsibility.probe.get", { responsibilityId: duty })).error?.code, "forbidden");
    assert.equal((await call("responsibility.probe.set", { responsibilityId: duty, url: `http://127.0.0.1:${port}/health`, extra: 1 }, "x1")).error?.code, "invalid_command");
    assert.equal((await call("responsibility.probe.set", { responsibilityId: duty, url: `http://rob:pw@127.0.0.1:${port}/health` }, "x2")).error?.code, "invalid_command");
    const set = await call("responsibility.probe.set", { responsibilityId: duty, url: `http://127.0.0.1:${port}/health?verbose=1`, timeoutSeconds: 5 }, "s1");
    assert.deepEqual(set.result, { revision: 1, shown: `http://127.0.0.1:${port}/health` });
    assert.equal((await call("responsibility.probe.get", { responsibilityId: duty })).result.item.probe.timeoutSeconds, 5);

    // Wait (real time) for the check to come due, then tick until the answer is recorded.
    let lastBad: unknown = [];
    const settle = async (want: number): Promise<any[]> => {
      const deadline = Date.now() + 100_000;
      for (;;) {
        const ticked = await c.dispatch!.dispatcher.tick();
        lastBad = (ticked.loops ?? []).filter((l) => !l.ok);
        const h = (await call("responsibility.history", { responsibilityId: duty })).result.items as any[];
        const checks = h.filter((x) => x.kind === "check");
        if (checks.length >= want) return checks;
        if (Date.now() >= deadline) assert.fail(`no check recorded in time: ${JSON.stringify(h)} checks=${JSON.stringify((await call("responsibility.checks", { projectId: project })))} hits=${JSON.stringify(hits)} failedLoops=${JSON.stringify(lastBad)} status=${JSON.stringify((await call("responsibility.status", { responsibilityId: duty })))}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const first = await settle(1);
    assert.deepEqual([first[0].outcome, first[0].summary.startsWith(`HTTP check of http://127.0.0.1:${port}/health answered 200`)], ["ok", true]);
    assert.ok(!first[0].summary.includes("verbose"), "the query is not shown");
    assert.ok(hits.includes("/health?verbose=1"), "the address was asked as the owner wrote it");
    assert.equal((await c.storage.listAggregates("task", { limit: 20 })).length, 0, "no agent task");
    assert.equal((await call("responsibility.observed", { responsibilityId: duty })).result.item.observed, "ok");

    status = 503;
    const second = await settle(2);
    assert.equal(second[1].outcome, "failed");
    const incidents = (await call("responsibility.incidents", { projectId: project, open: true })).result.items as any[];
    assert.equal(incidents.length, 1);
    assert.equal((await c.storage.listAggregates("task", { limit: 20 })).length, 0);

  } finally {
    await c.close();
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
