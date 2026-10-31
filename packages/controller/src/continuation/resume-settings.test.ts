import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MemoryStorage } from "../storage/memory.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { ResumeCheckService, ResumeSettingsService, type ResumePorts } from "./index.js";
import { RETRY_BACKOFF_MS } from "./resume.js";

after(stopServer);

let now = Date.parse("2026-10-30T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const model = { provider: "local", id: "m1" };

for (const backend of backends) {
  test(`${backend.name}: the blocked-round retry limit is an owner setting read per new check (default 3)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
      const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:agt-abcdefghijklmnopqrst")).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const mkTask = async () => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;

      // The reviewer is down, so every round blocks without a blocker (the retry path the limit governs).
      const ports: ResumePorts = { observe: async () => ({}), missingContext: async () => [], uncertainEffects: async () => [], review: async () => { throw new Error("reviewer offline"); } };
      const continuations = { latest: async () => ({ id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never), resume: async () => { throw new Error("not reached"); } };
      const dependencies = { check: async () => [{ id: "dep-1", kind: "file" as const, key: "/f", status: "changed" as never, detail: "now changed" }] };
      const bl = { getBlocker: async () => undefined as never, openBlocker: async () => ({ id: "blk-x" }) as never };
      const settings = ResumeSettingsService.withEpoch(world.storage, projects.epoch, undefined, options);
      const svc = ResumeCheckService.withEpoch(world.storage, projects.epoch, { continuations, dependencies, blockers: bl, ports }, { ...options, rounds: () => settings.effective() });

      /** Retries (after each backoff) until retries are used up; returns the number of blocked rounds. */
      const drive = async (checkId: string) => {
        let c = (await svc.get(owner, checkId))!;
        for (let i = 0; i < 12 && !svc.exhausted(c); i++) {
          assert.equal(c.phase, "blocked");
          now += RETRY_BACKOFF_MS * 12;
          assert.ok(await svc.retryable(c), `round ${c.blocks} is retryable`);
          c = await svc.retry(owner, { checkId });
        }
        return c;
      };

      const t1 = await mkTask();
      const first = await svc.start(owner, { commandId: cid("s"), taskId: t1, model, after: "restart" });
      assert.equal(first.maxRounds, 3, "unset: the default");
      const done1 = await drive(first.id);
      assert.equal(done1.blocks, 3, "escalates after 3 blocked rounds");
      assert.ok(svc.exhausted(done1));
      await svc.cancel(owner, { checkId: first.id });

      // Only the owner may read or set; bad figures and stale revisions are refused; a repeat is the same change.
      const forbidden = async (run: () => Promise<unknown>, code: string) => assert.rejects(run, (e: unknown) => e instanceof DomainError && e.code === code);
      await forbidden(() => settings.set(agent, { commandId: cid("w"), maxRounds: 5 }), "forbidden");
      await forbidden(() => settings.get(agent), "forbidden");
      for (const bad of [0, 11, 2.5, "4", undefined, NaN]) await forbidden(() => settings.set(owner, { commandId: cid("w"), maxRounds: bad }), "invalid_command");
      await forbidden(() => settings.set(owner, { commandId: cid("w"), maxRounds: 5, expectedRevision: 9 }), "stale_revision");
      assert.equal((await settings.get(owner)).effective, 3, "refused sets changed nothing");

      const t2 = await mkTask();
      const running = await svc.start(owner, { commandId: cid("s"), taskId: t2, model, after: "restart" });
      assert.equal(running.maxRounds, 3);
      const wid = cid("w");
      const set = await settings.set(owner, { commandId: wid, maxRounds: 5 });
      assert.deepEqual(await settings.set(owner, { commandId: wid, maxRounds: 5 }), set, "same command ID is the same change");
      assert.equal((await settings.get(owner)).effective, 5);

      const doneRunning = await drive(running.id);
      assert.equal(doneRunning.blocks, 3, "a running check keeps the figure it started with");
      await svc.cancel(owner, { checkId: running.id });

      const t3 = await mkTask();
      const fresh = await svc.start(owner, { commandId: cid("s"), taskId: t3, model, after: "restart" });
      assert.equal(fresh.maxRounds, 5, "a new check reads the setting");
      assert.equal((await drive(fresh.id)).blocks, 5);
      await svc.cancel(owner, { checkId: fresh.id });

      await settings.set(owner, { commandId: cid("w"), maxRounds: null, expectedRevision: set.revision });
      assert.equal((await settings.get(owner)).effective, 3, "cleared: the default applies");
    } finally { await world.close(); }
  });
}

test("a damaged stored retry limit falls back to the default and warns the owner once per damage episode, never blocking a resume", async () => {
  const storage = new MemoryStorage();
  const { epoch } = await storage.acquireEpoch({ holder: "t", at: "2026-10-30T10:00:00.000Z" });
  const warned: { revision: number; detail: string }[] = [];
  const settings = ResumeSettingsService.withEpoch(storage, epoch, 3, { ...options, warn: async (d) => { warned.push(d); } });
  const owner = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as never;
  await settings.set(owner, { commandId: cid("w"), maxRounds: 5 });
  assert.equal(await settings.effective(), 5);
  assert.equal(warned.length, 0);
  const real = storage.getAggregate.bind(storage);
  let body: unknown = { maxRounds: 99, updatedBy: "owner:rob", updatedAt: "x" };
  storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "resume-settings" && a !== undefined ? { ...a, body } as never : a; };
  for (const damaged of [{ maxRounds: 99 }, { maxRounds: "4" }, { maxRounds: 2.5 }, { maxRounds: null }, "junk"]) {
    body = damaged;
    assert.equal(await settings.effective(), 3, `${JSON.stringify(damaged)}: the default applies instead of throwing`);
  }
  assert.equal(warned.length, 5, "the service reports every read; the notification's stable id per revision makes it one");
  assert.equal(new Set(warned.map((w) => w.revision)).size, 1, "one damage episode = one record revision = one notification ID");
  assert.match(warned[0]!.detail, /damaged/);
  // A warning that cannot be sent does not block the resume.
  const failing = ResumeSettingsService.withEpoch(storage, epoch, 3, { ...options, warn: async () => { throw new Error("notifications down"); } });
  assert.equal(await failing.effective(), 3);
});
