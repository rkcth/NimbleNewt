import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { Principal } from "../security/principals.js";
import { AdmissionService } from "./index.js";
import { DEFAULT_LIMITS } from "./policy.js";

after(stopServer);

const options = { clock: () => "2026-11-08T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, message?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (message !== undefined) assert.match(error.message, message); return true; });
};

for (const backend of backends) {
  const suite = (name: string, body: (c: { admission: AdmissionService; owner: Principal; agent: Principal; ask(host: string): Promise<{ id: string; state: string }> }) => Promise<void>) =>
    test(`${backend.name}: host and global quotas (card H10): ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        for (const h of ["h1", "h2"]) await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: h, grants: [] });
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const admission = AdmissionService.withEpoch(world.storage, projects.epoch, options);
        const ask = (host: string) => admission.request({ commandId: cid("r"), actor: "dispatcher", class: "productive", host, cpus: 1, memoryMb: 512 });
        await body({ admission, owner, agent, ask });
      } finally { await world.close(); }
    });

  suite("the owner reads the defaults, declares a host's CPUs and memory and sets the quotas; nothing is placed on an undeclared host", async ({ admission, owner, ask }) => {
    const first = await admission.quotas(owner);
    assert.deepEqual([first.limits, first.defaults, first.hosts, first.running, first.waiting], [
      { productive: DEFAULT_LIMITS.productive, perHost: DEFAULT_LIMITS.perHost, control: DEFAULT_LIMITS.control, queue: DEFAULT_LIMITS.queue },
      { productive: 4, perHost: 2, control: 2, queue: 100 }, {}, { productive: 0, control: 0, perHost: {} }, 0,
    ]);
    // A host with no declared capacity holds nothing: the request is withdrawn by the next change, and declaring the host lets new work in.
    await refuses("invalid_command", () => ask("host:h1"), /no capacity has been declared/);
    const changed = await admission.changeQuotas(owner, { commandId: "q1", hosts: { "host:h1": { cpus: 4, memoryMb: 4096 } }, set: { perHost: 1 } });
    assert.ok(changed.revision > 0);
    const a = await ask("host:h1");
    const b = await ask("host:h1");
    assert.deepEqual([a.state, b.state], ["running", "waiting"], "one per host now");
    const read = await admission.quotas(owner);
    assert.deepEqual([read.limits.perHost, read.hosts, read.running, read.waiting], [1, { "host:h1": { cpus: 4, memoryMb: 4096 } }, { productive: 1, control: 0, perHost: { "host:h1": 1 } }, 1]);
    // Raising the per-host quota lets the waiting request in at once, in the same step.
    await admission.changeQuotas(owner, { commandId: "q2", set: { perHost: 2 } });
    assert.equal((await admission.where(b.id)).state, "running");
    // A repeat of a command applies once (and reports the revision it made).
    const again = await admission.changeQuotas(owner, { commandId: "q2", set: { perHost: 2 } });
    assert.equal((await admission.quotas(owner)).limits.perHost, 2);
    assert.ok(again.revision > 0);
  });

  suite("a lower global quota stops nothing that runs and admits nothing new until the work is under it", async ({ admission, owner, ask }) => {
    await admission.changeQuotas(owner, { commandId: cid("q"), hosts: { "host:h1": { cpus: 8, memoryMb: 8192 }, "host:h2": { cpus: 8, memoryMb: 8192 } } });
    const running = [await ask("host:h1"), await ask("host:h1"), await ask("host:h2")];
    assert.deepEqual(running.map((r) => r.state), ["running", "running", "running"]);
    await admission.changeQuotas(owner, { commandId: cid("q"), set: { productive: 1, perHost: 1 } });
    for (const r of running) assert.equal((await admission.where(r.id)).state, "running", "a lower quota stops nothing");
    const next = await ask("host:h2");
    assert.equal(next.state, "waiting");
    await admission.release({ commandId: cid("rel"), actor: "dispatcher", requestId: running[0]!.id, reason: "done" });
    await admission.release({ commandId: cid("rel"), actor: "dispatcher", requestId: running[1]!.id, reason: "done" });
    assert.equal((await admission.where(next.id)).state, "waiting", "still one running in total (host:h2's own)");
    await admission.release({ commandId: cid("rel"), actor: "dispatcher", requestId: running[2]!.id, reason: "done" });
    assert.equal((await admission.where(next.id)).state, "running", "under the quota again, the waiting request is admitted");
  });

  suite("the reserved control places stay open for reviews and inquiries while the productive quota is full, and stopping needs none", async ({ admission, owner, ask }) => {
    await admission.changeQuotas(owner, { commandId: cid("q"), hosts: { "host:h1": { cpus: 8, memoryMb: 8192 } }, set: { productive: 1, perHost: 1, control: 1 } });
    const work = await ask("host:h1");
    const waiting = await ask("host:h1");
    assert.deepEqual([work.state, waiting.state], ["running", "waiting"]);
    const review = await admission.request({ commandId: cid("rv"), actor: "dispatcher", class: "review", cpus: 1, memoryMb: 256 });
    assert.equal(review.state, "running", "a review is admitted though the work is full");
    await admission.release({ commandId: cid("rel"), actor: "dispatcher", requestId: waiting.id, reason: "stopped by the owner" });
    assert.equal((await admission.where(waiting.id)).state, "absent", "a stop takes the waiting request out without needing a place");
  });

  suite("only the owner reads or changes the quotas, and every figure and host is checked", async ({ admission, owner, agent }) => {
    await refuses("forbidden", () => admission.quotas(agent));
    await refuses("forbidden", () => admission.changeQuotas(agent, { commandId: cid("q"), set: { productive: 8 } }));
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q") }), /at least one/);
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q"), set: { productive: 0 } }), /set\.productive/);
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q"), set: { depth: 2 } }), /not a quota/);
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q"), set: { perHost: 8 } }), /perHost: cannot exceed/);
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q"), hosts: { "host:h9": { cpus: 1, memoryMb: 1 } } }), /not an active host/);
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q"), hosts: { "host:h1": { cpus: 0, memoryMb: 1 } } }), /cpus/);
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q"), hosts: { "../x": { cpus: 1, memoryMb: 1 } } }), /not a host ID/);
    await refuses("invalid_command", () => admission.changeQuotas(owner, { commandId: cid("q"), set: { productive: 2 }, extra: 1 } as never));
    assert.deepEqual((await admission.quotas(owner)).limits.productive, 4, "nothing changed");
  });
}
