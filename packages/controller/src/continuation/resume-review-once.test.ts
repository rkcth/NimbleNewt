import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/types.js";
import { PrincipalService } from "../security/index.js";
import { ResumeCheckService, type ResumePorts } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-28T10:00:00.000Z", pause: async () => undefined };
const model = { provider: "local", id: "m1" };

/**
 * CI repair round 7 (the resume reviewer was asked twice on PostgreSQL on a slow Windows runner): a check in "reviewing" was guarded only while the reviewer was asked, not until its verdict was
 * written, so another advance of the same check (the resume sweep beside the dispatcher's own check) that came between the answer and the write asked the reviewer a second time. Here the write
 * of the verdict is held, and the second advance is made exactly in that gap.
 */
for (const backend of backends) {
  test(`${backend.name}: a second advance of a check whose verdict is being written does not ask the reviewer again`, async () => {
    const world = await backend.open();
    try {
      let reviewed = false;
      let gapUsed = false;
      let second: Promise<unknown> | undefined;
      let svc: ResumeCheckService | undefined;
      let checkId: string | undefined;
      let ownerRef: Awaited<ReturnType<PrincipalService["authenticate"]>> | undefined;
      // The first write after the reviewer answered is the verdict: before it goes through, the same check is advanced again.
      const storage = new Proxy(world.storage, {
        get(target, prop, receiver) {
          if (prop === "applyOperation") {
            return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => {
              if (reviewed && !gapUsed && svc !== undefined && checkId !== undefined) {
                gapUsed = true;
                second = svc.advance(ownerRef!, { checkId });
                await second;
              }
              return target.applyOperation(input);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as ControllerStorage;
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      ownerRef = owner;
      const project = (await projects.createProject({ commandId: "p1", actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "one" })).id;
      const asked: string[][] = [];
      let answer: (() => void) | undefined;
      const answered = new Promise<void>((r) => { answer = r; });
      const ports: ResumePorts = {
        observe: async () => ({}),
        missingContext: async () => [],
        uncertainEffects: async () => [],
        review: async (r) => {
          asked.push(r.changes.map((c) => c.id));
          if (asked.length === 1) await answered;
          reviewed = true;
          return Object.fromEntries(r.changes.map((c) => [c.id, { relevant: false, rationale: `${c.key} does not matter` }]));
        },
      };
      const continuations = { latest: async () => ({ id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never), resume: async () => ({ identity: "conv", continuation: { id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never, modelChanged: false }) as never };
      const dependencies = { check: async () => [{ id: "dep-1", kind: "file" as const, key: "/f/dep-1", status: "changed" as never, detail: "now changed" }] };
      const blockers = { getBlocker: async (id: string) => ({ id, state: "open" }) as never, openBlocker: async () => undefined as never };
      svc = ResumeCheckService.withEpoch(storage, projects.epoch, { continuations: continuations as never, dependencies: dependencies as never, blockers: blockers as never, ports }, options);
      // The check is started; it waits in "reviewing" while the reviewer is out.
      const first = svc.start(owner, { commandId: "s1", taskId: task, model, after: "restart" });
      for (let i = 0; i < 500 && asked.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
      assert.equal(asked.length, 1, "the reviewer was asked");
      checkId = (await svc.forTask(owner, task))!.id;
      answer!();
      const done = await first;
      await second;
      assert.equal(gapUsed, true, "the second advance came between the answer and the verdict's write");
      assert.equal(asked.length, 1, "the reviewer was asked once");
      assert.equal(done.phase, "ready");
      assert.equal((await svc.get(owner, checkId))!.phase, "ready");
    } finally { await world.close(); }
  });
}
