import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PiStateSource } from "../backup/pi-state.js";
import { stopServer, backends } from "../domain/testing/backends.js";
import { combineThinkingStores, localThinkingStores } from "../retention/thinking-stores.js";
import { PiStateHost, RemoteThinkingStores } from "./pi-state.js";
import { WorkspaceResponder } from "./responder.js";
import type { WorkspaceAsk } from "./protocol.js";
import { remoteSuite } from "./testing/suite.js";
import type { RemoteHost } from "./testing/world.js";

after(stopServer);

// Card K06c: the retention rule reaches the conversation stores of remote hosts over the authenticated worker channel: the host removes the stored thinking from the stores of the attempts named, and says which it cleaned, keeps none of, or left alone.
const A1 = "att-aaaaaaaaaaaaaaaaaaaa", A2 = "att-bbbbbbbbbbbbbbbbbbbb", A3 = "att-cccccccccccccccccccc";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k06c-remote-"));
/** The fake rewrite: lines that mention THINK are dropped, as the Pi adapter drops the blocks. */
const purge = async (dir: string): Promise<{ blocks: number }> => {
  let blocks = 0;
  for (const f of readdirSync(dir)) { const p = join(dir, f); const lines = readFileSync(p, "utf8").split("\n"); const kept = lines.filter((l) => !l.includes("THINK")); blocks += lines.length - kept.length; writeFileSync(p, kept.join("\n")); }
  return { blocks };
};

function machine(r: RemoteHost, dir: string, options: { busy?: string[]; withPurge?: boolean; failFor?: string } = {}) {
  const root = join(dir, "attempts");
  const dirOf = (id: string): string => join(root, id, "home", "pi");
  const source: PiStateSource = { list: async () => (existsSync(root) ? readdirSync(root).sort().map((id) => ({ id, dir: dirOf(id) })).filter((s) => existsSync(s.dir)) : []) };
  const calls: string[] = [];
  const host = new PiStateHost({ client: r.client, source, final: () => undefined, busy: () => options.busy ?? [], scratch: join(dir, "copies"),
    ...(options.withPurge === false ? {} : { purgeThinking: async (d: string) => { calls.push(d); if (options.failFor !== undefined && d.includes(options.failFor)) throw new Error(`cannot write ${d}`); return purge(d); } }) });
  const responder = new WorkspaceResponder({ client: r.client, busy: () => [], port: { run: async () => ({ ok: false, reason: "not a workspace request" }) }, piState: host });
  let stop = false;
  const loop = (async () => { while (!stop) { try { const l = await r.client.workspaceList(); responder.handle(l.requests, l.withdrawn); } catch { /* the test ends */ } await sleep(10); } })();
  return {
    host, calls,
    put: (id: string, text: string) => { mkdirSync(dirOf(id), { recursive: true }); writeFileSync(join(dirOf(id), "main.jsonl"), text); },
    read: (id: string): string => readFileSync(join(dirOf(id), "main.jsonl"), "utf8"),
    stop: async () => { stop = true; await loop; await responder.idle(); },
  };
}

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("the controller asks each host to clean the stores of finished attempts: a host cleans its own, says which it keeps none of, leaves a running attempt's alone, and one that cannot clean or cannot be asked keeps the attempt pending (card K06c)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1"), r2 = await c.host("r2");
      const m1 = machine(r1, join(dir, "m1"), { busy: [A2] }), m2 = machine(r2, join(dir, "m2"));
      m1.put(A1, 'keep one\nTHINK secret one\nkeep two\n'); m1.put(A2, "THINK of a running attempt\n");
      m2.put(A1, 'THINK on the other host\nkeep\n');
      const stores = new RemoteThinkingStores({ waitMs: 5000, hosts: async () => ({ ask: ["host:r1", "host:r2"], unreachable: [] }), ask: (h, rid, ids, w) => c.remote.askThinkingPurge(c.dispatcherPrincipal, h, rid, ids, { waitMs: w }) });
      const answer = await stores.purge([A1, A2, A3]);
      assert.deepEqual(answer.status, { [A1]: "purged", [A2]: "pending", [A3]: "none" });
      assert.equal(answer.blocks, 2);
      assert.equal(m1.read(A1), "keep one\nkeep two\n", "the host cleaned its own store and kept the rest");
      assert.equal(m2.read(A1), "keep\n", "and so did the other host, for the same attempt name");
      assert.ok(m1.read(A2).includes("THINK"), "a running attempt's store was not opened");
      assert.equal(m1.calls.some((d) => d.includes(A2)), false);
      assert.deepEqual(answer.problems, []);

      // A host that cannot rewrite one store: that attempt is pending, the others are done.
      const m3 = machine(await c.host("r3"), join(dir, "m3"), { failFor: A1 }); m3.put(A1, "THINK\n"); m3.put(A2, "THINK\nok\n");
      const one = new RemoteThinkingStores({ waitMs: 5000, hosts: async () => ({ ask: ["host:r3"], unreachable: [] }), ask: (h, rid, ids, w) => c.remote.askThinkingPurge(c.dispatcherPrincipal, h, rid, ids, { waitMs: w }) });
      const a3 = await one.purge([A1, A2]);
      assert.deepEqual(a3.status, { [A1]: "pending", [A2]: "purged" });

      // A host that cannot clean at all (started without the removal) refuses; a host that is unreachable or does not answer keeps everything pending.
      const m4 = machine(await c.host("r4"), join(dir, "m4"), { withPurge: false }); m4.put(A1, "THINK\n");
      const noPurge = new RemoteThinkingStores({ waitMs: 5000, hosts: async () => ({ ask: ["host:r4"], unreachable: [] }), ask: (h, rid, ids, w) => c.remote.askThinkingPurge(c.dispatcherPrincipal, h, rid, ids, { waitMs: w }) });
      const refused = await noPurge.purge([A1]);
      assert.deepEqual(refused.status, { [A1]: "pending" }); assert.match(refused.problems.join(" "), /cannot remove stored thinking/);
      assert.equal(m4.read(A1), "THINK\n", "nothing was done");
      const gone = new RemoteThinkingStores({ waitMs: 5000, hosts: async () => ({ ask: [], unreachable: [{ hostId: "host:gone", why: "it has not been heard from lately" }] }), ask: async () => { throw new Error("never asked"); } });
      assert.deepEqual((await gone.purge([A1])).status, { [A1]: "pending" }, "an unreachable host may hold the store: not clean");
      const quiet = await c.host("quiet");
      const silent = new RemoteThinkingStores({ waitMs: 300, hosts: async () => ({ ask: ["host:quiet"], unreachable: [] }), ask: (h, rid, ids, w) => c.remote.askThinkingPurge(c.dispatcherPrincipal, h, rid, ids, { waitMs: w }) });
      void quiet;
      const s = await silent.purge([A1]);
      assert.deepEqual(s.status, { [A1]: "pending" }); assert.match(s.problems.join(" "), /host:quiet/);
      // No host at all: nothing remote to clean.
      assert.deepEqual((await new RemoteThinkingStores({ hosts: async () => ({ ask: [], unreachable: [] }), ask: async () => { throw new Error("never"); } }).purge([A1])).status, { [A1]: "none" });
      // Together with this machine's own place.
      const both = combineThinkingStores(localThinkingStores({ source: { list: async () => [] }, purge: async () => ({ blocks: 0 }) }), stores)!;
      assert.deepEqual((await both.purge([A3])).status, { [A3]: "none" });
      await m1.stop(); await m2.stop(); await m3.stop(); await m4.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  suite("a request to clean stores is checked on both sides: only the owner or the dispatcher asks, only whole attempt IDs, at most 50 and no repeat; the host refuses names that are not attempts and a host without the removal does nothing (card K06c)", async (c) => {
    const dir = tmp();
    try {
      const r1 = await c.host("r1");
      const m = machine(r1, join(dir, "m"));
      m.put(A1, "THINK\nkeep\n");
      const ask = (ids: unknown, by = c.dispatcherPrincipal) => c.remote.askThinkingPurge(by, "host:r1", "wsr-aaaaaaaaaaaaaaaaaaaa", ids as never, { waitMs: 500 });
      for (const bad of [[], ["../x"], ["att-aaaaaaaaaaaaaaaaaaaa", "att-aaaaaaaaaaaaaaaaaaaa"], "att-aaaaaaaaaaaaaaaaaaaa", [7], Array.from({ length: 51 }, (_, i) => `att-${"a".repeat(18)}${"abcdefghijklmnopqrstuvwxyz234567"[i % 32]}${"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(i / 32)]}`), ["att-A"]]) await assert.rejects(ask(bad), /attemptIds|invalid/i, JSON.stringify(bad).slice(0, 60));
      await assert.rejects(c.remote.askThinkingPurge({ kind: "agent", id: "agent:ann", grants: [] } as never, "host:r1", "wsr-aaaaaaaaaaaaaaaaaaaa", [A1], { waitMs: 100 }), /may not do that/);
      await assert.rejects(c.remote.askThinkingPurge(c.dispatcherPrincipal, "host:r1", "not-a-request", [A1], { waitMs: 100 }), /requestId|invalid/i);
      assert.equal(m.read(A1), "THINK\nkeep\n", "refused requests changed nothing");
      // The host itself checks too: a forged ask with a path-shaped name cleans nothing.
      const forged = await m.host.answer({ requestId: "wsr-aaaaaaaaaaaaaaaaaaaa", operation: "pi-thinking-purge", taskId: "pi-state", projectId: "pi-state", reason: "x", quietAttempts: [], thinkingPurge: { attemptIds: ["../../etc"] } } as WorkspaceAsk);
      assert.equal(forged.ok, false);
      const empty = await m.host.answer({ requestId: "wsr-aaaaaaaaaaaaaaaaaaaa", operation: "pi-thinking-purge", taskId: "pi-state", projectId: "pi-state", reason: "x", quietAttempts: [] } as WorkspaceAsk);
      assert.equal(empty.ok, false);
      assert.equal(m.read(A1), "THINK\nkeep\n");
      await m.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("the request sets no field of the older operations: it carries the attempts and nothing else (card K06c)", () => {
  const ask: WorkspaceAsk = { requestId: "wsr-aaaaaaaaaaaaaaaaaaaa", operation: "pi-thinking-purge", taskId: "pi-state", projectId: "pi-state", reason: "x", quietAttempts: [], thinkingPurge: { attemptIds: [A1] } };
  assert.equal(ask.piState, undefined);
});
