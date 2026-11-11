import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { NotificationService, UrgentWatch, type ChannelAdapter, type HostSource, type UrgentWatchOptions } from "./index.js";

interface Backup { newest?: string; unreadable?: boolean; lastError?: { at: string; message: string } }
type Host = { hostId: string; identity: "active" | "revoked"; freshness: "fresh" | "stale" | "unknown"; lastSeenAt?: string };
type Hosts = HostSource & { items: Host[] };
const down = (id: string, minutesAgo = 20): Host => ({ hostId: `host:${id}`, identity: "active", freshness: "stale", lastSeenAt: new Date(now - minutesAgo * 60_000).toISOString() });
const up = (id: string): Host => ({ hostId: `host:${id}`, identity: "active", freshness: "fresh", lastSeenAt: new Date(now).toISOString() });

after(stopServer);

let now = Date.parse("2026-10-31T12:00:00.000Z");
const iso = (): string => new Date(now).toISOString();
const HOUR = 3_600_000;
const MIN = 60_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    svc: NotificationService; owner: Principal; sent: { text: string }[]; backup: Backup; hosts: Hosts;
    watch: UrgentWatch; restart(extra?: Partial<UrgentWatchOptions>): UrgentWatch; flush(): Promise<unknown>; set(change: Record<string, unknown>): Promise<void>; open(): Promise<{ id: string; level: string; state: string; urgent: boolean; immediate: boolean; label: string; detail?: string; count: number; ref: { kind: string } }[]>;
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
        const backup: Backup = { newest: iso() };
        const hosts: Hosts = { items: [], list: async (_by, page) => {
          const at = page.afterId === undefined ? 0 : hosts.items.findIndex((h) => h.hostId === page.afterId) + 1;
          const limit = page.limit ?? 100; const items = hosts.items.slice(at, at + limit);
          return { items, ...(at + limit < hosts.items.length ? { next: items[items.length - 1]!.hostId } : {}) };
        } };
        const make = (extra: Partial<UrgentWatchOptions> = {}): UrgentWatch => new UrgentWatch({ notifications: svc, backups: { lastGood: async () => ({ ...(backup.newest === undefined ? {} : { at: backup.newest }), ...(backup.unreadable === true ? { unreadable: true } : {}), ...(backup.lastError === undefined ? {} : { lastError: backup.lastError }) }) }, hosts, clock: iso, ...extra });
        const watch = make();
        const set = async (change: Record<string, unknown>): Promise<void> => { await svc.configure(owner, { commandId: cid("cfg"), expectedRevision: (await svc.settings(owner)).revision, ...change } as never); };
        await set({ channel: "external", channelName: "pager" });
        await body({ flush: () => svc.runDue(), restart: make, svc, owner, sent, backup, hosts, watch, set, open: async () => (await svc.inbox(owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled") as never });
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
    // Turning the trigger off closes its open item (and an old backup raises nothing while it is off); turning it on again raises it again.
    await c.set({ backupMaxAgeHours: null }); await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 0, "off: the open item is closed");
    c.backup.newest = new Date(now - 100 * HOUR).toISOString(); await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 0, "off: an old backup raises nothing");
    await c.set({ backupMaxAgeHours: 24 }); await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 1, "on again");
    await c.set({ hostDownAfterMinutes: null });
    c.hosts.items.push(down("box", 180));
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
    // A second outage is a new item, told again (after the minimum gap since the last message about the host).
    now += 31 * MIN; c.hosts.items[0] = host("host:five", 0, { freshness: "fresh" });
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

  const drain = async (c: { flush(): Promise<unknown> }, times = 5): Promise<void> => { for (let i = 0; i < times; i++) await c.flush(); };
  const hostItems = async (c: { open(): Promise<{ ref: { kind: string }; state: string; label: string; urgent: boolean }[]> }) => (await c.open()).filter((i) => i.ref.kind === "host-record");

  suite("a host that goes down and comes back 60 times is told every time: the 50 records of one event are used again once closed, so a trigger is never muted for good (card U11c review)", async (c) => {
    await c.set({ urgentMinGapMinutes: null, escalationsPerHour: null });
    for (let i = 0; i < 60; i++) {
      c.hosts.items = [down("flap")]; await c.watch.sweep(c.owner); await drain(c, 2);
      assert.equal(c.sent.length, i + 1, `cycle ${i}`);
      c.hosts.items = [up("flap")]; await c.watch.sweep(c.owner);
      assert.equal((await hostItems(c)).length, 0, `cycle ${i} closed`);
      now += MIN;
    }
  });

  suite("one host whose item cannot be raised does not hide the hosts after it, and the failure is still reported (card U11c review)", async (c) => {
    const real = c.svc;
    const failing = new Proxy(real, { get: (t, k) => { const v = Reflect.get(t, k, t); if (k === "emitFromController") return async (cmd: { ref: { id: string } }) => { if (cmd.ref.id === "bad") throw new Error("storage hiccup"); return (v as (x: unknown) => Promise<unknown>).call(t, cmd); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } });
    const watch = c.restart({ notifications: failing });
    c.hosts.items = [down("bad"), down("good")];
    await assert.rejects(() => watch.sweep(c.owner), /storage hiccup/);
    assert.deepEqual((await hostItems(c)).map((i) => i.label.includes("good")), [true]);
  });

  suite("a controller that restarts more often than the backup limit still alerts about a backup that was never made, and a restart does not close a live 'no good backup' item (card U11c review)", async (c) => {
    delete c.backup.newest;
    await c.watch.sweep(c.owner); // first seen now
    now += 30 * HOUR; await c.restart().sweep(c.owner);
    assert.equal((await c.open()).length, 0, "30 hours: inside the limit");
    now += 20 * HOUR; await c.restart().sweep(c.owner);
    const items = await c.open();
    assert.equal(items.length, 1, "50 hours since it was first seen, over three restarts");
    assert.match(items[0]!.label, /no good backup for 50 hours/);
    c.backup.unreadable = true; await c.restart().sweep(c.owner);
    assert.equal((await c.open()).length, 1, "an unreadable folder closes nothing");
    c.backup.unreadable = false; await c.restart().sweep(c.owner);
    assert.equal((await c.open()).length, 1, "a restart with still no backup does not close it");
    c.backup.newest = iso(); await c.restart().sweep(c.owner);
    assert.equal((await c.open()).length, 0, "a good backup closes it");
    delete c.backup.newest; now += 100 * HOUR; await c.restart().sweep(c.owner);
    assert.equal((await c.open()).length, 0, "the clock for 'never' started over after a backup existed: 100 hours on, the first look only notes the time");
  });

  suite("a backup time in the future or unreadable is no backup; a failing backup run is shown in the label (card U11c review)", async (c) => {
    c.backup.newest = new Date(now + 100 * HOUR).toISOString();
    await c.watch.sweep(c.owner);
    now += 49 * HOUR; await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 1, "a time in the future does not count as a backup");
    c.backup.newest = "not a date"; c.backup.lastError = { at: iso(), message: "disk full" };
    await c.watch.sweep(c.owner);
    assert.equal((await c.open()).length, 1);
    c.backup.newest = new Date(now - 60 * HOUR).toISOString();
    await c.watch.sweep(c.owner); // a real, old backup: the same item stays
    assert.equal((await c.open()).length, 1);
    c.backup.newest = new Date(now - 90 * HOUR).toISOString();
    await c.svc.settleFromController({ commandId: cid("s"), kind: "maintenance", ref: { kind: "backup", id: "installation" } });
    await c.watch.sweep(c.owner);
    const again = await c.open();
    assert.equal(again.length, 1);
    assert.match(again[0]!.label, /no good backup for 90 hours \(the last backup run failed\)/);
    assert.match(again[0]!.detail ?? "", /disk full/);
  });

  suite("100 hosts down at once send at most the hour's Urgent limit and one 'N more' summary; every host is still an Urgent item in the inbox, and the limit can be turned off (card U11c review)", async (c) => {
    c.hosts.items = Array.from({ length: 100 }, (_, i) => down(`h${i}`));
    await c.watch.sweep(c.owner); await drain(c);
    assert.equal((await hostItems(c)).length, 100);
    assert.ok((await hostItems(c)).every((i) => i.urgent));
    assert.equal(c.sent.length, 11, c.sent.map((m) => m.text).slice(9).join(" | "));
    assert.equal(c.sent.filter((m) => /90 more Urgent items/.test(m.text)).length, 1, "one summary naming the rest");
    await drain(c);
    assert.equal(c.sent.length, 11, "nothing more");
    now += 2 * HOUR; c.hosts.items = []; await c.watch.sweep(c.owner); c.hosts.items = Array.from({ length: 100 }, (_, i) => down(`h${i}`, 200));
    await c.set({ escalationsPerHour: null }); const before = c.sent.length;
    await c.watch.sweep(c.owner); await drain(c, 40);
    assert.equal(c.sent.length - before, 100, "with the limit off every host is told");
  });

  suite("the same record is not told again inside the minimum gap, the gap is the owner's and may be turned off, and a held item stays in the inbox as Urgent (card U11c review)", async (c) => {
    c.hosts.items = [down("a")]; await c.watch.sweep(c.owner); await drain(c, 2);
    assert.equal(c.sent.length, 1);
    c.hosts.items = [up("a")]; await c.watch.sweep(c.owner); now += 5 * MIN;
    c.hosts.items = [down("a")]; await c.watch.sweep(c.owner); await drain(c, 2);
    assert.equal(c.sent.length, 1, "5 minutes after the last message: held");
    const held = await hostItems(c);
    assert.equal(held.length, 1); assert.ok(held[0]!.urgent, "still Urgent in the inbox");
    c.hosts.items = [up("a")]; await c.watch.sweep(c.owner); now += 30 * MIN;
    c.hosts.items = [down("a")]; await c.watch.sweep(c.owner); await drain(c, 2);
    assert.equal(c.sent.length, 2, "past the gap");
    c.hosts.items = [up("a")]; await c.watch.sweep(c.owner); now += MIN;
    await c.set({ urgentMinGapMinutes: null });
    c.hosts.items = [down("a")]; await c.watch.sweep(c.owner); await drain(c, 2);
    assert.equal(c.sent.length, 3, "gap off");
    await assert.rejects(() => c.set({ urgentMinGapMinutes: 0 }), (e) => e instanceof DomainError && e.code === "invalid_command");
  });

  suite("hosts are read page by page with a cursor, an item for a host that no longer exists is closed after a whole pass, and nothing is kept for it (card U11c review)", async (c) => {
    await c.set({ escalationsPerHour: null, urgentMinGapMinutes: null });
    c.hosts.items = Array.from({ length: 250 }, (_, i) => down(`h${String(i).padStart(3, "0")}`));
    await c.watch.sweep(c.owner); assert.equal((await hostItems(c)).length, 100);
    await c.watch.sweep(c.owner); assert.equal((await hostItems(c)).length, 200);
    await c.watch.sweep(c.owner); assert.equal((await hostItems(c)).length, 250, "the third page reaches the rest");
    c.hosts.items = c.hosts.items.filter((h) => h.hostId !== "host:h005" && h.hostId !== "host:h200");
    await c.watch.sweep(c.owner); await c.watch.sweep(c.owner);
    assert.equal((await hostItems(c)).length, 250, "mid-pass nothing is closed");
    await c.watch.sweep(c.owner);
    assert.equal((await hostItems(c)).length, 248, "the pass ended: the two gone hosts are closed");
  });

  suite("the sweep runs at most every sweepEverySeconds when the dispatcher calls it, and a hung read gives up so the other check still runs (card U11c review)", async (c) => {
    let lists = 0; const list = c.hosts.list;
    c.hosts.list = async (by, page) => { lists++; return list(by, page); };
    await c.watch.sweep(c.owner, { throttled: true }); assert.equal(lists, 1);
    now += 59_000; await c.watch.sweep(c.owner, { throttled: true }); assert.equal(lists, 1, "inside the interval");
    now += 2_000; await c.watch.sweep(c.owner, { throttled: true }); assert.equal(lists, 2);
    await c.set({ sweepEverySeconds: 300 });
    now += 61_000; await c.watch.sweep(c.owner, { throttled: true }); assert.equal(lists, 3, "the interval in force when the last one ran was 60 s");
    now += 61_000; await c.watch.sweep(c.owner, { throttled: true }); assert.equal(lists, 3, "now 300 s");
    await c.watch.sweep(c.owner); assert.equal(lists, 4, "unthrottled calls always run");
    c.hosts.list = () => new Promise(() => undefined);
    c.backup.newest = new Date(now - 100 * HOUR).toISOString();
    const hung = c.restart({ stepTimeoutMs: 20 });
    await assert.rejects(() => hung.sweep(c.owner), /listing the hosts took longer/);
    assert.equal((await c.open()).filter((i) => i.ref.kind === "backup").length, 1, "the backup check was not held up by the hung host list");
  });

  suite("a second burst of denials while the first item is still open is a new, told item; the rest of one burst only adds to the count; at most the owner's number of agents page in an hour (card U11c review)", async (c) => {
    await c.set({ deniedThreshold: 2, deniedWindowMinutes: 10, urgentMinGapMinutes: null });
    await c.watch.reportDenial("agent:ann"); await c.watch.reportDenial("agent:ann");
    await c.watch.reportDenial("agent:ann"); await c.watch.reportDenial("agent:ann");
    await drain(c, 2);
    assert.equal(c.sent.length, 1, "one page for one burst");
    let items = (await c.open()).filter((i) => i.ref.kind === "agent");
    assert.equal(items.length, 1); assert.match(items[0]!.label, /refused 4 times/);
    now += 11 * MIN;
    await c.watch.reportDenial("agent:ann"); await c.watch.reportDenial("agent:ann");
    await drain(c, 2);
    assert.equal(c.sent.length, 2, "the second burst is told");
    items = (await c.open()).filter((i) => i.ref.kind === "agent");
    assert.equal(items.length, 1, "the first item was closed, the second is the open one"); assert.match(items[0]!.label, /refused 2 times/);
    await c.set({ deniedAlertsPerHour: 3 });
    for (const a of ["b", "c", "d", "e", "f"]) { await c.watch.reportDenial(`agent:${a}`); await c.watch.reportDenial(`agent:${a}`); }
    await drain(c, 2);
    assert.equal(c.sent.length, 3, "ann twice and one more agent page; the rest wait in the inbox");
    assert.equal((await c.open()).filter((i) => i.ref.kind === "agent").length, 6, "all six agents are in the inbox");
  });

  suite("security events of the same kind with different keys are separate items, each told (card U11c review)", async (c) => {
    const a = await c.watch.reportSecurity({ kind: "credential-misused", key: "task-1" });
    const b = await c.watch.reportSecurity({ kind: "credential-misused", key: "task-2" });
    assert.notEqual(a.itemId, b.itemId);
    await drain(c, 2);
    assert.equal(c.sent.length, 2);
    assert.equal((await c.open()).filter((i) => i.ref.kind === "security").length, 2);
  });

  const as = (owner: Principal, kind: "host" | "service" | "agent", name: string): Principal => ({ ...owner, kind, id: `${kind}:${name}` }) as Principal;

  suite("a security event reported by a host or service is Urgent, told once, owned by its reporter, and refused from an agent (card U11c)", async (c) => {
    await c.set({ quietHours: { start: "00:00", end: "23:59" } });
    const w1 = as(c.owner, "host", "w1"); const w2 = as(c.owner, "service", "scanner");
    const a = await c.watch.reportSecurityFrom(w1, { kind: "sandbox-escape-attempt", key: "attempt-9" });
    const again = await c.watch.reportSecurityFrom(w1, { kind: "sandbox-escape-attempt", key: "attempt-9" });
    assert.equal(a.itemId, again.itemId, "the same event is told once");
    const other = await c.watch.reportSecurityFrom(w2, { kind: "sandbox-escape-attempt", key: "attempt-9" });
    assert.notEqual(a.itemId, other.itemId, "another reporter's event with the same key is its own");
    await drain(c, 2);
    assert.equal(c.sent.length, 2, "sent at once, also in quiet hours");
    assert.match(c.sent[0]!.text, /Urgent: A sandbox escape was attempted \(reported by w1\)/);
    assert.ok(!c.sent[0]!.text.includes("attempt-9"), "the key never leaves");
    await assert.rejects(() => c.watch.reportSecurityFrom(as(c.owner, "agent", "a1"), { kind: "integrity-check-failed", key: "k" }), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    await assert.rejects(() => c.watch.reportSecurityFrom(w1, { kind: "nope", key: "k" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.watch.reportSecurityFrom(w1, { kind: "integrity-check-failed", key: "" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.watch.reportSecurityFrom(w1, { kind: "integrity-check-failed", key: "x".repeat(201) }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  });

  suite("one reporter's burst of security reports is held in ONE item beyond the owner's hourly limit, and the limit is chat-settable and can be turned off (card U11c)", async (c) => {
    await c.set({ securityReportsPerHour: 3 });
    const w = as(c.owner, "host", "noisy");
    for (let i = 0; i < 3; i++) assert.equal((await c.watch.reportSecurityFrom(w, { kind: "protected-path-touched", key: `k${i}` })).held, false);
    for (let i = 3; i < 9; i++) assert.equal((await c.watch.reportSecurityFrom(w, { kind: "protected-path-touched", key: `k${i}` })).held, true);
    const items = (await c.open()).filter((i) => i.ref.kind === "security");
    assert.equal(items.length, 4, "three separate items and one collected item");
    assert.equal(items.filter((i) => i.level === "urgent").length, 3);
    await drain(c, 3);
    assert.equal(c.sent.length, 3, "the held reports are not paged");
    // The same event again costs no allowance and is not held.
    assert.equal((await c.watch.reportSecurityFrom(w, { kind: "protected-path-touched", key: "k0" })).held, false);
    // Another reporter has its own allowance.
    assert.equal((await c.watch.reportSecurityFrom(as(c.owner, "service", "calm"), { kind: "integrity-check-failed", key: "x" })).held, false);
    await c.set({ securityReportsPerHour: null });
    for (let i = 20; i < 40; i++) assert.equal((await c.watch.reportSecurityFrom(w, { kind: "protected-path-touched", key: `k${i}` })).held, false);
    await assert.rejects(() => c.set({ securityReportsPerHour: 0 }));
    now += 61 * MIN; await c.set({ securityReportsPerHour: 2 });
    assert.equal((await c.watch.reportSecurityFrom(w, { kind: "protected-path-touched", key: "later" })).held, false, "the hour has passed");
  });

  suite("a security report takes a key of the full 200 characters, refuses a kind that is not its own (toString), a project that is not a project ID, and a closed event reported again is told once, not refused (card U11c review)", async (c) => {
    const w = as(c.owner, "service", "a-service-name-of-forty-characters-long1");
    const long = "k".repeat(200);
    const first = await c.watch.reportSecurityFrom(w, { kind: "sandbox-escape-attempt", key: long, projectId: "proj-abcdefghijklmnopqrst" });
    assert.equal(first.held, false);
    for (const kind of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      await assert.rejects(() => c.watch.reportSecurityFrom(w, { kind, key: "k" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command", kind);
    }
    await assert.rejects(() => c.watch.reportSecurityFrom(w, { kind: "integrity-check-failed", key: "k", projectId: "see https://evil.example/" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    await drain(c, 1);
    assert.equal(c.sent.length, 1);
    assert.ok(!c.sent[0]!.text.includes("kkkk") && !c.sent[0]!.text.includes("proj-"), "neither the key nor the project leaves");
    // The owner closes it; the reporter sends the same event again (a retry): the first item, not an error and not a new page.
    const item = (await c.open()).find((i) => i.id === first.itemId)!;
    await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: first.itemId, answer: "ok", revision: (item as unknown as { revision: number }).revision });
    const again = await c.watch.reportSecurityFrom(w, { kind: "sandbox-escape-attempt", key: long, projectId: "proj-abcdefghijklmnopqrst" });
    assert.deepEqual(again, { itemId: first.itemId, held: false });
    assert.equal((await c.open()).filter((i) => i.ref.kind === "security").length, 0, "not raised again");
    await drain(c, 2);
    assert.equal(c.sent.length, 1, "not paged again");
    // The same key under another project is another event.
    const other = await c.watch.reportSecurityFrom(w, { kind: "sandbox-escape-attempt", key: long, projectId: "proj-bbbbbbbbbbbbbbbbbbbb" });
    assert.notEqual(other.itemId, first.itemId);
    // The controller's own event with a key that spells a reporter's identity is not that reporter's event.
    const own = await c.watch.reportSecurity({ kind: "integrity-check-failed", key: `${w.id}|-|x` });
    const theirs = await c.watch.reportSecurityFrom(w, { kind: "integrity-check-failed", key: "x" });
    assert.notEqual(own.itemId, theirs.itemId);
  });
}
