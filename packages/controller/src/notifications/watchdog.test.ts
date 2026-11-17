import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { PrincipalService } from "../security/index.js";
import { NotificationService } from "./notifications.js";
import { UrgentWatch } from "./urgent.js";
import { DownWatchdog, heartbeatProbe, httpProbe, readWatchdogRecord, watchdogSource, webhookTell, writeWatchdogRecord, type Probe } from "./watchdog.js";

// Card U11d: the watchdog outside the controller tells the owner on a loopback fake channel while the controller is down; the controller raises the outage once when it returns.
after(stopServer);

let t = Date.parse("2026-11-14T10:00:00.000Z");
const MIN = 60_000;
async function dir(): Promise<string> { return mkdtemp(join(tmpdir(), "nn-wd-")); }
async function fakeChannel(status = 200): Promise<{ url: string; got: string[]; server: Server; set(s: number): void }> {
  const got: string[] = []; let code = status;
  const server = createServer((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { if (req.method === "POST") got.push((JSON.parse(b) as { text: string }).text); res.statusCode = code; res.end("ok"); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/hook`, got, server, set: (s) => { code = s; } };
}

test("the watchdog tells the owner once per outage over a real loopback channel, reminds on the owner's schedule, survives its own restart, and closes the record when the controller answers", async () => {
  const d = await dir(); const ch = await fakeChannel();
  try {
    t = Date.parse("2026-11-14T10:00:00.000Z");
    const file = join(d, "wd.json"); let state: "alive" | "down" | "unknown" = "alive";
    const probe: Probe = async () => state;
    const make = (): DownWatchdog => new DownWatchdog({ file, probe, tell: webhookTell(ch.url), now: () => t, failuresBeforeDown: 3, remindEveryMs: 60 * MIN });
    let dog = make();
    await dog.tick(); assert.equal(await readWatchdogRecord(file, () => t), undefined);
    state = "down";
    await dog.tick(); await dog.tick();
    assert.equal(ch.got.length, 0, "two bad looks are not an outage");
    assert.equal((await dog.tick()).told, true);
    assert.equal(ch.got.length, 1);
    assert.match(ch.got[0]!, /controller is not answering/);
    t += 10 * MIN; dog = make(); await dog.tick(); await dog.tick(); await dog.tick();
    assert.equal(ch.got.length, 1, "a restarted watchdog goes on with the record: not a second message");
    state = "unknown"; t += 61 * MIN; await dog.tick();
    assert.equal(ch.got.length, 1, "an unknown probe says nothing");
    state = "down"; await dog.tick();
    assert.equal(ch.got.length, 2); assert.match(ch.got[1]!, /still not answering/);
    // The channel failing is not an outage of its own: nothing is counted as told, the next due look tries again.
    ch.set(500); t += 61 * MIN; assert.equal((await dog.tick()).told, false);
    ch.set(200); assert.equal((await dog.tick()).told, false, "a refused message is not tried again at the very next look");
    assert.equal(ch.got.length, 3, "the channel saw the one refused attempt only");
    t += MIN; assert.equal((await dog.tick()).told, true);
    assert.equal((await readWatchdogRecord(file, () => t))!.tells, 3);
    state = "alive"; await dog.tick();
    assert.ok((await readWatchdogRecord(file, () => t))!.returnedAt !== undefined);
    state = "down"; await dog.tick(); await dog.tick(); await dog.tick();
    assert.equal(ch.got.length, 5, "a second outage is told again (the channel also saw the one attempt it refused)");
  } finally { ch.server.close(); await rm(d, { recursive: true, force: true }); }
});

test("records that cannot be trusted are no outage, and the probes judge by what they see", async () => {
  const d = await dir();
  try {
    const f = join(d, "r.json");
    for (const text of ["", "{", "[]", JSON.stringify({ v: 2, downSince: "2026-11-14T10:00:00.000Z", tells: 0 }), JSON.stringify({ v: 1, downSince: "yesterday", tells: 0 }), JSON.stringify({ v: 1, downSince: "2026-11-14T10:00:00.000Z", tells: -1 }), JSON.stringify({ v: 1, downSince: "2099-01-01T00:00:00.000Z", tells: 0 }), "x".repeat(2000)]) {
      await writeFile(f, text); assert.equal(await readWatchdogRecord(f, () => t), undefined, text.slice(0, 30));
    }
    assert.equal(await readWatchdogRecord(join(d, "none"), () => t), undefined);
    const up = await fakeChannel(200); const sick = await fakeChannel(503);
    try {
      assert.equal(await httpProbe(up.url.replace("/hook", "/"))(), "alive");
      assert.equal(await httpProbe(sick.url)(), "down");
    } finally { up.server.close(); sick.server.close(); }
    assert.equal(await httpProbe("http://127.0.0.1:9/", { timeoutMs: 500 })(), "down", "nothing listens");
    let mono = 0;
    const hb = join(d, "hb.json"); const beat = (seq: number): Promise<void> => writeFile(hb, JSON.stringify({ v: 1, seq, token: "tokentoken1", intervalMs: 1000 }));
    const p = heartbeatProbe(hb, { staleMs: 30_000, monotonic: () => mono });
    assert.equal(await p(), "unknown", "no file yet");
    await beat(1); assert.equal(await p(), "alive");
    mono += 10_000; assert.equal(await p(), "alive", "standing still, but not long");
    mono += 10_000; assert.equal(await p(), "alive");
    mono += 10_000; assert.equal(await p(), "down", "30 seconds of a standing counter");
    await beat(2); mono += 1000; assert.equal(await p(), "alive", "moving again");
    mono += 100_000; assert.equal(await p(), "unknown", "a long gap between looks is a pause of the watchdog, not a verdict");
  } finally { await rm(d, { recursive: true, force: true }); }
});

for (const backend of backends) {
  test(`${backend.name}: the controller raises the recorded outage once when it runs again, remembers it across a restart, and keeps it back when the owner turned the notice off`, async () => {
    const d = await dir(); const world = await backend.open();
    try {
      const clock = (): string => new Date(t).toISOString();
      const options = { clock, pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = (await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token))!;
      const svc = NotificationService.withEpoch(world.storage, projects.epoch, options);
      const file = join(d, "wd.json");
      const build = (): UrgentWatch => new UrgentWatch({ notifications: svc, watchdog: watchdogSource(file, () => t), clock });
      let watch = build();
      const open = async (): Promise<{ label: string; level: string }[]> => (await svc.inbox(owner)).items.filter((i) => i.kind === "maintenance" && i.state !== "answered" && i.state !== "settled" && i.label.includes("controller was down")) as never;
      assert.deepEqual((await watch.sweep(owner)).raised, [], "no record: nothing");
      t = Date.parse("2026-11-14T11:00:00.000Z");
      await writeFile(file, JSON.stringify({ v: 1, downSince: "2026-11-14T10:20:00.000Z", tells: 2, lastToldAt: "2026-11-14T10:50:00.000Z" }));
      assert.deepEqual((await watch.sweep(owner)).raised, ["controller-down"]);
      const [item] = await open();
      assert.equal(item!.level, "urgent");
      assert.match(item!.label, /controller was down from 2026-11-14T10:20/);
      assert.deepEqual((await watch.sweep(owner)).raised, [], "once");
      watch = build();
      assert.deepEqual((await watch.sweep(owner)).raised, [], "and not again after a restart");
      assert.equal((await open()).length, 1);
      // A second outage is a new record.
      await writeFile(file, JSON.stringify({ v: 1, downSince: "2026-11-14T12:00:00.000Z", tells: 0 })); t = Date.parse("2026-11-14T12:30:00.000Z");
      await svc.configure(owner, { commandId: "cfg-wd", expectedRevision: (await svc.settings(owner)).revision, controllerDownNotice: false } as never);
      assert.deepEqual((await watch.sweep(owner)).raised, [], "the owner turned the notice off");
      assert.equal((await open()).length, 1, "still only the first");
      await svc.configure(owner, { commandId: "cfg-wd2", expectedRevision: (await svc.settings(owner)).revision, controllerDownNotice: true } as never);
      assert.deepEqual((await watch.sweep(owner)).raised, [], "an outage seen while the notice was off is not raised later");
      assert.equal(await readFile(`${file}.raised`, "utf8"), "2026-11-14T12:00:00.000Z");
      // Two controllers over one database that both read the record at once raise ONE item (the command ID is the outage's), and a note of the controller's that is not a plain time is no note.
      await writeFile(file, JSON.stringify({ v: 1, downSince: "2026-11-14T13:00:00.000Z", tells: 1, lastToldAt: "2026-11-14T13:01:00.000Z" })); t = Date.parse("2026-11-14T13:30:00.000Z");
      await writeFile(`${file}.raised`, "x".repeat(100));
      const other = new UrgentWatch({ notifications: svc, watchdog: watchdogSource(file, () => t), clock });
      await Promise.all([watch.sweep(owner), other.sweep(owner)]);
      assert.equal((await open()).length, 2, "the first outage and this one, each once");
      assert.equal(await readFile(`${file}.raised`, "utf8"), "2026-11-14T13:00:00.000Z");
      assert.deepEqual((await build().sweep(owner)).raised, []);
    } finally { await world.close(); await rm(d, { recursive: true, force: true }); }
  });
}

test("the watchdog's record reaches its file on Windows while the controller has it open: the rename over it is tried again on EPERM, EACCES, EBUSY (bounded, the launcher's rule), elsewhere once; a refused record leaves the old one and no temporary file (CI repair winflake, second review)", async () => {
  const root = await dir();
  try {
    const file = join(root, "watchdog.json");
    const { rename: realRename } = await import("node:fs/promises");
    const { readdirSync } = await import("node:fs");
    const failing = (code: string, fails: number) => {
      const w = { calls: 0, pauses: [] as number[] };
      return Object.assign(w, { rename: async (from: string, to: string) => { w.calls += 1; if (w.calls <= fails) throw Object.assign(new Error(`${code}: rename`), { code }); await realRename(from, to); }, pause: async (ms: number) => { w.pauses.push(ms); } });
    };
    const first = { v: 1 as const, downSince: "2026-11-14T10:00:00.000Z", tells: 0 };
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const w = failing(code, 2);
      await writeWatchdogRecord(file, { ...first, tells: 1 }, { platform: "win32", rename: w.rename, pause: w.pause });
      assert.equal(w.calls, 3, `${code}: two refusals, then it went through`);
      assert.deepEqual(w.pauses, [10, 20]);
      assert.equal(JSON.parse(await readFile(file, "utf8")).tells, 1);
      await writeWatchdogRecord(file, first);
    }
    const never = failing("EPERM", Number.MAX_SAFE_INTEGER);
    await assert.rejects(writeWatchdogRecord(file, { ...first, tells: 2 }, { platform: "win32", rename: never.rename, pause: never.pause }), (e: NodeJS.ErrnoException) => e.code === "EPERM");
    assert.equal(never.calls, 10, "bounded: ten tries");
    for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"]] as const) {
      const v = failing(code, Number.MAX_SAFE_INTEGER);
      await assert.rejects(writeWatchdogRecord(file, { ...first, tells: 3 }, { platform, rename: v.rename, pause: v.pause }), (e: NodeJS.ErrnoException) => e.code === code);
      assert.equal(v.calls, 1, `${platform} ${code}: one try`);
    }
    assert.equal(JSON.parse(await readFile(file, "utf8")).tells, 0, "a refused record leaves the old one");
    assert.deepEqual(readdirSync(root).filter((n) => n.endsWith(".tmp")), [], "and no temporary file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
