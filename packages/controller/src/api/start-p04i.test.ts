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
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(req.url === "/down" ? 503 : 200); res.end(); });
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
    // Two hourly responsibilities started long ago, so a check of each is due at once (the stored time is moved back, as the clock cannot be: no real wait). One is healthy, one answers 503.
    const make = async (title: string, k: string) => (await call("responsibility.create", { projectId: project, title, objective: "Up", desiredCondition: "health answers 200", everyMinutes: 60, ownerId: "agent:ann" }, k)).result.id as string;
    const duty = await make("Keep web up", "r1");
    const down = await make("Keep api up", "r2");
    const long = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const realGet = c.storage.getAggregate.bind(c.storage);
    const realList = c.storage.listAggregates.bind(c.storage);
    const back = (a: any) => (a?.kind === "responsibility" ? { ...a, createdAt: long, updatedAt: long } : a);
    c.storage.getAggregate = async (ref) => back(await realGet(ref));
    c.storage.listAggregates = (async (kind: string, o: any) => (await realList(kind, o)).map(back)) as never;

    assert.equal((await asAnn("responsibility.probe.set", { responsibilityId: duty, url: `http://127.0.0.1:${port}/health` }, "a1")).error?.code, "forbidden");
    assert.equal((await asAnn("responsibility.probe.get", { responsibilityId: duty })).error?.code, "forbidden");
    assert.equal((await call("responsibility.probe.set", { responsibilityId: duty, url: `http://127.0.0.1:${port}/health`, extra: 1 }, "x1")).error?.code, "invalid_command");
    assert.equal((await call("responsibility.probe.set", { responsibilityId: duty, url: `http://rob:pw@127.0.0.1:${port}/health` }, "x2")).error?.code, "invalid_command");
    const set = await call("responsibility.probe.set", { responsibilityId: duty, url: `http://127.0.0.1:${port}/health?verbose=1`, timeoutSeconds: 5 }, "s1");
    assert.deepEqual(set.result, { revision: 1, shown: `http://127.0.0.1:${port}/health` });
    assert.equal((await call("responsibility.probe.get", { responsibilityId: duty })).result.item.probe.timeoutSeconds, 5);
    assert.ok((await call("responsibility.probe.set", { responsibilityId: down, url: `http://127.0.0.1:${port}/down` }, "s2")).ok);

    // Tick until both answers are recorded (the request runs apart from the pass, so a few passes).
    let lastBad: unknown = [];
    const deadline = Date.now() + 60_000;
    const checksOf = async (id: string): Promise<any[]> => ((await call("responsibility.history", { responsibilityId: id })).result.items as any[]).filter((x) => x.kind === "check");
    for (;;) {
      const ticked = await c.dispatch!.dispatcher.tick();
      lastBad = (ticked.loops ?? []).filter((l) => !l.ok);
      if ((await checksOf(duty)).length >= 1 && (await checksOf(down)).length >= 1) break;
      if (Date.now() >= deadline) assert.fail(`no check recorded in time: checks=${JSON.stringify((await call("responsibility.checks", { projectId: project })))} hits=${JSON.stringify(hits)} failedLoops=${JSON.stringify(lastBad)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const [first] = await checksOf(duty);
    assert.deepEqual([first.outcome, first.summary.startsWith("HTTP check of the owner's health address answered 200")], ["ok", true], first.summary);
    assert.ok(hits.includes("/health?verbose=1"), "the address was asked as the owner wrote it");
    assert.equal((await c.storage.listAggregates("task", { limit: 20 })).length, 0, "no agent task");
    assert.equal((await call("responsibility.observed", { responsibilityId: duty })).result.item.observed, "ok");

    const [bad] = await checksOf(down);
    assert.equal(bad.outcome, "failed");
    const incidents = (await call("responsibility.incidents", { projectId: project, open: true })).result.items as any[];
    assert.deepEqual(incidents.map((i) => i.responsibilityId), [down]);
    assert.equal((await c.storage.listAggregates("task", { limit: 20 })).length, 0);
    // What the agent reads names neither address (second review).
    const seen = JSON.stringify([await asAnn("responsibility.history", { responsibilityId: duty }), await asAnn("responsibility.history", { responsibilityId: down }), await asAnn("responsibility.incidents", { projectId: project }), await asAnn("responsibility.checks", { projectId: project })]);
    assert.ok(seen.includes("the owner's health address"), seen.slice(0, 500));
    for (const part of ["127.0.0.1", "/health", "/down", "verbose"]) assert.ok(!seen.includes(part), `${part}: ${seen.slice(0, 1500)}`);

  } finally {
    await c.close();
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
