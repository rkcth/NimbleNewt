import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { NotificationService, UrgentWatch, type ChannelAdapter, type HostSource } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-31T12:00:00.000Z");
const iso = (): string => new Date(now).toISOString();
const HOUR = 3_600_000;
const MIN = 60_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    svc: NotificationService; owner: Principal; sent: { text: string }[]; backup: { newest?: string }; hosts: { items: { hostId: string; identity: "active" | "revoked"; freshness: "fresh" | "stale" | "unknown"; lastSeenAt?: string }[] };
    watch: UrgentWatch; flush(): Promise<unknown>; set(change: Record<string, unknown>): Promise<void>; open(): Promise<{ id: string; level: string; state: string; urgent: boolean; immediate: boolean; label: string; detail?: string; count: number; ref: { kind: string } }[]>;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-31T12:00:00.000Z");
      const world = await backend.open();
      try {
        const options = { clock: iso, pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = (await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token))!;
        const sent: { text: string }[] = [];
        const channel: ChannelAdapter = { send: async (m) => { sent.push({ text: m.text }); } };
        const svc = NotificationService.withEpoch(world.storage, projects.epoch, { ...options, channels: { pager: channel } });
        const backup: { newest?: string } = { newest: iso() };
        const hosts: HostSource & { items: { hostId: string; identity: "active" | "revoked"; freshness: "fresh" | "stale" | "unknown"; lastSeenAt?: string }[] } = { items: [], list: async () => ({ items: hosts.items }) };
        const watch = new UrgentWatch({ notifications: svc, backups: { status: async () => (backup.newest === undefined ? {} : { newest: { createdAt: backup.newest } }) }, hosts, clock: iso });
        const set = async (change: Record<string, unknown>): Promise<void> => { await svc.configure(owner, { commandId: cid("cfg"), expectedRevision: (await svc.settings(owner)).revision, ...change } as never); };
        await set({ channel: "external", channelName: "pager" });
        await body({ flush: () => svc.runDue(), svc, owner, sent, backup, hosts, watch, set, open: async () => (await svc.inbox(owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled") as never });
      } finally { await world.close(); }
    });

  suite("no good backup within 48 hours raises one Urgent item that is sent at once, also in quiet hours, and closes when a backup is made (card U11c)", async (c) => {
    await c.set({ quietHours: { start: "00:00", end: "23:59" } }); // the whole day is quiet
    await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 0, "a fresh backup raises nothing");
    now += 47 * HOUR; await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 0, "47 hours is inside the limit");
    now += 2 * HOUR; await c.watch.sweep(c.owner);
    const items = await c.open();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.level, "urgent");
    assert.equal(items[0]!.immediate, true);
    await c.flush();
    assert.equal(c.sent.length, 1, "sent at once although it is quiet hours");
    await c.flush();
    assert.match(c.sent[0]!.text, /Urgent: no good backup for 49 hours/);
    assert.ok(!c.sent[0]!.text.includes("limit"), "the detail stays in the inbox");
    await c.watch.sweep(c.owner); now += 5 * MIN; await c.watch.sweep(c.owner);
    await c.flush();
    assert.equal(c.sent.length, 1, "told once, not on every sweep");
    c.backup.newest = iso(); await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 0, "closed when a backup exists");
  });

  suite("the backup limit and the host limit are the owner's: a number moves them and null turns them off (card U11c)", async (c) => {
    now += 60 * HOUR;
    await c.set({ backupMaxAgeHours: 72 }); await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 0, "72 hours allowed");
    await c.set({ backupMaxAgeHours: 24 }); await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 1, "24 hours now");
    await c.set({ backupMaxAgeHours: null }); c.backup.newest = new Date(now - 100 * HOUR).toISOString();
    const quiet = await c.open(); assert.equal(quiet.length, 1);
    await c.set({ hostDownAfterMinutes: null });
    c.hosts.items.push({ hostId: "host:box", identity: "active", freshness: "stale", lastSeenAt: new Date(now - 3 * HOUR).toISOString() });
    await c.watch.sweep(c.owner);
    assert.equal((await c.open()).filter((i) => i.ref.kind === "host-record").length, 0, "host trigger off");
    await assert.rejects(() => c.set({ deniedThreshold: 1 }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.set({ backupMaxAgeHours: 0 }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.svc.configure({ ...c.owner, kind: "agent" } as never, { commandId: cid("x"), backupMaxAgeHours: 5 } as never), (e) => e instanceof DomainError && e.code === "forbidden");
  });

  suite("a host silent for the owner's number of minutes is Urgent; a revoked or never-heard host is not; hearing from it again closes the item (card U11c)", async (c) => {
    const host = (id: string, minutesAgo: number | undefined, over: Partial<{ identity: "active" | "revoked"; freshness: "fresh" | "stale" | "unknown" }> = {}) => ({ hostId: id, identity: "active" as const, freshness: "stale" as const, ...(minutesAgo === undefined ? {} : { lastSeenAt: new Date(now - minutesAgo * MIN).toISOString() }), ...over });
    c.hosts.items.push(host("host:five", 5), host("host:ten", 11), host("host:gone", 60, { identity: "revoked" }), host("host:new", undefined, { freshness: "unknown" }));
    await c.watch.sweep(c.owner);
    const items = (await c.open()).filter((i) => i.ref.kind === "host-record");
    assert.equal(items.length, 1, JSON.stringify(items));
    await c.flush();
    await c.flush();
    assert.match(c.sent.map((m) => m.text).join("|"), /host ten has been silent for 11 minutes/);
    c.hosts.items[1] = host("host:ten", 0, { freshness: "fresh" });
    await c.watch.sweep(c.owner);
    assert.equal((await c.open()).filter((i) => i.ref.kind === "host-record").length, 0, "closed");
    // A second outage is a new item, told again.
    c.hosts.items[1] = host("host:ten", 20); const before = c.sent.length;
    await c.watch.sweep(c.owner);
    await c.flush();
    assert.equal(c.sent.length, before + 1);
  });

  suite("repeated denials of one agent become Urgent only over the owner's threshold, inside the window, per agent (card U11c)", async (c) => {
    for (let i = 0; i < 5; i++) await c.watch.reportDenial("agent:ann");
    assert.equal((await c.open()).length, 0, "no threshold set: nothing is counted");
    await c.set({ deniedThreshold: 3, deniedWindowMinutes: 10 });
    assert.equal((await c.watch.reportDenial("agent:ann")).raised, false);
    assert.equal((await c.watch.reportDenial("agent:bob")).raised, false, "denials of another agent do not add up");
    assert.equal((await c.watch.reportDenial("agent:ann")).raised, false);
    now += 11 * MIN; // the first two leave the window
    assert.equal((await c.watch.reportDenial("agent:ann")).raised, false, "old denials expired");
    await c.watch.reportDenial("agent:ann");
    assert.equal((await c.open()).length, 0);
    assert.equal((await c.watch.reportDenial("agent:ann", undefined)).raised, true, "third inside the window");
    const items = await c.open();
    assert.equal(items.length, 1); assert.equal(items[0]!.level, "urgent");
    await c.flush();
    assert.equal(c.sent.length, 1);
    await c.flush();
    assert.match(c.sent[0]!.text, /agent ann was refused 3 times/);
    await c.watch.reportDenial("agent:ann");
    await c.flush();
    assert.equal(c.sent.length, 1, "later denials add to the count, no new message");
    await c.set({ deniedThreshold: null });
    assert.equal((await c.watch.reportDenial("agent:carl")).raised, false);
  });

  suite("a security event is always Urgent, once per key, and when the owner lets Urgent wait for the end of quiet hours it waits (card U11c)", async (c) => {
    await c.watch.reportSecurity({ kind: "protected-path-touched", key: "a1" });
    await c.watch.reportSecurity({ kind: "protected-path-touched", key: "a1" });
    await c.flush();
    assert.equal(c.sent.length, 1);
    await c.flush();
    assert.match(c.sent[0]!.text, /Urgent: A protected path/);
    await c.set({ quietHours: { start: "00:00", end: "23:59" }, urgentInterruptsQuietHours: false });
    await c.watch.reportSecurity({ kind: "integrity-check-failed", key: "b1" });
    await c.flush();
    assert.equal(c.sent.length, 1, "the owner chose that Urgent waits for the end of quiet hours");
    const open = await c.open();
    assert.equal(open.length, 2); assert.ok(open.every((i) => i.level === "urgent"));
    await assert.rejects(() => c.watch.reportSecurity({ kind: "nope" as never, key: "z" }));
  });

  suite("only the controller raises these: the owner-facing emit refuses interrupt and label (card U11c)", async (c) => {
    for (const extra of [{ interrupt: true }, { label: "hello" }]) {
      await assert.rejects(() => c.svc.emit({ ...c.owner, kind: "agent", id: "agent:x" } as never, { commandId: cid("e"), kind: "maintenance", ref: { kind: "thing", id: "t1" }, ...extra } as never), (e) => e instanceof DomainError);
    }
    await assert.rejects(() => c.svc.emitFromController({ commandId: cid("e"), kind: "maintenance", ref: { kind: "thing", id: "t1" }, interrupt: "yes" } as never), (e) => e instanceof DomainError && e.code === "invalid_command");
  });
}
