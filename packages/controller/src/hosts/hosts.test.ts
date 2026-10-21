import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, GrantService, type Principal } from "../security/index.js";
import { HostService, type Capabilities } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-21T10:00:00.000Z");
const at = (): string => new Date(now).toISOString();
const options = { clock: at, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const caps: Capabilities = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["none"], tools: ["read-file"], workspaces: ["main"] };

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    hosts: HostService; principals: PrincipalService; grants: GrantService; projects: ProjectService; assignments: AssignmentService; owner: Principal;
    host(name: string, grants?: { action: string; project: string }[]): Promise<{ principal: Principal; token: string }>;
    agent(name: string): Promise<Principal>;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-21T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const hosts = HostService.withEpoch(world.storage, projects.epoch, assignments, { ...options, staleAfterMs: 60_000 });
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const host = async (name: string, given: { action: string; project: string }[] = []) => {
          await principals.enroll(owner, { commandId: cid("enroll"), kind: "host", name, grants: given });
          const credential = await principals.issueCredential(owner, `host:${name}`);
          return { principal: await principals.authenticate(credential.token), token: credential.token };
        };
        const agent = async (name: string) => {
          await principals.enroll(owner, { commandId: cid("enroll"), kind: "agent", name, grants: [] });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token);
        };
        await body({ hosts, principals, grants, projects, assignments, owner, host, agent });
      } finally { await world.close(); }
    });

  suite("a host that has never been heard from is unknown, a fresh one is fresh, and a silent one goes stale", async ({ hosts, host, owner }) => {
    const { principal } = await host("build-1");
    await refuses("invalid_command", () => hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 1 }), (e) => assert.match(e.message, /not announced/));
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    assert.equal((await hosts.status(owner, principal.id))!.freshness, "unknown", "announced but no heartbeat yet");
    await hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 1 });
    let status = (await hosts.status(owner, principal.id))!;
    assert.deepEqual([status.identity, status.freshness, status.ageMs], ["active", "fresh", 0]);
    assert.deepEqual(status.capabilities, caps);
    now += 59_000;
    assert.equal((await hosts.status(owner, principal.id))!.freshness, "fresh");
    now += 2_000;
    status = (await hosts.status(owner, principal.id))!;
    assert.deepEqual([status.freshness, status.ageMs], ["stale", 61_000]);
    await hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 2 });
    assert.equal((await hosts.status(owner, principal.id))!.freshness, "fresh", "a new heartbeat makes it fresh again");
    assert.equal((await hosts.list(owner)).items.length, 1);
  });

  suite("the controller's clock is used, and an old heartbeat cannot be replayed to make a host look alive", async ({ hosts, host, owner }) => {
    const { principal } = await host("build-1");
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    const first = await hosts.heartbeat(principal, { commandId: "beat-one", sequence: 5 });
    now += 120_000;
    assert.equal((await hosts.status(owner, principal.id))!.freshness, "stale");
    assert.equal((await hosts.heartbeat(principal, { commandId: "beat-one", sequence: 5 })).replayed, true, "the same message again is recognised");
    assert.equal((await hosts.status(owner, principal.id))!.freshness, "stale", "and does not refresh anything");
    await refuses("invalid_command", () => hosts.heartbeat(principal, { commandId: cid("old"), sequence: 5 }), (e) => assert.match(e.message, /not after the last accepted/));
    await refuses("invalid_command", () => hosts.heartbeat(principal, { commandId: cid("old"), sequence: 3 }));
    await refuses("invalid_command", () => hosts.heartbeat(principal, { commandId: cid("zero"), sequence: 0 }));
    await refuses("invalid_command", () => hosts.heartbeat(principal, { commandId: cid("extra"), sequence: 9, hostTime: "2030-01-01T00:00:00.000Z" } as never), (e) => assert.match(e.message, /not a field/));
    void first;
  });

  suite("only a host announces and beats; an agent or the owner is refused, and a host sees only itself", async ({ hosts, host, agent, owner }) => {
    const one = await host("one");
    const two = await host("two");
    const ann = await agent("ann");
    await refuses("forbidden", () => hosts.announce(ann, { commandId: cid("an"), capabilities: caps }), (e) => assert.match(e.message, /not a host/));
    await refuses("forbidden", () => hosts.heartbeat(owner, { commandId: cid("hb"), sequence: 1 }));
    await hosts.announce(one.principal, { commandId: cid("an"), capabilities: caps });
    await hosts.announce(two.principal, { commandId: cid("an"), capabilities: caps });
    assert.equal((await hosts.status(one.principal, one.principal.id))!.hostId, "host:one");
    assert.equal(await hosts.status(one.principal, two.principal.id), undefined, "another host reads as absent");
    assert.equal(await hosts.status(ann, one.principal.id), undefined);
    await refuses("forbidden", () => hosts.list(one.principal));
    await refuses("forbidden", () => hosts.get(ann, one.principal.id));
    assert.equal((await hosts.list(owner)).items.length, 2);
    const first = await hosts.list(owner, { limit: 1 });
    assert.equal(first.items.length, 1);
    assert.equal((await hosts.list(owner, { limit: 1, afterId: first.next! })).items.length, 1);
  });

  suite("rotating the credential ends the old one and keeps the host's record; a revoked host is denied even with a principal object it still holds", async ({ hosts, principals, host, owner }) => {
    const { principal, token } = await host("build-1");
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    await hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 1 });
    const rotated = await principals.issueCredential(owner, principal.id);
    await refuses("unauthenticated", () => principals.authenticate(token));
    // An object obtained before the rotation is refused too, not only the old token.
    await refuses("unauthenticated", () => hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 99 }));
    await refuses("unauthenticated", () => hosts.announce(principal, { commandId: cid("an"), capabilities: caps }));
    const again = await principals.authenticate(rotated.token);
    await hosts.heartbeat(again, { commandId: cid("hb"), sequence: 2 });
    assert.equal((await hosts.get(owner, principal.id))!.heartbeats, 2, "the record, and its history, survived the rotation");
    // Revoke.
    const stored = (await principals.get(principal.id))!;
    await principals.disable(owner, { commandId: cid("dis"), principalId: principal.id, expectedRevision: stored.revision });
    await refuses("unauthenticated", () => principals.authenticate(rotated.token));
    await refuses("unauthenticated", () => hosts.heartbeat(again, { commandId: cid("hb"), sequence: 3 }));
    await refuses("unauthenticated", () => hosts.announce(again, { commandId: cid("an"), capabilities: caps }));
    const status = (await hosts.status(owner, principal.id))!;
    assert.equal(status.identity, "revoked");
    assert.equal((await hosts.get(owner, principal.id))!.heartbeats, 2, "nothing was recorded after the revocation");
  });

  suite("a reinstalled host with a new credential starts its sequence again, and what the old credential sent cannot come back", async ({ hosts, principals, host, owner }) => {
    const { principal } = await host("build-1");
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    await hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 101 });
    const fresh = await principals.authenticate((await principals.issueCredential(owner, principal.id)).token);
    await hosts.announce(fresh, { commandId: cid("an"), capabilities: caps });
    await hosts.heartbeat(fresh, { commandId: cid("hb"), sequence: 1 });
    await refuses("invalid_command", () => hosts.heartbeat(fresh, { commandId: cid("hb"), sequence: 1 }), (e) => assert.match(e.message, /not after/));
    await hosts.heartbeat(fresh, { commandId: cid("hb"), sequence: 2 });
    await refuses("unauthenticated", () => hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 102 }), (e) => assert.match(e.message, /not accepted/));
    assert.equal((await hosts.get(owner, principal.id))!.heartbeats, 3);
  });

  suite("a name that was never enrolled, or belongs to an agent, has no status rather than a revoked one", async ({ hosts, agent, owner }) => {
    await agent("ann");
    assert.equal(await hosts.status(owner, "host:nope"), undefined);
    assert.equal(await hosts.status(owner, "agent:ann"), undefined);
  });

  suite("two first announcements at once both end well", async ({ hosts, host, owner }) => {
    const { principal } = await host("build-1");
    const results = await Promise.allSettled([hosts.announce(principal, { commandId: cid("an"), capabilities: caps }), hosts.announce(principal, { commandId: cid("an"), capabilities: caps })]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
    assert.ok((await hosts.get(owner, principal.id)) !== undefined);
  });

  suite("a silent, stale, rotated or revoked host does not release the tasks it works on", async ({ hosts, principals, assignments, projects, host, owner }) => {
    const { principal } = await host("build-1");
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    await hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 1 });
    const project = await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "P" });
    const task = await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project.id, title: "x" });
    await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: task.id, owner: { kind: "agent", id: "ann" } });
    const before = JSON.stringify(await assignments.getAssignment(task.id));
    now += 3_600_000;
    assert.equal((await hosts.status(owner, principal.id))!.freshness, "stale");
    await principals.issueCredential(owner, principal.id);
    const stored = (await principals.get(principal.id))!;
    await principals.disable(owner, { commandId: cid("dis"), principalId: principal.id, expectedRevision: stored.revision });
    assert.equal((await hosts.status(owner, principal.id))!.identity, "revoked");
    assert.equal(JSON.stringify(await assignments.getAssignment(task.id)), before, "the assignment is exactly as it was: same owner, generation and revision");
  });

  suite("progress is recorded under the host's own identity, needs the project's work grant, and does not refresh freshness", async ({ hosts, host, owner, assignments, projects }) => {
    const project = await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "P" });
    const other = await projects.createProject({ commandId: cid("p2"), actor: "owner:rob", name: "Q" });
    const task = await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project.id, title: "x" });
    const elsewhere = await projects.createTask({ commandId: cid("t2"), actor: "owner:rob", projectId: other.id, title: "y" });
    await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: task.id, owner: { kind: "agent", id: "ann" } });
    const { principal } = await host("build-1", [{ action: "attempt.work", project: project.id }]);
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    await hosts.heartbeat(principal, { commandId: cid("hb"), sequence: 1 });
    now += 120_000;
    await hosts.reportProgress(principal, { commandId: cid("pr"), taskId: task.id, generation: 1, kind: "tests-running", detail: "12 of 40" });
    const seen = (await assignments.getActivity(task.id))!;
    assert.deepEqual([seen.observedBy, seen.kind, seen.current], ["host:build-1", "tests-running", true]);
    assert.equal((await hosts.status(owner, principal.id))!.freshness, "stale", "progress is not a heartbeat");
    const missing = "task-aaaaaaaaaaaaaaaaaaaa";
    const answers = await Promise.all([elsewhere.id, missing].map((id) => hosts.reportProgress(principal, { commandId: cid("pr"), taskId: id, generation: 1, kind: "x" }).then(() => "ok", (e: DomainError) => `${e.code}: ${e.message}`)));
    assert.equal(answers[0], answers[1], "a task in an unrelated project reads like one that does not exist");
    await refuses("invalid_command", () => hosts.reportProgress(principal, { commandId: cid("pr"), taskId: task.id, generation: 1, kind: "x", observedBy: "agent:ann" } as never), (e) => assert.match(e.message, /not a field/));
  });

  suite("capabilities are validated, bounded and kept free of credentials; announcing again replaces them", async ({ hosts, host, owner }) => {
    const { principal } = await host("build-1");
    const bad = (c: unknown) => hosts.announce(principal, { commandId: cid("an"), capabilities: c as never });
    await refuses("invalid_command", () => bad("linux"));
    await refuses("invalid_command", () => bad({ ...caps, gpu: "yes" }), (e) => assert.match(e.message, /not a capability field/));
    await refuses("invalid_command", () => bad({ ...caps, os: "" }));
    await refuses("invalid_command", () => bad({ ...caps, tools: Array.from({ length: 51 }, (_, i) => `t${i}`) }), (e) => assert.match(e.message, /at most 50/));
    await refuses("invalid_command", () => bad({ ...caps, harnesses: [{ name: "pi", version: "1", token: "x" }] }));
    await refuses("invalid_command", () => bad({ ...caps, workspaces: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"] }), (e) => assert.match(e.message, /credential/));
    assert.equal(await hosts.get(owner, principal.id), undefined, "nothing was recorded");
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    await hosts.announce(principal, { commandId: cid("an"), capabilities: { ...caps, harnesses: [{ name: "pi", version: "1.4.0" }] } });
    assert.equal((await hosts.get(owner, principal.id))!.capabilities.harnesses[0]!.version, "1.4.0");
  });

  suite("heartbeats sent at the same moment all end in a consistent record", async ({ hosts, host, owner }) => {
    const { principal } = await host("build-1");
    await hosts.announce(principal, { commandId: cid("an"), capabilities: caps });
    const results = await Promise.allSettled([1, 2, 3, 4].map((sequence) => hosts.heartbeat(principal, { commandId: cid("hb"), sequence })));
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && r.reason.code === "invalid_command", String(r.reason));
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    const record = (await hosts.get(owner, principal.id))!;
    assert.equal(record.heartbeats, accepted, "every accepted heartbeat was counted once");
    assert.ok(record.lastSequence >= 1 && record.lastSequence <= 4);
  });
}
