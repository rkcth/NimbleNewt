import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CommandRunner } from "../domain/runner.js";
import type { JsonObject } from "../storage/types.js";
import { AcceptanceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-30T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: versions, events, no self-review, voided review, concurrent decisions (card Q01)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const artifact = async (name: string, taskId = task): Promise<string> => {
        const id = derivedId("art", cid("art"));
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id }, build: async () => ({ ref: { kind: "artifact", id }, creates: true, changes: [{ type: "create" as const, ref: { kind: "artifact", id }, body: { name, projectId: project, taskId, entries: [], manifestDigest: `m-${name}`, totalBytes: 0, createdBy: owner.id } as unknown as JsonObject }], detail: {} }) }));
        return id;
      };
      const damaged = new Set<string>();
      const assigned = new Map<string, string[]>();
      const svc = AcceptanceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        contractVersion: async () => 0,
        verifyArtifact: async (id) => ({ ok: !damaged.has(id), problems: damaged.has(id) ? 1 : 0 }),
        reviewersAvailableIn: async (_p, worker) => [...roles].filter(([id, r]) => id !== worker && (r.includes("reviewer") || r.includes("director"))).map(([id]) => id),
        reviewAssignments: async (p) => assigned.get(p) ?? [],
      }, options);
      const ann = await agent("ann", ["author", "docs", "reviewer"]);
      const rev = await agent("rev", ["reviewer"]);
      const dir = await agent("dir", ["director"]);
      const eve = await agent("eve", []);
      const a1 = await artifact("one");

      const made = await svc.draft(ann, { commandId: cid("d"), taskId: task, type: "document", title: "Guide", artifacts: [{ artifactId: a1 }] });
      const again = await svc.draft(ann, { commandId: "same", taskId: task, type: "report", title: "R", artifacts: [{ artifactId: a1 }] });
      assert.equal((await svc.draft(ann, { commandId: "same", taskId: task, type: "report", title: "R", artifacts: [{ artifactId: a1 }] })).replayed, true);
      await refuses("command_conflict", () => svc.draft(ann, { commandId: "same", taskId: task, type: "report", title: "R2", artifacts: [{ artifactId: a1 }] }));
      void again;
      await refuses("forbidden", () => svc.draft(eve, { commandId: cid("d"), taskId: task, type: "report", title: "R", artifacts: [{ artifactId: a1 }] }), /roles/);
      await refuses("invalid_command", () => svc.draft(ann, { commandId: cid("d"), taskId: task, type: "report", title: "R", artifacts: [{ artifactId: "art-aaaaaaaaaaaaaaaaaaaa" }] }));
      await refuses("not_found", () => svc.accept(owner, { commandId: cid("a"), id: "dlv-aaaaaaaaaaaaaaaaaaaa", version: 1 }));

      let rv = made.revision;
      const sub = await svc.submit(ann, { commandId: cid("s"), id: made.id, expectedRevision: rv, contractVersion: 0 });
      rv = sub.revision;
      await refuses("forbidden", () => svc.startReview(ann, { commandId: cid("r"), id: made.id, version: 1 }), /no self-review/);
      await refuses("forbidden", () => svc.startReview(eve, { commandId: cid("r"), id: made.id, version: 1 }));
      await refuses("forbidden", () => svc.startReview(rev, { commandId: cid("r"), id: made.id, version: 1 }), /asked to review/);
      assigned.set(rev.id, [made.id]);
      const started = await svc.startReview(rev, { commandId: "rs", id: made.id, version: 1 });
      assert.equal((await svc.startReview(rev, { commandId: "rs", id: made.id, version: 1 })).replayed, true);
      assert.equal(started.replayed, false);
      await refuses("forbidden", () => svc.accept(ann, { commandId: cid("a"), id: made.id, version: 1 }), /no self-review/);

      // The artifact is damaged under the review: accepting voids it instead.
      damaged.add(a1);
      await refuses("integrity", () => svc.accept(rev, { commandId: "acc-bad", id: made.id, version: 1 }));
      assert.equal((await svc.get(owner, made.id))!["state"], "submitted");
      await refuses("integrity", () => svc.startReview(rev, { commandId: cid("r"), id: made.id, version: 1 }));
      await refuses("invalid_transition", () => svc.accept(rev, { commandId: "acc-bad", id: made.id, version: 1 }), /submitted/);
      damaged.delete(a1);
      await svc.startReview(dir, { commandId: cid("r"), id: made.id, version: 1 });
      await refuses("forbidden", () => svc.accept(rev, { commandId: cid("a"), id: made.id, version: 1 }), /started/);
      const ok = await svc.accept(dir, { commandId: "acc", id: made.id, version: 1 });
      assert.equal((await svc.accept(dir, { commandId: "acc", id: made.id, version: 1 })).replayed, true);
      assert.equal(ok.replayed, false);
      await refuses("invalid_transition", () => svc.accept(owner, { commandId: cid("a"), id: made.id, version: 1 }));
      assert.deepEqual(await svc.acceptedFor(task), { accepted: true, deliverables: [made.id] });
      const kinds = (await svc.events(owner, made.id, { limit: 50 })).items.map((e) => `${e.seq}:${e.version}:${e.kind}`);
      assert.deepEqual(kinds, ["1:1:draft", "2:1:submitted", "3:1:under-review", "4:1:invalidated", "5:1:under-review", "6:1:accepted"]);

      // A new version supersedes the accepted one; acceptance is gone until the new one is accepted.
      const a2 = await artifact("two");
      const cur = (await svc.get(owner, made.id))!;
      await svc.newVersion(ann, { commandId: cid("n"), id: made.id, expectedRevision: cur["revision"] as number, artifacts: [{ artifactId: a2 }] });
      assert.deepEqual((await svc.get(owner, made.id))!["versions"], [{ version: 1, state: "superseded" }, { version: 2, state: "draft" }]);
      assert.deepEqual(await svc.acceptedFor(task), { accepted: false, deliverables: [] });

      // Two deciders at once: exactly one decision lands.
      const second = await svc.draft(ann, { commandId: cid("d"), taskId: task, type: "operational-outcome", title: "Restart", outcome: { reference: "eff-1", systemVersion: "v1", observedAt: "2026-10-30T09:00:00.000Z" } });
      await svc.submit(ann, { commandId: cid("s"), id: second.id, expectedRevision: second.revision, contractVersion: 0 });
      await svc.startReview(dir, { commandId: cid("r"), id: second.id, version: 1 });
      const results = await Promise.allSettled([svc.accept(dir, { commandId: cid("a"), id: second.id, version: 1 }), svc.reject(owner, { commandId: cid("j"), id: second.id, version: 1, reason: "no" })]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await svc.events(owner, second.id, { limit: 50 })).items.filter((e) => e.kind === "accepted" || e.kind === "rejected").length, 1);
      // An outcome needs its reference, system version and time.
      await refuses("invalid_command", () => svc.draft(ann, { commandId: cid("d"), taskId: task, type: "operational-outcome", title: "x", outcome: { reference: "", systemVersion: "v", observedAt: "2026-10-30T09:00:00.000Z" } }));
      const empty = await svc.draft(ann, { commandId: cid("d"), taskId: task, type: "operational-outcome", title: "x" });
      await refuses("invalid_command", () => svc.submit(ann, { commandId: cid("s"), id: empty.id, expectedRevision: empty.revision, contractVersion: 0 }), /outcome/);
    } finally { await world.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: review scope, disabled review, stale checks, supersede notice, redaction (card Q01fx)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const artifact = async (name: string, taskId = task): Promise<string> => {
        const id = derivedId("art", cid("art"));
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id }, build: async () => ({ ref: { kind: "artifact", id }, creates: true, changes: [{ type: "create" as const, ref: { kind: "artifact", id }, body: { name, projectId: project, taskId, entries: [], manifestDigest: `m-${name}`, totalBytes: 0, createdBy: owner.id } as unknown as JsonObject }], detail: {} }) }));
        return id;
      };
      const damaged = new Set<string>();
      const notices: string[] = [];
      let onVerify: ((id: string) => Promise<void>) | undefined;
      const assigned = new Map<string, string[]>();
      const svc = AcceptanceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        contractVersion: async () => 0,
        verifyArtifact: async (id) => { await onVerify?.(id); return { ok: !damaged.has(id), problems: damaged.has(id) ? 1 : 0 }; },
        notify: async (n) => { notices.push(n.text); },
        reviewersAvailableIn: async (_p, worker) => [...roles].filter(([id, r]) => id !== worker && (r.includes("reviewer") || r.includes("director"))).map(([id]) => id),
        reviewAssignments: async (p) => assigned.get(p) ?? [],
      }, options);
      const ann = await agent("ann", ["author", "docs"]);
      const rev = await agent("rev", ["reviewer"]);
      const dir = await agent("dir", ["director"]);
      const a1 = await artifact("one");
      const submitted = async (title: string, art = a1) => {
        const m = await svc.draft(ann, { commandId: cid("d"), taskId: task, type: "report", title, artifacts: [{ artifactId: art }] });
        const sb = await svc.submit(ann, { commandId: cid("s"), id: m.id, expectedRevision: m.revision, contractVersion: 0 });
        return { id: m.id, revision: sb.revision };
      };

      // 1. A reviewer decides only what it was asked to review; a director only in a project its grant names (here dir holds task.read in this project).
      const one = await submitted("one");
      await refuses("forbidden", () => svc.startReview(rev, { commandId: cid("r"), id: one.id, version: 1 }), /asked to review/);
      assigned.set(rev.id, ["dlv-aaaaaaaaaaaaaaaaaaaa"]);
      await refuses("forbidden", () => svc.startReview(rev, { commandId: cid("r"), id: one.id, version: 1 }), /asked to review/);
      assigned.set(rev.id, [one.id]);
      await svc.startReview(rev, { commandId: cid("r"), id: one.id, version: 1 });
      const wild = { ...dir, grants: [{ action: "task.read", project: "*" }] } as Principal;
      await refuses("forbidden", () => svc.accept(wild, { commandId: cid("a"), id: one.id, version: 1 }), /director of this project/);

      // 2. Re-evaluated at decision time: with no other agent able to review any more, an agent cannot decide; the owner can.
      roles.delete(rev.id); roles.delete(dir.id);
      await refuses("forbidden", () => svc.accept(dir, { commandId: cid("a"), id: one.id, version: 1 }), /review is disabled/);
      roles.set(dir.id, ["director"]); roles.set(rev.id, ["reviewer"]);
      assert.equal((await svc.accept(dir, { commandId: cid("a"), id: one.id, version: 1 })).replayed, false);

      // 3. A version recorded review-disabled is never decided by an agent, even when a reviewer joins later.
      roles.delete(rev.id); roles.delete(dir.id);
      const solo = await submitted("solo");
      assert.deepEqual(((await svc.get(owner, solo.id))!["version"] as { review: unknown }).review, { required: false, reason: "review_disabled_single_agent" });
      roles.set(dir.id, ["director"]);
      await refuses("forbidden", () => svc.startReview(dir, { commandId: cid("r"), id: solo.id, version: 1 }), /review is disabled/);
      await svc.startReview(owner, { commandId: cid("r"), id: solo.id, version: 1 });
      await refuses("forbidden", () => svc.accept(dir, { commandId: cid("a"), id: solo.id, version: 1 }), /review is disabled/);
      await svc.accept(owner, { commandId: cid("a"), id: solo.id, version: 1 });

      // 4. The artifact record changes between the check and the commit: the acceptance does not commit.
      const two = await submitted("two", await artifact("two"));
      assigned.set(rev.id, [one.id, two.id]);
      roles.set(rev.id, ["reviewer"]);
      await svc.startReview(dir, { commandId: cid("r"), id: two.id, version: 1 });
      const art2 = ((await svc.get(owner, two.id))!["version"] as { content: { artifacts: { artifactId: string }[] } }).content.artifacts[0]!.artifactId;
      onVerify = async (id) => {
        onVerify = undefined;
        const cur = (await world.storage.getAggregate({ kind: "artifact", id }))!;
        await runner.command("test.touch", { commandId: cid("touch"), actor: owner.id }, async () => ({ payload: { id }, build: async () => ({ ref: { kind: "artifact", id }, creates: false, changes: [{ type: "update" as const, ref: { kind: "artifact", id }, expectedRevision: cur.revision, body: { ...cur.body, totalBytes: 1 } }], detail: {} }) }));
      };
      await assert.rejects(() => svc.accept(dir, { commandId: cid("a"), id: two.id, version: 1 }), (e: unknown) => e instanceof DomainError && ["stale_revision", "conflict"].includes(e.code) || (assert.fail(String(e)), true));
      assert.equal((await svc.get(owner, two.id))!["state"], "under-review", "nothing was accepted");
      void art2;

      // 5. A new version while a review is going on or after acceptance is recorded and told.
      const cur = (await svc.get(owner, two.id))!;
      await svc.newVersion(ann, { commandId: cid("n"), id: two.id, expectedRevision: cur["revision"] as number, artifacts: [{ artifactId: a1 }] });
      assert.equal(notices.length, 1);
      assert.match(notices[0]!, /while under-review \(under review by agent:dir\)/);
      const events = (await svc.events(owner, two.id, { limit: 50 })).items;
      assert.match(events.find((e) => e.kind === "superseded")!.reason!, /while under-review/);
      const acc = (await svc.get(owner, one.id))!;
      await svc.newVersion(ann, { commandId: cid("n"), id: one.id, expectedRevision: acc["revision"] as number, artifacts: [{ artifactId: a1 }] });
      assert.match(notices[1]!, /while accepted \(accepted by agent:dir\)/);

      // 6. Outcome text is redacted; the responsible agent must exist.
      const out = await svc.draft(ann, { commandId: cid("d"), taskId: task, type: "operational-outcome", title: "o", outcome: { reference: "ref key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234", systemVersion: "v sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234", observedAt: "2026-10-30T09:00:00.000Z" } });
      const shown = JSON.stringify((await svc.get(owner, out.id))!["version"]);
      assert.ok(!shown.includes("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234"), shown);
      await refuses("invalid_command", () => svc.draft(owner, { commandId: cid("d"), taskId: task, type: "report", title: "ghost", responsibleAgent: "agent:ghost", artifacts: [{ artifactId: a1 }] }), /not an active agent/);
    } finally { await world.close(); }
  });
}
