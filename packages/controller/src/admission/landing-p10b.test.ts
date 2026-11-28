import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { AdmissionService, DEFAULT_LIMITS, type RequestAdmission } from "./index.js";

after(stopServer);

// Card P10b ("another is woken through admission and budget, with reserved capacity"; "a full queue of author attempts does not starve landing"): a landing attempt asks admission for a `landing` place. It shares the
// control lane, which productive work can never take, and each lane's queue is bounded on its own, so author attempts that fill every productive place and the whole queue still leave landing a place, and a landing
// that must wait is not refused because the authors' queue is full.
const options = { clock: () => "2026-11-28T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, pattern?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (pattern !== undefined) assert.match(error.message, pattern); return true; });
};

for (const backend of backends) {
  const rig = async () => {
    const world = await backend.open();
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
    const admission = AdmissionService.withEpoch(world.storage, projects.epoch, options);
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 64, memoryMb: 262_144 } });
    const ask = (extra: Partial<RequestAdmission> = {}) => admission.request({ commandId: cid("r"), actor: "controller", class: "productive", host: "host:h1", cpus: 1, memoryMb: 1024, project: "proj-a", agent: "ann", ...extra } as RequestAdmission);
    const landing = (extra: Partial<RequestAdmission> = {}) => ask({ class: "landing", agent: "ivy", ...extra });
    return { world, admission, ask, landing, close: () => world.close() };
  };

  test(`${backend.name}: a landing attempt takes a reserved control place while author attempts fill every productive place and their whole queue (card P10b)`, async () => {
    const r = await rig();
    try {
      await r.admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, productive: 2, perHost: 2, queue: 3 } });
      const authors = [];
      for (let i = 0; i < 5; i++) authors.push(await r.ask());
      assert.deepEqual(authors.map((a) => a.state), ["running", "running", "waiting", "waiting", "waiting"]);
      await refuses("unavailable", () => r.ask(), /queue is full \(3 waiting\)/);
      // Saturated with author work: a landing is admitted at once, in the control lane, with its project and agent; author work is never moved for it.
      const l1 = await r.landing();
      assert.equal(l1.state, "running");
      const s = await r.admission.snapshot();
      const entry = s.running.find((e) => e.id === l1.id)!;
      assert.deepEqual([entry.class, entry.project, entry.agent, entry.workClass], ["landing", "proj-a", "ivy", undefined]);
      assert.deepEqual([s.running.filter((e) => e.class === "productive").length, s.queue.length], [2, 3]);
      // A second landing takes the other control place; a third waits there, and is not refused although the authors' queue is full.
      assert.equal((await r.landing({ project: "proj-b" })).state, "running");
      const l3 = await r.landing({ project: "proj-c" });
      assert.equal(l3.state, "waiting");
      const where = await r.admission.where(l3.id);
      assert.equal(where.state === "waiting" ? where.reason : where.state, "waiting for capacity: 2 control attempts are already running");
      // The control lane's own queue is bounded too (the same figure): three landings wait, the fourth is refused.
      await r.landing({ project: "proj-d" }); await r.landing({ project: "proj-e" });
      await refuses("unavailable", () => r.landing({ project: "proj-f" }), /queue is full/);
      // A productive place that frees goes to the waiting author, never to a landing; a control place that frees goes to the waiting landing, never to an author.
      await r.admission.release({ commandId: cid("rel"), actor: "controller", requestId: authors[0]!.id, reason: "done" });
      assert.equal((await r.admission.where(authors[2]!.id)).state, "running");
      assert.equal((await r.admission.where(l3.id)).state, "waiting");
      await r.admission.release({ commandId: cid("rel"), actor: "controller", requestId: l1.id, reason: "landed" });
      assert.equal((await r.admission.where(l3.id)).state, "running");
      assert.equal((await r.admission.where(authors[3]!.id)).state, "waiting");
      // The quotas view counts landing places with the control places.
      const owner = { kind: "owner", id: "owner:rob", grants: [] } as never;
      const q = await r.admission.quotas(owner);
      assert.deepEqual([q.running.productive, q.running.control], [2, 2]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing request names its project and has no P/PC class; hostile values are refused (card P10b)`, async () => {
    const r = await rig();
    try {
      await refuses("invalid_command", () => r.landing({ project: undefined } as never), /project: is required for a landing attempt/);
      await refuses("invalid_command", () => r.landing({ workClass: "P" }), /workClass/);
      await refuses("invalid_command", () => r.landing({ workClass: "PC" }), /workClass/);
      await refuses("invalid_command", () => r.landing({ project: "../x" }), /project: is not a valid ID/);
      await refuses("invalid_command", () => r.landing({ project: "p".repeat(121) }), /project/);
      await refuses("invalid_command", () => r.ask({ class: "Landing" as never }), /class: must be one of productive, inquiry, review, landing/);
      await refuses("invalid_command", () => r.ask({ class: "landing\u0000" as never }), /class/);
      // Without a host a landing is still placed (the control lane counts places, not a host's CPUs and memory).
      assert.equal((await r.landing({ host: undefined } as never)).state, "running");
      assert.equal((await r.admission.snapshot()).queue.length, 0);
    } finally { await r.close(); }
  });
}
