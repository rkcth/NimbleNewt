import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copyPiState } from "../backup/pi-state.js";
import { PI_FOLDER, PI_INDEX } from "../backup/format.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { PiStateSource } from "../backup/pi-state.js";
import { PiStateHost, PiStateTransfers, RemotePiRestore, RemotePiState, combinedPiState, localOnly, newPiId, parseRemoteStoreId, remoteStoreId } from "./pi-state.js";
import { REMOTE_LIMITS } from "./protocol.js";
import { WorkspaceResponder } from "./responder.js";
import { remoteSuite, wireRefuses } from "./testing/suite.js";
import type { RemoteHost, RemoteWorld } from "./testing/world.js";

after(stopServer);

// Card K01i: the conversation stores of remote hosts travel to the controller for a backup and back to the host after a restore, over the authenticated worker channel, on every storage backend.
const A1 = "att-aaaaaaaaaaaaaaaaaaaa", A2 = "att-bbbbbbbbbbbbbbbbbbbb";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01i-remote-"));

/** A host's machine: its attempts' homes (`<root>/<attempt>/home/pi`) and the handler that answers the controller's requests, run by a poll loop like the real poller's. */
function machine(r: RemoteHost, dir: string, busy: { ids: string[] } = { ids: [] }) {
  const root = join(dir, "attempts");
  const dirOf = (id: string): string => join(root, id, "home", "pi");
  const source: PiStateSource = { list: async () => (existsSync(root) ? readdirSync(root).sort().map((id) => ({ id, dir: dirOf(id) })).filter((s) => existsSync(s.dir)) : []) };
  const host = new PiStateHost({ client: r.client, source, final: (id) => (/^att-/.test(id) ? dirOf(id) : undefined), busy: () => busy.ids, scratch: join(dir, "copies") });
  const responder = new WorkspaceResponder({ client: r.client, busy: () => [], port: { run: async () => ({ ok: false, reason: "not a workspace request" }) }, piState: host });
  let stop = false;
  const loop = (async () => { while (!stop) { try { const l = await r.client.workspaceList(); responder.handle(l.requests, l.withdrawn); } catch { /* the test ends */ } await sleep(10); } })();
  return {
    dirOf, root, put: (id: string, rel: string, body: string | Buffer) => { const p = join(dirOf(id), ...rel.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); },
    read: (id: string, rel: string): string => readFileSync(join(dirOf(id), ...rel.split("/")), "utf8"),
    stop: async () => { stop = true; await loop; await responder.idle(); },
  };
}

const sourceFor = (c: RemoteWorld, dir: string, transfers: PiStateTransfers, hosts: () => Promise<{ readonly ask: readonly string[]; readonly unreachable: readonly { readonly hostId: string; readonly why: string }[] }>, waitMs = 5000): RemotePiState => new RemotePiState({
  directory: join(dir, "in"), transfers, hosts, waitMs,
  ask: (hostId, operation, requestId, transferId, wait) => c.remote.askPiState(c.dispatcherPrincipal, hostId, operation, requestId, transferId, { waitMs: wait }),
});

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a host's conversation stores are asked for, sent in chunks, checked against the index and kept in a backup under the host's own names; two hosts' stores never meet (card K01i)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1"), r2 = await c.host("r2");
      const transfers = new PiStateTransfers({ directory: join(dir, "in") });
      c.remote.attachPiTransfers(transfers);
      const m1 = machine(r1, join(dir, "m1")), m2 = machine(r2, join(dir, "m2"));
      // The same attempt-shaped key on both hosts (a collision if the names did not carry the host), one file larger than a chunk, nested folders, a JSON-lines log.
      const big = Buffer.alloc(REMOTE_LIMITS.piChunkBytes * 2 + 12345, "x");
      m1.put(A1, "log.jsonl", '{"turn":1}\n{"turn":2}\n'); m1.put(A1, "sub/deep/notes.txt", "kept"); m1.put(A1, "big.bin", big); m1.put(A2, "log.jsonl", '{"a":2}\n');
      m2.put(A1, "log.jsonl", '{"other":"host"}\n');
      const source = sourceFor(c, dir, transfers, async () => (await c.remote.piStateHosts(c.dispatcherPrincipal)));
      const staging = join(dir, "backup"); mkdirSync(staging);
      const done = await copyPiState(source, staging, undefined);
      assert.equal(done.stores, 3);
      assert.equal(done.files, 5);
      assert.equal(done.problemCount, undefined, JSON.stringify(done.problems));
      const index = readFileSync(join(staging, PI_INDEX), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { store: string; rel: string; size: number; sha256: string; file: string });
      assert.deepEqual([...new Set(index.map((l) => l.store))].sort(), [`rh.r1.${A1}`, `rh.r1.${A2}`, `rh.r2.${A1}`]);
      const bigLine = index.find((l) => l.rel === "big.bin")!;
      assert.equal(bigLine.size, big.length);
      assert.equal(bigLine.sha256, sha(big));
      assert.equal(sha(readFileSync(join(staging, PI_FOLDER, bigLine.file))), sha(big), "the big file came through its chunks intact");
      assert.equal(readFileSync(join(staging, PI_FOLDER, index.find((l) => l.store === `rh.r2.${A1}`)!.file), "utf8"), '{"other":"host"}\n');
      // What was staged for the copy is gone, and no transfer stays open.
      assert.equal(transfers.openCount, 0);
      assert.deepEqual(readdirSync(join(dir, "in")), []);
      await m1.stop(); await m2.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  suite("a host that is not heard from, does not answer, refuses or sends less than it announced is NAMED in the backup's problems, never read as having no stores (card K01i)", async (c) => {
    const dir = tmp();
    try {
      const ok = await c.host("ok"), stale = await c.host("quiet");
      const transfers = new PiStateTransfers({ directory: join(dir, "in") });
      c.remote.attachPiTransfers(transfers);
      const m = machine(ok, join(dir, "ok")); m.put(A1, "log.jsonl", "fine\n");
      // `quiet` is connected but no process answers its requests (waitMs short); `gone` is revoked-looking: reported unreachable by the host list.
      const hosts = async () => ({ ask: ["host:ok", "host:quiet"], unreachable: [{ hostId: "host:gone", why: "it has not been heard from lately" }] });
      const source = sourceFor(c, dir, transfers, hosts, 400);
      const staging = join(dir, "backup"); mkdirSync(staging);
      const done = await copyPiState(source, staging, undefined);
      assert.equal(done.stores, 1, "the answering host's store is there");
      assert.equal(done.problemCount, 2);
      assert.match(done.problems!.join("\n"), /host:gone: its conversation stores are not in this backup \(it has not been heard from lately\)/);
      assert.match(done.problems!.join("\n"), /host:quiet: its conversation stores are not in this backup \(it did not answer/);
      void stale;
      assert.equal(transfers.openCount, 0, "a transfer that got no answer is closed");
      // A host that sends fewer files than it announced: a handler whose answer claims one more.
      const liar = await c.host("liar");
      const honest = new PiStateHost({ client: liar.client, source: { list: async () => [{ id: A1, dir: join(dir, "liar", A1) }] }, final: () => undefined, busy: () => [], scratch: join(dir, "liar-copies") });
      mkdirSync(join(dir, "liar", A1), { recursive: true }); writeFileSync(join(dir, "liar", A1, "f.txt"), "x");
      const responder = new WorkspaceResponder({ client: liar.client, busy: () => [], port: { run: async () => ({ ok: false, reason: "no" }) }, piState: { answer: async (ask) => { const a = await honest.answer(ask); return a.ok ? { ok: true, summary: "sent", detail: { ...(a.detail as object), files: 2 } } : a; } } });
      let stop = false;
      const loop = (async () => { while (!stop) { try { const l = await liar.client.workspaceList(); responder.handle(l.requests, l.withdrawn); } catch { /* ends */ } await sleep(10); } })();
      const s2 = sourceFor(c, dir, transfers, async () => ({ ask: ["host:liar"], unreachable: [] }));
      const stores = await s2.list();
      assert.deepEqual(stores, [], "nothing of a host whose files do not match what it announced is taken");
      assert.match(s2.problems().join("\n"), /announced 2 files and its index lists 1/);
      await s2.release();
      stop = true; await loop; await responder.idle(); await m.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  suite("the transfer messages are checked: only the host the transfer was opened for, only names of a transfer, in order, digest verified, bounded; the same chunk sent again counts once (card K01i)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1"), r2 = await c.host("r2");
      const transfers = new PiStateTransfers({ directory: join(dir, "in"), maxBytes: 100, maxFiles: 3 });
      c.remote.attachPiTransfers(transfers);
      const id = newPiId("pst");
      await transfers.receive(id, "host:r1");
      const chunk = (name: string, offset: number, text: string, last = false) => ({ name, offset, data: Buffer.from(text), ...(last ? { last: { sha256: sha(text) } } : {}) });
      await r1.client.piStatePut(id, chunk("f-0", 0, "hello", true));
      assert.deepEqual([...transfers.received(id)], [["f-0", { size: 5, sha256: sha("hello") }]]);
      // The same chunk sent again (a lost answer): accepted, nothing written twice.
      await r1.client.piStatePut(id, chunk("f-0", 0, "hello", true));
      assert.equal(readFileSync(join(dir, "in", id, PI_FOLDER, "f-0"), "utf8"), "hello");
      // Another host, an unknown transfer, a bad name, a gap, a wrong digest, too much, too many files.
      await wireRefuses("not_found", () => r2.client.piStatePut(id, chunk("f-1", 0, "x")));
      await wireRefuses("not_found", () => r1.client.piStatePut(newPiId("pst"), chunk("f-1", 0, "x")));
      for (const bad of ["../x", "f-", "f-1/../../x", "index.jsonl.bak", "F-1"]) await wireRefuses("invalid_command", () => r1.client.piStatePut(id, chunk(bad, 0, "x")));
      await wireRefuses("command_conflict", () => r1.client.piStatePut(id, chunk("f-1", 7, "x")));
      await r1.client.piStatePut(id, chunk("f-2", 0, "ab"));
      await wireRefuses("command_conflict", () => r1.client.piStatePut(id, chunk("f-2", 5, "cd")));
      await wireRefuses("integrity", () => r1.client.piStatePut(id, { name: "f-2", offset: 2, data: Buffer.from("cd"), last: { sha256: sha("nope") } }));
      assert.equal(transfers.received(id).has("f-2"), false, "a file whose digest was wrong is dropped");
      await wireRefuses("invalid_command", () => r1.client.piStatePut(id, chunk("f-3", 0, "z".repeat(200))));
      await r1.client.piStatePut(id, chunk("f-4", 0, "1"));
      await r1.client.piStatePut(id, chunk("f-5", 0, "1"));
      await wireRefuses("invalid_command", () => r1.client.piStatePut(id, chunk("f-6", 0, "1")));
      // A fetch is only for a transfer opened to serve to that host.
      await wireRefuses("not_found", () => r1.client.piStateGet(id, "f-0", 0));
      await transfers.end(id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  suite("after a restore each host gets its own stores back: staged beside its place, swapped in with what was there kept; a running agent's store, a store the host does not keep and a host that is not connected leave everything as it was and are tried again (card K01i)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1"), r2 = await c.host("r2", { connect: false });
      const transfers = new PiStateTransfers({ directory: join(dir, "in") });
      c.remote.attachPiTransfers(transfers);
      const busy = { ids: [A1] };
      const m1 = machine(r1, join(dir, "m1"), busy);
      // The host's store as it is now (ahead of the backup), and the backup's version the restore left in the controller's data directory.
      m1.put(A1, "log.jsonl", '{"now":3}\n'); m1.put(A1, "gone-after.txt", "only now");
      const data = join(dir, "data");
      const left = (host: string, id: string, rel: string, body: string): void => { const p = join(data, "restored-pi-state", `rh.${host}.${id}`, ...rel.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
      left("r1", A1, "log.jsonl", '{"backup":1}\n'); left("r1", A1, "deep/x.txt", "x"); left("r1", A2, "log.jsonl", '{"two":1}\n'); left("r2", A1, "log.jsonl", "for r2\n");
      const restore = new RemotePiRestore({ dataDirectory: data, transfers, waitMs: 5000, now: () => new Date("2026-11-12T10:00:00Z"), ask: (h, op, rid, tid, w) => c.remote.askPiState(c.dispatcherPrincipal, h, op, rid, tid, { waitMs: w }) });
      let state = await restore.sweep();
      assert.deepEqual(state.waiting.map((w) => [w.hostId, w.stores]), [["host:r1", 2], ["host:r2", 1]]);
      assert.match(state.waiting[0]!.reason!, /agent of att-aaaaaaaaaaaaaaaaaaaa is running on this host/);
      assert.match(state.waiting[1]!.reason!, /not connected|not been heard|nothing was sent/);
      assert.equal(m1.read(A1, "log.jsonl"), '{"now":3}\n', "a running agent's store was not replaced");
      assert.equal(existsSync(m1.dirOf(A2)), false, "nothing of the host's other store was put either: the restore is all or nothing per host");
      // The agent stopped: the stores arrive, what was there is kept beside.
      busy.ids = [];
      state = await restore.sweep();
      assert.deepEqual(state.waiting.map((w) => w.hostId), ["host:r2"]);
      assert.equal(state.delivered, 2);
      assert.equal(m1.read(A1, "log.jsonl"), '{"backup":1}\n');
      assert.equal(m1.read(A1, "deep/x.txt"), "x");
      assert.equal(existsSync(join(m1.dirOf(A1), "gone-after.txt")), false, "the restored store is the backup's, not a merge");
      assert.equal(m1.read(A2, "log.jsonl"), '{"two":1}\n');
      const aside = readdirSync(join(m1.root, A1, "home")).find((n) => n.startsWith("pi.before-restore-"))!;
      assert.equal(readFileSync(join(m1.root, A1, "home", aside, "gone-after.txt"), "utf8"), "only now", "what was there is kept beside");
      assert.deepEqual(readdirSync(join(data, "restored-pi-state")), [`rh.r2.${A1}`], "delivered stores left the waiting folder");
      assert.equal(readdirSync(join(data, "restored-pi-state-delivered")).length, 2);
      assert.equal(transfers.openCount, 0);
      assert.equal(existsSync(join(data, "pi-remote-out", "x")), false);
      // A host that keeps no such store refuses the whole delivery and changes nothing.
      const r3 = await c.host("r3");
      const m3 = machine(r3, join(dir, "m3"));
      left("r3", "not-an-attempt", "log.jsonl", "x");
      state = await restore.sweep();
      assert.match(state.waiting.find((w) => w.hostId === "host:r3")!.reason!, /keeps no conversation store not-an-attempt/);
      await m1.stop(); await m3.stop(); void r2;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  suite("a host refuses a delivery whose index or files are not what the controller says: a path that leaves the store, a changed file, a swap that fails halfway is undone (card K01i)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1");
      const transfers = new PiStateTransfers({ directory: join(dir, "in") });
      c.remote.attachPiTransfers(transfers);
      const m1 = machine(r1, join(dir, "m1"));
      m1.put(A1, "log.jsonl", "mine\n");
      const ask = async (section: string) => { const tid = newPiId("pst"); transfers.serve(tid, "host:r1", section); try { return await c.remote.askPiState(c.dispatcherPrincipal, "host:r1", "pi-state-restore", newPiId("wsr"), tid, { waitMs: 5000 }); } finally { await transfers.end(tid); } };
      const section = (index: string, files: Record<string, string>): string => { const d = join(dir, `s${Math.random().toString(36).slice(2)}`); mkdirSync(join(d, PI_FOLDER), { recursive: true }); writeFileSync(join(d, PI_INDEX), index); for (const [n, b] of Object.entries(files)) writeFileSync(join(d, PI_FOLDER, n), b); return d; };
      const line = (store: string, rel: string, body: string, file = "f-0") => `${JSON.stringify({ store, rel, size: Buffer.byteLength(body), sha256: sha(body), file })}\n`;
      // A path that leaves the store, a name a backup cannot keep, a duplicate: the index is not valid.
      for (const rel of ["../../escape.txt", "/abs.txt", "a\\b.txt", "x/../y"]) {
        const a = await ask(section(line(A1, rel, "evil"), { "f-0": "evil" }));
        assert.equal(a.ok, false); assert.match((a as { reason: string }).reason, /index of the stores is not valid/, rel);
      }
      // A file that is not the bytes the index lists (also a longer one).
      let a = await ask(section(line(A1, "log.jsonl", "claimed"), { "f-0": "tampered" }));
      assert.equal(a.ok, false); assert.match((a as { reason: string }).reason, /did not match its entry in the index/);
      assert.equal(m1.read(A1, "log.jsonl"), "mine\n", "nothing changed");
      // A failing swap: the second store cannot be put in place (its parent is a file); the first is put back as it was.
      writeFileSync(join(m1.root, A2), "i am a file where a folder should be");
      a = await ask(section(line(A1, "log.jsonl", "restored", "f-0") + line(A2, "x.txt", "two", "f-1"), { "f-0": "restored", "f-1": "two" }));
      assert.equal(a.ok, false);
      assert.equal(m1.read(A1, "log.jsonl"), "mine\n", "the swap that failed was undone");
      assert.deepEqual(readdirSync(join(m1.root, A1, "home")).sort(), ["pi"], "no staged copy or aside is left");
      await m1.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("store IDs: a remote store carries its host; a bad host or key has no ID; the local `final` never sees a remote store", () => {
  assert.equal(remoteStoreId("host:r1", A1), `rh.r1.${A1}`);
  assert.deepEqual(parseRemoteStoreId(`rh.r1.${A1}`), { hostId: "host:r1", key: A1 });
  assert.equal(remoteStoreId("r1", A1), undefined);
  assert.equal(remoteStoreId("host:R1", A1), undefined);
  assert.equal(remoteStoreId("host:r1", "../x"), undefined);
  assert.equal(remoteStoreId("host:r1", "x".repeat(200)), undefined);
  for (const id of ["rh.", "rh..x", "rh.r1", "rh.r1.", "att-x", "rh.R1.k", "rh.r1.a..b"]) assert.equal(parseRemoteStoreId(id), undefined, id);
  const final = localOnly((id) => `/homes/${id}`)!;
  assert.equal(final(A1), `/homes/${A1}`);
  assert.equal(final(`rh.r1.${A1}`), undefined);
  assert.equal(localOnly(undefined), undefined);
  assert.equal(combinedPiState(undefined), undefined);
});

test("a restore that is being made or waits for its start is never delivered from: staged copies, asides and a recorded restore are left alone (card K01i)", async () => {
  const dir = tmp();
  try {
    const data = join(dir, "data");
    const mk = (name: string): void => { mkdirSync(join(data, "restored-pi-state", name), { recursive: true }); writeFileSync(join(data, "restored-pi-state", name, "f.txt"), "x"); };
    mk(`rh.r1.${A1}.nn-staged-20261112T000000Z`); mk(`rh.r1.${A1}.before-restore-20261112T000000Z`); mk(`rh.r1.${A2}`);
    const asked: string[] = [];
    const restore = new RemotePiRestore({ dataDirectory: data, transfers: new PiStateTransfers({ directory: join(dir, "in") }), ask: async (h, _op, _r, _t) => { asked.push(h); return { ok: false, reason: "not now" }; } });
    // Only the finished store is waiting; staged copies and asides are not stores.
    assert.deepEqual((await restore.state()).waiting, [{ hostId: "host:r1", stores: 1 }]);
    // A restore recorded for the next start (its marker) or half swapped (its journal): nothing is delivered, nothing asked.
    for (const file of ["pending-restore.json", "restore-journal.json"]) {
      writeFileSync(join(data, file), "{}");
      await restore.sweep();
      assert.deepEqual(asked, [], file);
      rmSync(join(data, file));
    }
    // And while the barrier is up.
    let up = true;
    const held = new RemotePiRestore({ dataDirectory: data, transfers: new PiStateTransfers({ directory: join(dir, "in") }), held: () => up, ask: async (h) => { asked.push(h); return { ok: false, reason: "not now" }; } });
    await held.sweep(); assert.deepEqual(asked, []);
    up = false; await held.sweep(); assert.deepEqual(asked, ["host:r1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
