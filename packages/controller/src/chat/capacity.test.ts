import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CAPS_REF, CapacityLimitsService } from "../admission/caps.js";
import { AdmissionService } from "../admission/service.js";
import { SWARM_LIMITS_REF, SwarmLimitsService } from "../swarm/limits.js";
import { OPERATIONS } from "../api/index.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";
import { StatusService, STATUS_KINDS, type StatusDeps } from "../status/index.js";
import { ModelInterpreter } from "./model-interpreter.js";
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

test("the chat is told there is a capacity view: the interpreter's list of status kinds names it, and so does the state API's status.ask (cards H10, H10b)", async () => {
  const kind = STATUS_KINDS["capacity"];
  assert.ok(kind !== undefined, "capacity is one of the status kinds");
  assert.deepEqual([...kind.keys], [], "and it asks for nothing beyond the kind");
  assert.match(kind.about, /capacity settings in force/);
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "what are my capacity limits?", quoted: [], focus: {}, proposals: [] });
  assert.ok(system.includes(`capacity(${kind.keys.join(", ")}) - ${kind.about}`), "the model is told the kind, the arguments it takes and what it shows");
  assert.ok(OPERATIONS.find((o) => o.name === "status.ask")!.summary.includes("`capacity`"), "status.ask describes the same kind, so the two lists cannot drift apart");
});

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
    assert.ok(shown.some((l) => /^Host and global quotas \(the admission record is at revision 0, which every request and release also raises\);/.test(l.text)), "the quotas group is there, and says whose revision it shows");
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

  suite("the quotas header names the record whose revision it shows, and that number rises with every request and release", async (w, s) => {
    await w.principals.enroll(w.owner, { commandId: cid("h"), kind: "host", name: "pc", grants: [] });
    const before = (await s.status.ask(s.owner, { kind: "capacity" }))!.lines;
    const header = before.find((l) => l.text.startsWith("Host and global quotas ("))?.text ?? "";
    assert.equal(header, 'Host and global quotas (the admission record is at revision 0, which every request and release also raises); the ones marked "you set it" are yours, the others are the installation\'s defaults:', "it is the admission record's revision, not the version of a setting");
    // A request changes nothing the owner set, and still raises the number - which is the whole reason it must not read as the revision of the quotas.
    const made = await s.quotas.request({ commandId: cid("rev"), actor: "host:pc", class: "inquiry", cpus: 1, memoryMb: 512 });
    const asked = (await s.status.ask(s.owner, { kind: "capacity" }))!.lines;
    assert.ok(asked.some((l) => /^Host and global quotas \(the admission record is at revision 1, which every request and release also raises\);/.test(l.text)), `one request later the record stands at revision 1: ${text(asked)}`);
    assert.ok(asked.every((l) => l.cites.every((c) => c.kind !== "admission-state" || c.revision === undefined || c.revision === 1)), "and the cites carry the same number");
    assert.match(text(asked), /^productive \(.*\): 4 \(the default\); 0 running now$/m, "every quota the owner set is still the installation's own");
    assert.match(text(asked), /^control \(.*\): 2 \(the default\); 1 of them in use now$/m, "what the record says is running is what moved");
    await s.quotas.release({ commandId: cid("rel"), actor: "host:pc", requestId: made.id, reason: "it finished" });
    assert.ok((await s.status.ask(s.owner, { kind: "capacity" }))!.lines.some((l) => /^Host and global quotas \(the admission record is at revision 2,/.test(l.text)), "and a release raises it again: releasing what ran changes the same record");
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

  suite("a damaged admission record costs the quotas group alone: the view still answers, and never shows a figure it cannot stand behind", async (w, s) => {
    const ADM = { kind: "admission-state", id: "admission" };
    // Hosts that is not a record of declared capacity: this used to throw the whole answer away (a TypeError out of `Object.entries(q.hosts)`).
    await damage(s.storage, s.epoch, ADM, { limits: { productive: 4, perHost: 2, control: 2, queue: 100 }, capacity: null }, "adm-hosts");
    const shown = (await s.status.ask(s.owner, { kind: "capacity" }))!.lines;
    const body = text(shown);
    assert.match(body, /^Host and global quotas: the stored admission record is damaged \(the declared hosts are not a record of CPUs and memory\): nothing in this group is shown, and what admission admits from it is not what these figures would allow \(it needs repair; capacity\.quotas\.change cannot mend every damaged shape\)\.$/m);
    assert.match(body, /^Capacity caps \(your setting is at revision 0\)/m, "the caps group is still read");
    assert.match(body, /^Limits on spawning child tasks \(your setting is at revision 0\):$/m, "and so the swarm group");
    assert.ok(shown.every((l) => l.cites.length > 0), "every line still cites a record");
    // A figure that is not a figure: a record whose `queue` is missing reads back as `undefined`, which used to be shown as one of the owner's own figures.
    await damage(s.storage, s.epoch, ADM, { limits: { productive: 4, perHost: 2, control: 2 }, capacity: {} }, "adm-queue");
    const missing = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.match(missing, /^Host and global quotas: the stored admission record is damaged \(queue is not a figure the controller can work from\): nothing in this group is shown, and what admission admits from it is not what these figures would allow \(it needs repair; capacity\.quotas\.change cannot mend every damaged shape\)\.$/m);
    assert.ok(!missing.includes("undefined"), `no figure is shown as undefined: ${missing}`);
    assert.ok(!missing.split("\n").some((l) => l.startsWith("queue ")), "the queue line is not shown at all");
    // One declared host whose CPUs and memory are not figures.
    await damage(s.storage, s.epoch, ADM, { limits: { productive: 4, perHost: 2, control: 2, queue: 100 }, capacity: { "host:pc": "eight" } }, "adm-host");
    const host = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.match(host, /^Host and global quotas: the stored admission record is damaged \("host:pc" does not declare CPUs and memory as figures\): nothing in this group is shown/m);
    assert.ok(!host.split("\n").some((l) => l.startsWith('Host "host:pc"')), "no host line is shown with figures that are not figures");
    // A record the service itself cannot read (what runs now is not a list): the group is one line, and the answer still stands.
    await damage(s.storage, s.epoch, ADM, { limits: { productive: 4, perHost: 2, control: 2, queue: 100 }, capacity: {}, running: null }, "adm-running");
    const unreadable = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.match(unreadable, /^Host and global quotas: the stored admission record is damaged \(it cannot be read as figures\): nothing in this group is shown/m);
    assert.match(unreadable, /^Capacity caps \(your setting is at revision 0\)/m, "the other two groups are still read");
    assert.match(unreadable, /^Limits on spawning child tasks \(your setting is at revision 0\):$/m);
    // The same record made sound again (written whole, because a record this broken is not what `capacity.quotas.change` reads to change): the group comes back with no damaged note left behind.
    await damage(s.storage, s.epoch, ADM, { limits: { productive: 6, perHost: 2, control: 2, queue: 100, depth: 3, children: 4, patience: 5 }, capacity: { "host:pc": { cpus: 8, memoryMb: 16_384 } }, running: [], queue: [], withdrawn: [] }, "adm-fixed");
    const fixed = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.ok(!fixed.includes("damaged"), "nothing is called damaged once the record reads");
    assert.match(fixed, /^productive \(.*\): 6 \(you set it\); 0 running now$/m);
    assert.match(fixed, /^Host "host:pc": 8 CPU\(s\), 16384 MB declared \(you declared it\); 0 productive attempt\(s\) running on it\.$/m);
  });

  suite("the damaged quotas line promises no repair the owner's own command cannot make, and keeps the one it can", async (w, s) => {
    const ADM = { kind: "admission-state", id: "admission" };
    // `changeQuotas` merges the owner's `set` into the stored limits and checks the whole record (`checkLimits`), so it needs `depth`, `children` and `patience` - figures no quota command can set - to be
    // there. Whether the line can point at the command therefore depends on the shape, which is why it no longer promises the command can do it. Both halves are proved here, through the command itself.
    const record = (limits: unknown): Record<string, unknown> => ({ limits, capacity: { "host:pc": { cpus: 8, memoryMb: 16_384 } }, running: [], queue: [], withdrawn: [] });
    // (a) limits that are not a record at all: `quotas()` cannot even read them, and no `set` can mend them, because the figures the command cannot set are missing with them.
    await damage(s.storage, s.epoch, ADM, record(null), "mend-null");
    const body = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.match(body, /^Host and global quotas: the stored admission record is damaged \(it cannot be read as figures\): nothing in this group is shown, and what admission admits from it is not what these figures would allow \(it needs repair; capacity\.quotas\.change cannot mend every damaged shape\)\.$/m, "the line calls for repair without promising the command can make it");
    assert.ok(!/\(repair it with capacity\.quotas\.change\)/.test(body), `the old promise is gone: ${body}`);
    await assert.rejects(
      () => s.quotas.changeQuotas(s.owner, { commandId: cid("mend-null"), set: { productive: 4, perHost: 2, control: 2, queue: 100 } }),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_command" && error.message === "limits.depth: must be a whole number from 0 to 8",
      "setting all four quotas at once still fails: the record is checked whole, and its spawn figures are not there to be read",
    );
    // (b) a record that only lacks `queue`, the other six figures being present: the same command does mend this one, and the group comes back.
    await damage(s.storage, s.epoch, ADM, record({ productive: 4, perHost: 2, control: 2, depth: 3, children: 4, patience: 5 }), "mend-queue");
    assert.match(text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines), /^Host and global quotas: the stored admission record is damaged \(queue is not a figure the controller can work from\)/m, "and it is damaged until it is set");
    await s.quotas.changeQuotas(s.owner, { commandId: cid("mend-queue"), set: { queue: 100 } });
    const mended = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.ok(!mended.includes("damaged"), `the shape the command can mend is mended: ${mended}`);
    assert.match(mended, /^queue \(.*\): 100 \(the default\); 0 waiting now$/m, "and the queue reads again");
  });

  suite("a stored quota figure outside the bound the service enforces is damaged, not a figure the owner set", async (w, s) => {
    const ADM = { kind: "admission-state", id: "admission" };
    // `quotaProblem` used to take any finite number as the owner's own figure, so every one of these printed as `(you set it)`. None of them can be stored by `capacity.quotas.change` - asserted for each
    // below, through the command itself - so a record holding one came from somewhere else, and the bounds the command enforces (`LIMIT_BOUNDS`, the same table `checkLimits` reads) are the only ones worth showing.
    const outOfBounds: readonly (readonly [string, number, string])[] = [
      ["productive", -1, "1 to 64"], ["productive", 0, "1 to 64"], ["productive", 1.5, "1 to 64"], ["productive", 65, "1 to 64"],
      ["perHost", 0, "1 to 16"], ["perHost", 17, "1 to 16"], ["control", 0, "1 to 16"], ["control", 17, "1 to 16"],
      ["queue", 0, "1 to 500"], ["queue", 501, "1 to 500"],
    ];
    for (const [name, value, bound] of outOfBounds) {
      const limits: Record<string, unknown> = { productive: 4, perHost: 2, control: 2, queue: 100, depth: 3, children: 4, patience: 5 };
      limits[name] = value;
      await damage(s.storage, s.epoch, ADM, { limits, capacity: {}, running: [], queue: [], withdrawn: [] }, `bound-${name}-${String(value)}`);
      const body = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
      assert.ok(
        body.includes(`Host and global quotas: the stored admission record is damaged (${name} is not a whole number from ${bound}): nothing in this group is shown, and what admission admits from it is not what these figures would allow (it needs repair; capacity.quotas.change cannot mend every damaged shape).`),
        `${name}: ${String(value)} is outside the bound the command enforces, so the group is refused with that said: ${body}`,
      );
      assert.ok(!body.split("\n").some((l) => l.startsWith(`${name} (`)), `the out-of-range figure is never printed as the owner's: ${body}`);
      assert.ok(!body.includes("(you set it)"), `nothing in the group is marked as set: ${body}`);
      await assert.rejects(
        () => s.quotas.changeQuotas(s.owner, { commandId: cid(`bound-${name}-${String(value)}`), set: { [name]: value } }),
        (error: unknown) => error instanceof DomainError && error.code === "invalid_command" && error.message === `set.${name}: must be a whole number from ${bound}`,
        `no command could have stored ${name}: ${String(value)}`,
      );
    }
    // A stored `queue` of text is the same fault in another shape: it used to print the group with `3 waiting now` beside a bound nobody could read.
    await damage(s.storage, s.epoch, ADM, { limits: { productive: 4, perHost: 2, control: 2, queue: "abc", depth: 3, children: 4, patience: 5 }, capacity: {}, running: [], queue: [], withdrawn: [] }, "bound-queue-text");
    const words = text((await s.status.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.ok(words.includes("the stored admission record is damaged (queue is not a figure the controller can work from)"), `text where a bound belongs: ${words}`);
    assert.ok(!/^queue \(/m.test(words), `and no queue line is shown beside it: ${words}`);
    await assert.rejects(
      () => s.quotas.changeQuotas(s.owner, { commandId: cid("bound-queue-text"), set: { queue: "abc" } }),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_command" && error.message === "set.queue: must be a whole number from 1 to 500",
      "no command could have stored queue: \"abc\" either",
    );
  });

  suite("a stored figure outside the bound is not inert either: admission works from it, which is why the group is refused whole", async (w, s) => {
    const ADM = { kind: "admission-state", id: "admission" };
    await w.principals.enroll(w.owner, { commandId: cid("h"), kind: "host", name: "pc", grants: [] });
    const record = (over: Record<string, unknown>): Record<string, unknown> => ({ limits: { productive: 4, perHost: 2, control: 2, queue: 100, depth: 3, children: 4, patience: 5, ...over }, capacity: { "host:pc": { cpus: 8, memoryMb: 16_384 } }, running: [], queue: [], withdrawn: [] });
    // `productive: 0` - what is already running is untouched and inquiries still run, but productive work is queued and never starts: a place under a total of nought can never free up.
    await damage(s.storage, s.epoch, ADM, record({ productive: 0, perHost: 1 }), "inert-prod");
    assert.equal((await s.quotas.request({ commandId: cid("prod-0"), actor: "host:pc", class: "productive", host: "host:pc", cpus: 1, memoryMb: 512 })).state, "waiting", "the stored total of nought admits no productive work");
    assert.equal((await s.quotas.request({ commandId: cid("ask-0"), actor: "host:pc", class: "inquiry", cpus: 1, memoryMb: 512 })).state, "running", "the control lane is a different figure, and it is untouched");
    // `queue: 0` - the two reserved control places fill up, and after them a request that cannot start at once is refused outright instead of waiting.
    await damage(s.storage, s.epoch, ADM, record({ queue: 0 }), "inert-queue");
    for (const i of [1, 2]) await s.quotas.request({ commandId: cid(`fill-${i}`), actor: "host:pc", class: "inquiry", cpus: 1, memoryMb: 512 });
    await assert.rejects(
      () => s.quotas.request({ commandId: cid("third"), actor: "host:pc", class: "inquiry", cpus: 1, memoryMb: 512 }),
      (error: unknown) => error instanceof DomainError && error.code === "unavailable" && error.message === "the queue is full (0 waiting); try again later",
      "a stored queue of nought refuses everything that has to wait, where the sound record let it wait",
    );
  });

  suite("a record with more declared hosts than the view lists shows the first ones in order and counts the rest, inside the lines the chat shows", async (w, s) => {
    // More hosts than the owner's own command could ever store: `capacity.quotas.change` takes at most 50 hosts in one change (probed) and refuses a record that would hold more than 200, so a record this
    // large can only arrive by another route and is written whole here. What is under test is the view's own bound and its order, not the command's.
    const hosts: Record<string, unknown> = {};
    for (let i = 499; i >= 0; i--) hosts[`host:h${String(i).padStart(3, "0")}`] = { cpus: 8, memoryMb: 16_384 }; // declared newest first, so a view that kept the record's order would show host:h499 first
    await damage(s.storage, s.epoch, { kind: "admission-state", id: "admission" }, { limits: { productive: 4, perHost: 2, control: 2, queue: 100 }, capacity: hosts }, "many-hosts");
    const shown = (await s.status.ask(s.owner, { kind: "capacity" }))!.lines;
    const hostLines = shown.filter((l) => l.text.startsWith('Host "')).map((l) => l.text);
    assert.equal(hostLines.length, 10, `ten of the five hundred declared hosts are listed, not ${hostLines.length}`);
    assert.match(hostLines[0]!, /^Host "host:h000": 8 CPU\(s\), 16384 MB declared \(you declared it\); 0 productive attempt\(s\) running on it\.$/, "the list starts at the first host in order, not the first in the record");
    assert.match(hostLines[9]!, /^Host "host:h009"/, "and stops after the tenth");
    assert.ok(!hostLines.some((l) => l.includes("host:h010")), "the eleventh host is not listed");
    const ids = hostLines.map((l) => l.slice(6, l.indexOf('", ')));
    assert.deepEqual(ids, [...ids].sort(), "the hosts shown are in host-ID order");
    assert.match(text(shown), /^490 more host\(s\) are declared than are shown\.$/m, "the rest are counted, not dropped in silence");
    assert.ok(shown.filter((l) => l.text.startsWith('Host "') || l.text.includes("more host(s)")).every((l) => l.cites.some((c) => c.kind === "admission-state")), "every host line and the count cite the record they read");
    // ASSUMPTION: the answer is bounded by its own shape (one line per group and per damaged group, three caps, four quotas, three spawn limits, ten host lines and one counting line), so the view needs no
    // line-count branch of its own - the removed `CAPACITY_LINES` cut was unreachable, and the chat cuts a status answer to thirty lines and counts the rest whatever the view writes. This is the guard for that.
    assert.ok(shown.length <= 30, `the answer is ${shown.length} lines, and the chat shows thirty`);
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

  suite("a host named like a member of Object.prototype counts what the record says runs on it, not what the prototype holds", async (w, s) => {
    const ADM = { kind: "admission-state", id: "admission" };
    // `running.perHost` is a plain object the service builds from what runs. A host declared as `constructor` or `toString` reached `Object.prototype` through a plain lookup, and the view printed the
    // function it found there as the running count. Only a record from outside the owner's own command can name a host like that (both `capacity.quotas.change` and `setCapacity` check `host:...` first), which is why it is written whole here.
    for (const id of ["constructor", "toString"]) {
      await damage(s.storage, s.epoch, ADM, { limits: { productive: 4, perHost: 2, control: 2, queue: 100, depth: 3, children: 4, patience: 5 }, capacity: { [id]: { cpus: 8, memoryMb: 1024 } }, running: [], queue: [], withdrawn: [] }, `proto-${id}`);
      const shown = (await s.status.ask(s.owner, { kind: "capacity" }))!.lines;
      const host = text(shown).split("\n").filter((l) => l.startsWith('Host "'));
      assert.equal(host.length, 1, `one line for the one declared host: ${text(shown)}`);
      assert.equal(host[0], `Host "${id}": 8 CPU(s), 1024 MB declared (you declared it); 0 productive attempt(s) running on it.`, "nought, because the record says nothing runs on it");
      assert.ok(!/function|Object|native code|\[native/.test(host[0]!), `no prototype member is printed as a count: ${host[0]}`);
    }
    // A count that is not a figure is damaged too, and says so. The service builds the counts itself, so this shape reaches the view only through the `quotas` port.
    const view = StatusService.withEpoch(s.storage, s.epoch, {
      assignments: w.assignments,
      waits: WaitService.withEpoch(s.storage, s.epoch, w.assignments, options),
      blockers: BlockerService.withEpoch(s.storage, s.epoch, options),
      contracts: w.contracts,
      capacity: { limits: s.limits, quotas: { quotas: async () => ({ revision: 1, limits: { productive: 4, perHost: 2, control: 2, queue: 100 }, defaults: { productive: 4, perHost: 2, control: 2, queue: 100 }, hosts: { "host:pc": { cpus: 8, memoryMb: 1024 } }, running: { productive: 1, control: 0, perHost: { "host:pc": "three" } as unknown as Record<string, number> }, waiting: 0 }) }, swarm: s.swarm },
    }, options);
    const counted = text((await view.ask(s.owner, { kind: "capacity" }))!.lines);
    assert.ok(counted.includes('Host and global quotas: the stored admission record is damaged ("host:pc" does not count what runs on it as a figure)'), `a count that is not a figure is damaged: ${counted}`);
    assert.ok(!counted.includes('Host "host:pc"'), `no host line is shown with a count that is not a figure: ${counted}`);
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
