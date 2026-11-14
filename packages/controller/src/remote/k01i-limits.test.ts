import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copyPiState, type PiStateSource } from "../backup/pi-state.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PiStateHost, PiStateTransfers, RemotePiRestore, RemotePiState, newPiId, pruneAsides, splitDashStamp } from "./pi-state.js";
import type { WorkspaceAsk } from "./protocol.js";
import { WorkspaceResponder } from "./responder.js";
import { remoteSuite } from "./testing/suite.js";
import type { RemoteHost } from "./testing/world.js";

after(stopServer);

// Card K01i, last slice: what a restore leaves behind is bounded (asides on hosts, delivered and superseded copies on the controller), and a backup cannot be made to stage more than a fixed total from remote hosts.
const A1 = "att-aaaaaaaaaaaaaaaaaaaa";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01il-"));
const stampAt = (n: number): string => `202611${String(n).padStart(2, "0")}T120000000Z`;

/** A host with one attempt's store; each call of `restoreWith` makes the controller's section for a new restored conversation and asks the host to fetch it, stamped as made at day `n`. */
async function hostRig(keepAsides?: number) {
  const d = tmp();
  const target = join(d, "host", "attempts", A1, "home", "pi");
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, "log.jsonl"), "first\n");
  const transfers = new PiStateTransfers({ directory: join(d, "ctl", "in") });
  let now = new Date(Date.UTC(2026, 10, 1, 12));
  let current = "";
  const client = {
    piStatePut: async () => undefined,
    piStateGet: async (t: string, name: string, offset: number) => {
      const c = await transfers.get("host:h1", t, name, offset);
      return { data: Buffer.from(c.data, "base64"), offset: c.offset, size: c.size, eof: c.eof, ...(c.sha256 === undefined ? {} : { sha256: c.sha256 }) };
    },
  };
  const host = new PiStateHost({ client, source: { list: async () => [] }, final: (id) => (id === A1 ? target : undefined), busy: () => [], scratch: join(d, "host", "copies"), now: () => now, ...(keepAsides === undefined ? {} : { keepAsides }) });
  return {
    d, target, home: join(target, ".."),
    async restoreWith(text: string, day: number): Promise<void> {
      now = new Date(Date.UTC(2026, 10, day, 12));
      const restored = join(d, "ctl", `restored-${day}`); mkdirSync(restored, { recursive: true }); writeFileSync(join(restored, "log.jsonl"), text);
      const section = join(d, "ctl", `out-${day}`); mkdirSync(section, { recursive: true });
      await copyPiState({ list: async () => [{ id: A1, dir: restored }] }, section, undefined);
      const transferId = newPiId("pst"); current = transferId;
      transfers.serve(transferId, "host:h1", section);
      const ask = { requestId: newPiId("wsr"), operation: "pi-state-restore", taskId: "pi-state", projectId: "pi-state", reason: "r", quietAttempts: [], piState: { transferId } } as unknown as WorkspaceAsk;
      const answer = await host.answer(ask);
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.ok(current);
    },
    close: () => rmSync(d, { recursive: true, force: true }),
  };
}

test("a host keeps only the newest two asides beside a store after restores, and the store itself holds the last restored conversation (card K01i)", async () => {
  const r = await hostRig();
  try {
    for (const day of [2, 3, 4, 5]) await r.restoreWith(`conversation ${day}\n`, day);
    const names = readdirSync(r.home).sort();
    assert.deepEqual(names, ["pi", `pi.before-restore-${stampAt(4)}`, `pi.before-restore-${stampAt(5)}`].sort(), "the two newest asides stay; the older two were removed");
    assert.equal(readFileSync(join(r.target, "log.jsonl"), "utf8"), "conversation 5\n");
    assert.equal(readFileSync(join(r.home, `pi.before-restore-${stampAt(5)}`, "log.jsonl"), "utf8"), "conversation 4\n", "the newest aside is what the last restore replaced");
  } finally { r.close(); }
});

test("the number of asides a host keeps can be set", async () => {
  const r = await hostRig(1);
  try {
    for (const day of [2, 3, 4]) await r.restoreWith(`c ${day}\n`, day);
    assert.deepEqual(readdirSync(r.home).sort(), ["pi", `pi.before-restore-${stampAt(4)}`]);
  } finally { r.close(); }
});

test("pruning touches only real folders that carry a stamp, only the older ones of one store, and never a link, a file or an unknown name (card K01i)", async () => {
  const d = tmp();
  try {
    const mk = (n: string): void => mkdirSync(join(d, n));
    for (const n of ["rh.h1.att-x-20261101T120000Z", "rh.h1.att-x-20261102T120000Z", "rh.h1.att-x-20261103T120000Z", "rh.h1.att-y-20261101T120000Z", "other-folder", "rh.h1.att-x-notastamp"]) mk(n);
    writeFileSync(join(d, "rh.h1.att-x-20261101T000000Z"), "a file, not a folder");
    const outside = mkdtempSync(join(tmpdir(), "nn-k01il-out-"));
    try {
      let linked = true;
      try { symlinkSync(outside, join(d, "rh.h1.att-x-20260101T000000Z"), "junction"); } catch { linked = false; }
      assert.equal(await pruneAsides(d, 2, splitDashStamp), 1);
      const left = readdirSync(d).sort();
      assert.ok(!left.includes("rh.h1.att-x-20261101T120000Z"), "the oldest copy of att-x is removed");
      for (const n of ["rh.h1.att-x-20261102T120000Z", "rh.h1.att-x-20261103T120000Z", "rh.h1.att-y-20261101T120000Z", "other-folder", "rh.h1.att-x-notastamp", "rh.h1.att-x-20261101T000000Z"]) assert.ok(left.includes(n), `${n} stays`);
      if (linked) assert.ok(existsSync(outside), "a link is not followed");
      assert.equal(await pruneAsides(d, 2, splitDashStamp), 0, "run again: nothing more");
      assert.equal(await pruneAsides(join(d, "missing"), 2, splitDashStamp), 0, "a folder that is not there is nothing to do");
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the controller keeps the newest three delivered and superseded copies of each store and removes the older ones after a delivery (card K01i)", async () => {
  const d = tmp();
  try {
    const delivered = join(d, "restored-pi-state-delivered"), superseded = join(d, "restored-pi-state-superseded");
    for (const f of [delivered, superseded]) for (const n of [1, 2, 3, 4, 5]) mkdirSync(join(f, `rh.h1.${A1}-${stampAt(n).replace("T120000000Z", "T120000Z")}`), { recursive: true });
    mkdirSync(join(d, "restored-pi-state", `rh.h1.${A1}`), { recursive: true });
    writeFileSync(join(d, "restored-pi-state", `rh.h1.${A1}`, "log.jsonl"), "x");
    const deliver = new RemotePiRestore({ dataDirectory: d, transfers: new PiStateTransfers({ directory: join(d, "in") }), ask: async () => ({ ok: true, summary: "restored" }), now: () => new Date(Date.UTC(2026, 10, 9, 12)) });
    await deliver.sweep();
    assert.equal((await deliver.state()).delivered, 1);
    const stamp = (n: number): string => `rh.h1.${A1}-${stampAt(n).replace("T120000000Z", "T120000Z")}`;
    assert.deepEqual(readdirSync(superseded).sort(), [stamp(3), stamp(4), stamp(5)], "superseded: the newest three");
    const kept = readdirSync(delivered).sort();
    assert.equal(kept.length, 3, "delivered: the newest three, counting the one just delivered");
    assert.ok(kept.some((n) => n.includes("20261109T120000")), "the copy just delivered is kept");
    assert.ok(!kept.includes(stamp(1)) && !kept.includes(stamp(2)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/** A host's machine for a backup: its attempts' homes and the handler that answers the controller, polled like the real poller. */
function machine(r: RemoteHost, dir: string) {
  const root = join(dir, "attempts");
  const dirOf = (id: string): string => join(root, id, "home", "pi");
  const source: PiStateSource = { list: async () => (existsSync(root) ? readdirSync(root).sort().map((id) => ({ id, dir: dirOf(id) })).filter((s) => existsSync(s.dir)) : []) };
  const host = new PiStateHost({ client: r.client, source, final: (id) => (/^att-/.test(id) ? dirOf(id) : undefined), busy: () => [], scratch: join(dir, "copies") });
  const responder = new WorkspaceResponder({ client: r.client, busy: () => [], port: { run: async () => ({ ok: false, reason: "not a workspace request" }) }, piState: host });
  let stop = false;
  const loop = (async () => { while (!stop) { try { const l = await r.client.workspaceList(); responder.handle(l.requests, l.withdrawn); } catch { /* the test ends */ } await sleep(10); } })();
  return {
    put: (id: string, rel: string, body: string | Buffer) => { const p = join(dirOf(id), ...rel.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); },
    stop: async () => { stop = true; await loop; await responder.idle(); },
  };
}

for (const backend of backends) {
  const suite = remoteSuite(backend);
  suite("a backup stages no more than a fixed total from all hosts: a host whose stores would pass it is left out and named, the others stay, and the next backup starts from zero (card K01i)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1"), r2 = await c.host("r2");
      const transfers = new PiStateTransfers({ directory: join(dir, "in") });
      c.remote.attachPiTransfers(transfers);
      const m1 = machine(r1, join(dir, "m1")), m2 = machine(r2, join(dir, "m2"));
      m1.put(A1, "big.bin", Buffer.alloc(60_000, "a")); m2.put(A1, "big.bin", Buffer.alloc(60_000, "b"));
      const source = new RemotePiState({
        directory: join(dir, "in"), transfers, waitMs: 5000, maxBytes: 100_000,
        hosts: async () => c.remote.piStateHosts(c.dispatcherPrincipal),
        ask: (hostId, operation, requestId, transferId, wait) => c.remote.askPiState(c.dispatcherPrincipal, hostId, operation, requestId, transferId, { waitMs: wait }),
      });
      try {
        const first = await source.list();
        assert.equal(first.length, 1, "one host fits, the other would pass the total");
        const problems = source.problems();
        assert.equal(problems.length, 1);
        assert.match(problems[0]!, /would take this backup past the \d+ MiB kept for hosts' conversation stores/);
      } finally { await source.release(); }
      // The count starts again for the next backup.
      const second = await source.list();
      assert.equal(second.length, 1);
      await source.release();
      assert.equal(transfers.openCount, 0);
      assert.deepEqual(readdirSync(join(dir, "in")), []);
      await m1.stop(); await m2.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  suite("with room for every host the cap changes nothing (card K01i)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1"), r2 = await c.host("r2");
      const transfers = new PiStateTransfers({ directory: join(dir, "in") });
      c.remote.attachPiTransfers(transfers);
      const m1 = machine(r1, join(dir, "m1")), m2 = machine(r2, join(dir, "m2"));
      m1.put(A1, "big.bin", Buffer.alloc(60_000, "a")); m2.put(A1, "big.bin", Buffer.alloc(60_000, "b"));
      const source = new RemotePiState({
        directory: join(dir, "in"), transfers, waitMs: 5000, maxBytes: 120_000,
        hosts: async () => c.remote.piStateHosts(c.dispatcherPrincipal),
        ask: (hostId, operation, requestId, transferId, wait) => c.remote.askPiState(c.dispatcherPrincipal, hostId, operation, requestId, transferId, { waitMs: wait }),
      });
      try { assert.equal((await source.list()).length, 2); assert.deepEqual(source.problems(), []); } finally { await source.release(); }
      await m1.stop(); await m2.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
