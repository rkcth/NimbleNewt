import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { CoverageGapService } from "../projects/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
const provider = (location: "local" | "cloud") => ({ enabled: true, paid: false, location });
const route = { contextTokens: 100_000, capabilities: ["tools"] };
const table = {
  providers: { strata: provider("local"), openrouter: provider("cloud") },
  routes: { "strata/qwen": route, "openrouter/qwen": route },
  profiles: { main: ["strata/qwen", "openrouter/qwen"], solo: ["strata/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main" },
};
const topology = { services: ["strata-svc"], targets: { "strata/qwen": { endpoint: "strata-http", account: "local-acct", service: "strata-svc" }, "openrouter/qwen": { endpoint: "or-api", account: "or-acct" } }, aliases: {} };

test("through the running controller: a provider outage is listed only for a responsibility whose agent can use it, and a team stop notes the responsibilities of its agents (T3, card P04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-t3p04-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    await c.services.routing.setTable(owner, { commandId: "tbl", expectedRevision: 0, table } as never);
    await c.services.cutover.setTopology(owner, { commandId: "top", expectedRevision: 0, topology });
    const project = (await call("project.create", { name: "Ops" }, "p1")).result.id as string;
    const team = (await call("team.create", { name: "Ops team" }, "t1")).result.id as string;
    const sub = (await call("team.create", { name: "Sub", parentTeamId: team }, "t2")).result.id as string;
    const local = (await call("agent.create", { friendlyName: "Local", defaultProfile: "solo", teamId: sub }, "a1")).result.id as string;
    const broad = (await call("agent.create", { friendlyName: "Broad", defaultProfile: "main" }, "a2")).result.id as string;
    const unknown = (await call("agent.create", { friendlyName: "Unknown" }, "a3")).result.id as string;
    const mk = async (title: string, agent: string, id: string) => { const r = await call("responsibility.create", { projectId: project, title, objective: "Up", everyMinutes: 60, ownerId: `agent:${agent}`, escalation: { to: "owner" } }, id); assert.ok(r.ok, JSON.stringify(r)); return r.result.id as string; };
    const rLocal = await mk("Local duty", local, "r1"); const rBroad = await mk("Broad duty", broad, "r2"); const rUnknown = await mk("Unknown duty", unknown, "r3");
    const gaps = CoverageGapService.withEpoch(c.storage, c.epoch);
    const start = new Date(Date.now() - 5 * 60_000).toISOString();
    await gaps.open(owner, { key: "provider:endpoint:or-api", reason: "provider-outage", start, detail: "cloud api down" } as never);
    const reasons = async (id: string) => ((await call("responsibility.observed", { responsibilityId: id })).result.item.coverageGaps as { reason: string }[]).map((g) => g.reason);
    assert.deepEqual(await reasons(rLocal), [], "its agent uses only the local endpoint: the cloud outage is not about it");
    assert.deepEqual(await reasons(rBroad), ["provider-outage"], "its profile reaches the cloud route");
    assert.deepEqual(await reasons(rUnknown), ["provider-outage"], "no default profile: unknown routes keep it listed");
    await gaps.open(owner, { key: "provider:endpoint:strata-http", reason: "provider-outage", start, detail: "local engine down" } as never);
    assert.deepEqual(await reasons(rLocal), ["provider-outage"], "the local outage is about it");
    assert.equal((await call("responsibility.gaps", { projectId: project })).result.items.length, 2, "the project's list stays whole");

    // A team stop reaches the agents under it, sub-teams included.
    const stop = await call("lifecycle.stop", { scope: { kind: "team", id: team }, mode: "suspend", reason: "night" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    await call("lifecycle.sweep", {});
    for (let i = 0; i < 3; i++) await c.dispatch!.dispatcher.tick();
    const noteOf = async (id: string) => ((await call("responsibility.history", { responsibilityId: id, limit: 20 })).result.items as { kind: string; summary: string; by?: string }[]).filter((h) => h.kind === "note" && h.summary.includes("does not stop the service it maintains"));
    const local1 = await noteOf(rLocal);
    assert.equal(local1.length, 1, "the agent in the sub-team was reached");
    assert.match(local1[0]!.summary, /was suspended with its team\./);
    assert.equal(local1[0]!.by, "service:stop-notes");
    assert.deepEqual([(await noteOf(rBroad)).length, (await noteOf(rUnknown)).length], [0, 0], "agents outside the team are not noted");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
