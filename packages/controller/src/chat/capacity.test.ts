import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CAPS_REF, CapacityLimitsService } from "../admission/caps.js";
import { AdmissionService } from "../admission/service.js";
import { SWARM_LIMITS_REF, SwarmLimitsService } from "../swarm/limits.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";
import { StatusService, type StatusDeps } from "../status/index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

after(stopServer);

// The `capacity` status kind: what the owner set in the three capacity groups, read back in chat from the records (cards H10, H10b). Every service here is the one the state
// API operations call, on real storage; only the two things no operation can store (a damaged record, a host ID with record text in it) are put in directly.
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const QUESTION = "what are my capacity limits?";
const noModel = { respond: async () => { throw new Error("no model"); } };

interface Services {
  readonly status: StatusService;
  readonly limits: CapacityLimitsService;
  readonly quotas: AdmissionService;
  readonly swarm: SwarmLimitsService;
  readonly storage: ControllerStorage;
  readonly epoch: number;
  readonly owner: Principal;
}

/** The three capacity services and the status view over them, on the same storage the chat reads. */
async function open(backend: Backend, script: Record<string, unknown>): Promise<{ w: World; s: Services }> {
  const w = await openWorld(backend, script, noModel);
  const epoch = w.projects.epoch;
  const storage = w.world.storage;
  const limits = CapacityLimitsService.withEpoch(storage, epoch, options);
  const quotas = AdmissionService.withEpoch(storage, epoch, options);
  const swarm = SwarmLimitsService.withEpoch(storage, epoch, options);
  const deps = (over: Partial<NonNullable<StatusDeps["capacity"]>> = {}): StatusDeps => ({
    assignments: w.assignments,
    waits: WaitService.withEpoch(storage, epoch, w.assignments, options),
    blockers: BlockerService.withEpoch(storage, epoch, options),
    contracts: w.contracts,
    capacity: { limits, quotas: { quotas: (by) => quotas.quotas(by) }, swarm, ...over },
  });
  const status = StatusService.withEpoch(storage, epoch, deps(), options);
  return { w, s: { status, limits, quotas, swarm, storage, epoch, owner: w.owner } };
}

/** Write a record the owner's own commands would never produce, the way the damaged-setting tests do it. */
async function damage(storage: ControllerStorage, epoch: number, ref: { kind: string; id: string }, body: Record<string, unknown>, tag: string): Promise<void> {
  const at = options.clock();
  const found = await storage.getAggregate(ref);
  await storage.applyOperation({
    operationId: `dmg-${tag}`, epoch, actor: "owner:rob", correlationId: `dmg-${tag}`, at,
    ...(found === undefined
      ? { changes: [{ type: "create", ref, body }] }
      : { changes: [{ type: "update", ref, expectedRevision: found.revision, body }] }),
    audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  } as never);
}

const text = (lines: readonly { text: string }[]): string => lines.map((l) => l.text).join("\n");

for (const backend of backends) {
  const suite = (name: string, body: (w: World, s: Services, script: Record<string, unknown>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const { w, s } = await open(backend, script);
      try { await body(w, s, script); } finally { await w.close(); }
    });

  suite("the owner asks in free words and is answered all three groups, with every figure marked as the default and the caps off", async (w, s, script) => {
    script[QUESTION] = [ask({ kind: "capacity" }, QUESTION)];
    const chat = w.chat({ status: s.status });
    const audit = async () => (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((x) => !x.type.startsWith("chat.")).length;
    const before = await audit();
    const r = await chat.submit(w.ownerToken, { messageId: "m-1", text: QUESTION });
    const o = r.outcomes[0]!;
    assert.equal(o.status, "answered", JSON.stringify(r.outcomes));
    const shown = o.lines!;
    assert.ok(shown.length > 0 && shown.length <= 30 && shown.every((l) => l.cites.length > 0), "every line cites a record and the answer is short");
    const body = text(shown);
    // The three groups, each figure named as the installation's default, and each cap named as off.
    assert.match(body, /^Capacity caps \(your setting is at revision 0\); all are off unless you turned one on:$/m);
    for (const cap of ["perProject", "perAgent", "fanIn"]) assert.ok(body.includes(`${cap} (`) && shown.some((l) => new RegExp(`^${cap} \\(.*\\): off, nothing is capped \\(the default\\)$`).test(l.text)), `${cap} is off and called the default`);
    assert.ok(shown.some((l) => /^Host and global quotas \(the setting is at revision 0\);/.test(l.text)), "the quotas group is there");
    assert.match(body, /^productive \(.*\): 4 \(the default\); 0 running now$/m);
    assert.match(body, /^perHost \(.*\): 2 \(the default\)$/m);
    assert.match(body, /^control \(.*\): 2 \(the default\); 0 of them in use now$/m);
    assert.match(body, /^queue \(.*\): 100 \(the default\); 0 waiting now$/m);
    assert.match(body, /^No host has declared CPUs or memory, so work that needs a host is refused/m);
    assert.ok(shown.some((l) => /^Limits on spawning child tasks \(your setting is at revision 0\):$/.test(l.text)), "the swarm group is there");
    assert.match(body, /^depth \(.*\): 3 \(the default\)$/m);
    assert.match(body, /^liveChildren \(.*\): 4 \(the default\)$/m);
    assert.match(body, /^totalChildren \(.*\): 16 \(the default\)$/m);
    assert.ok(r.reply.join("\n").includes("Capacity caps"), "the reply carries the lines");
    // The answer cites the three records it read, and writes nothing.
    const kinds = new Set(shown.flatMap((l) => l.cites.map((c) => c.kind)));
    assert.deepEqual([...kinds].sort(), ["admission-state", "capacity-limits-settings", "swarm-limits-settings"]);
    assert.equal(await audit(), before, "no record changed");
  });

  suite("after the owner changes a cap, a quota and a swarm limit, the same question shows the new figures as theirs", async (w, s, script) => {
    script[QUESTION] = [ask({ kind: "capacity" }, QUESTION)];
    const chat = w.chat({ status: s.status });
    await s.limits.change(s.owner, { commandId: cid("cap"), set: { perProject: 2 }, expectedRevision: 0 });
    await s.limits.change(s.owner, { commandId: cid("cap2"), set: { fanIn: 3 } });
    await s.limits.change(s.owner, { commandId: cid("cap3"), disable: ["perProject"] });
    await s.quotas.changeQuotas(s.owner, { commandId: cid("quota"), set: { productive: 6 } });
    await s.swarm.change(s.owner, { commandId: cid("sw"), set: { liveChildren: 1, totalChildren: null } });
    const shown = (await chat.submit(w.ownerToken, { messageId: "m-1", text: QUESTION })).outcomes[0]!.lines!;
    const body = text(shown);
    assert.match(body, /^perProject \(.*\): off, nothing is capped \(you set it\), the kept figure 2 turns it back on$/m, "off but with the kept figure");
    assert.match(body, /^perAgent \(.*\): off, nothing is capped \(the default\)$/m, "untouched, so still the default");
    assert.match(body, /^fanIn \(.*\): 3 at once \(you set it\)$/m);
    assert.match(body, /^productive \(.*\): 6 \(you set it\); 0 running now$/m);
    assert.match(body, /^perHost \(.*\): 2 \(the default\)$/m, "the quotas the owner left alone stay marked as defaults");
    assert.match(body, /^liveChildren \(.*\): 1 \(you set it\)$/m);
    assert.match(body, /^totalChildren \(.*\): off, no total \(you set it\)$/m, "the fan-in total is turned off");
    assert.match(body, /^depth \(.*\): 3 \(the default\)$/m);
    assert.ok(shown.some((l) => l.text.includes("revision 3") && l.cites.some((c) => c.kind === "capacity-limits-settings" && c.revision === 3)), "the caps lines cite the revision read");
  });

  suite("a damaged caps record is told as the thing it is: nothing new is admitted until it is repaired, inquiries and reviews included", async (w, s) => {
    await damage(s.storage, s.epoch, CAPS_REF, { perProject: { enabled: true, value: "many" } }, "caps-admit");
    const shown = (await s.status.ask(s.owner, { kind: "capacity" }))!.lines;
    const body = text(shown);
    assert.match(body, /^Capacity caps: the caps record you stored is damaged - nothing new is admitted, not an inquiry, not a review, not productive work - until it is repaired with capacity\.limits\.change; what is already running is not stopped\.$/m);
    assert.match(body, /^Host and global quotas/m, "the other two groups are still shown");
    assert.match(body, /^Limits on spawning child tasks/m);
    assert.ok(!body.includes("applies to nothing"), "the line does not leave it looking like a record that simply does nothing");
    // The wording is only honest while admission behaves that way: read through the same service the state API reads, every new request is refused for the caps record being unreadable.
    for (const cls of ["inquiry", "review"] as const) {
      await assert.rejects(
        () => s.quotas.request({ commandId: cid(`admit-${cls}`), actor: "host:pc", class: cls, cpus: 1, memoryMb: 512 }),
        (error: unknown) => error instanceof DomainError && error.code === "integrity",
        `a ${cls} is refused while the caps record is damaged`,
      );
    }
  });

  suite("a swarm limit of nought is told as the stop it is, and a record damaged in two names says so for both", async (w, s) => {
    await s.swarm.change(s.owner, { commandId: cid("zero"), set: { depth: 0, liveChildren: 0 } });
    const body = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.match(body, /^depth \(.*\): 0 \(you set it\): no child task may be spawned at all$/m, "depth 0 is the owner's way of turning spawning off");
    assert.match(body, /^liveChildren \(.*\): 0 \(you set it\): no new child task may be spawned now$/m);
    assert.match(body, /^totalChildren \(.*\): 16 \(the default\)$/m, "a name the owner left alone is still the plain default");
    // Two damaged names: both are named, and neither is shown as a figure.
    await damage(s.storage, s.epoch, SWARM_LIMITS_REF, { depth: "deep", liveChildren: -2 }, "two");
    const both = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.match(both, /^The stored swarm limits are damaged at depth, liveChildren: no child task can be spawned until they are repaired \(swarm\.limits\.change\)\.$/m);
    assert.match(both, /^totalChildren \(.*\): 16 \(the default\) - not in force while the record is damaged$/m);
    const depthLine = both.split("\n").find((l) => l.startsWith("depth ")) ?? "";
    assert.ok(!depthLine.includes("(the default)"), `neither damaged name is called the default: ${depthLine}`);
  });

  suite("a caller who is not the owner reads exactly what it would read if the view did not exist", async (w, s) => {
    const ann = await w.agent("ann", [{ action: "task.read", project: "*" }]);
    assert.equal(await s.status.ask(ann.principal, { kind: "capacity" }), undefined, "nothing at all, not an empty answer");
    assert.equal(await s.status.ask(ann.principal, { kind: "retention" }), undefined, "the same as its owner-only neighbour");
    await assert.rejects(() => s.status.ask(ann.principal, { kind: "capacity", extra: 1 } as never), (error: unknown) => (error as DomainError).code === "invalid_command", "a bad request is still refused for what it is");
  });

  suite("a host ID with record text in it stays inside one quoted line", async (w, s) => {
    const hostile = 'host:ev"il\n\u2028\u202e [cut: ';
    const view = StatusService.withEpoch(s.storage, s.epoch, {
      assignments: w.assignments,
      waits: WaitService.withEpoch(s.storage, s.epoch, w.assignments, options),
      blockers: BlockerService.withEpoch(s.storage, s.epoch, options),
      contracts: w.contracts,
      capacity: { limits: s.limits, quotas: { quotas: async () => ({ revision: 1, limits: { productive: 4, perHost: 2, control: 2, queue: 100 }, defaults: { productive: 4, perHost: 2, control: 2, queue: 100 }, hosts: { [hostile]: { cpus: 64, memoryMb: 262_144 } }, running: { productive: 1, control: 0, perHost: { [hostile]: 1 } }, waiting: 0 }) }, swarm: s.swarm },
    }, options);
    const shown = (await view.ask(s.owner, { kind: "capacity" }))!.lines;
    const host = shown.filter((l) => l.text.startsWith(`Host "`));
    assert.equal(host.length, 1, `one line for the one host: ${JSON.stringify(host.map((l) => l.text))}`);
    const line = host[0]!.text;
    assert.ok(!/[\n\r\u2028\u2029]/.test(line), "the line cannot be broken");
    assert.ok(!line.includes("\u202e"), "the bidirectional override reaches the line only as its escape");
    assert.equal(line, 'Host "host:ev\\"il \\u202e [cut:": 64 CPU(s), 262144 MB declared (you declared it); 1 productive attempt(s) running on it.');
    assert.ok(shown.every((l) => !/[\n\r]/.test(l.text)), "every line of the answer is one line");
  });

  suite("a damaged record or a missing service is one line, and the other groups are still shown", async (w, s, script) => {
    script[QUESTION] = [ask({ kind: "capacity" }, QUESTION)];
    await s.quotas.changeQuotas(s.owner, { commandId: cid("quota"), set: { productive: 7 } });
    await s.swarm.change(s.owner, { commandId: cid("sw"), set: { depth: 2 } });
    await damage(s.storage, s.epoch, CAPS_REF, { perProject: { enabled: true, value: "many" } }, "caps");
    await damage(s.storage, s.epoch, SWARM_LIMITS_REF, { depth: "deep" }, "swarm");
    // The damaged caps record throws `integrity`, and the damaged swarm record says which names it cannot read: both are one line each.
    const broken = (await s.status.ask(s.owner, { kind: "capacity" }))!;
    const body = text(broken.lines);
    assert.match(body, /^Capacity caps: the caps record you stored is damaged - nothing new is admitted, not an inquiry, not a review, not productive work - until it is repaired with capacity\.limits\.change; what is already running is not stopped\.$/m, "a damaged caps record stops admission, and the line says that rather than sounding harmless");
    assert.match(body, /^The stored swarm limits are damaged at depth: no child task can be spawned until it is repaired \(swarm\.limits\.change\)\.$/m, "a damaged swarm record spawns nothing, and the line says that");
    assert.match(body, /^depth \(.*\): damaged: the figure stored cannot be read$/m, "the name that cannot be read is called damaged, not the default");
    assert.ok(!/^depth \(.*\): 3 \(the default\)$/m.test(body), "a damaged name is never shown as the default figure");
    assert.match(body, /^liveChildren \(.*\): 4 \(the default\) - not in force while the record is damaged$/m, "the sound names are marked as not in force, because spawning reads the whole record");
    await assert.rejects(() => s.swarm.effective(), (error: unknown) => error instanceof DomainError && error.code === "integrity", "the call SwarmService makes for every child task throws, so no child can be spawned");
    assert.match(body, /^productive \(.*\): 7 \(you set it\); 0 running now$/m, "the quotas group is untouched");
    assert.match(body, /^Host and global quotas/m, "and its header is there");
    // A group whose service is not composed in says so in one line, and the rest of the answer stands.
    const partial = StatusService.withEpoch(s.storage, s.epoch, {
      assignments: w.assignments,
      waits: WaitService.withEpoch(s.storage, s.epoch, w.assignments, options),
      blockers: BlockerService.withEpoch(s.storage, s.epoch, options),
      contracts: w.contracts,
      capacity: { quotas: { quotas: (by) => s.quotas.quotas(by) }, swarm: s.swarm },
    }, options);
    const fewer = (await partial.ask(s.owner, { kind: "capacity" }))!;
    assert.match(text(fewer.lines), /^Capacity caps: this controller does not offer them\.$/m);
    assert.match(text(fewer.lines), /^Host and global quotas/m);
    assert.match(text(fewer.lines), /^Limits on spawning child tasks/m);
    // With no capacity services at all the view is not offered, exactly like the other owner-only views.
    const none = StatusService.withEpoch(s.storage, s.epoch, {
      assignments: w.assignments,
      waits: WaitService.withEpoch(s.storage, s.epoch, w.assignments, options),
      blockers: BlockerService.withEpoch(s.storage, s.epoch, options),
      contracts: w.contracts,
    }, options);
    assert.equal(await none.ask(s.owner, { kind: "capacity" }), undefined);
  });
}
