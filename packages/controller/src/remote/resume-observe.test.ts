import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { ContinuationService, ResumeCheckService, resumeObserver, type ContinuationInput, type ResumePorts } from "../continuation/index.js";
import { DependencyService, observeEntries, type NewDependency, type Observation } from "../dependencies/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WorkspaceResponder } from "./responder.js";
import { observeOnHost } from "./observe.js";
import { remoteSuite, refuses } from "./testing/suite.js";
import type { RemoteHost } from "./testing/world.js";

after(stopServer);

// Card L04e: a remote host looks at a task's recorded files and directories on its own disk, so a resumed attempt's dependencies are observed (unchanged, changed, deleted, new members), not unknown, when the task is on a remote host.
// Over the real worker transport and the real dispatcher placement, on every storage backend.
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const MODEL = { provider: "local", id: "m1" };
const dg = (n: number): string => `v1:sha256:${n.toString(16).padStart(64, "0")}`;
const input = (n: number): ContinuationInput => ({
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" },
  checkpoint: { conversationId: 1, at: n, digest: dg(n), runtime: { name: "pi", version: "1" }, format: 1 },
  durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 0, remaining: 0, unit: "x" }, nextStep: "carry on" },
  manifest: { summaryLineage: [], sourceRanges: [], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: n, routingRevision: 0, environmentRevision: 0, adapter: { name: "pi", version: "1" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
});
let counter = 0;
const cid = (label: string): string => `${label}-${counter++}`;

/** A host's own disk: <root>/<task>/checkout holds the task's files, as the worker package lays them out. */
function disk(): { root: string; checkout(taskId: string): string; write(taskId: string, path: string, text: string): void; remove(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-obs-")));
  const checkout = (taskId: string): string => join(root, taskId, "checkout");
  return { root, checkout, write: (taskId, path, text) => { const full = join(checkout(taskId), path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, text); }, remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

/** What the host's program does: answers the controller's requests to look at files, over its own session, from its own disk. Returns what it was asked and a stop. */
function answering(host: RemoteHost, where: ReturnType<typeof disk>, options: { observe?: boolean } = {}) {
  const asked: { operation: string; entries: number; paths: readonly string[] | undefined }[] = [];
  const responder = new WorkspaceResponder({
    client: host.client, busy: () => [], port: { run: async () => ({ ok: false, reason: "not a workspace request" }) },
    ...(options.observe === false ? {} : { observe: (scope, entries, paths) => { asked.push({ operation: "observe", entries: entries.length, paths }); return observeEntries({ locate: (taskId) => ({ root: where.checkout(taskId), paths }) }, scope, entries); } }),
  });
  let live = true;
  const pump = (async () => { while (live) { try { responder.handle(await host.client.workspaceRequests()); } catch { /* the controller is closing */ } await new Promise((r) => setTimeout(r, 15)); } })();
  return { asked, stop: async () => { live = false; await pump; await responder.idle(); } };
}

for (const backend of backends) {
  const suite = remoteSuite(backend);
  const ports = (observe: ResumePorts["observe"]): ResumePorts => ({ observe, missingContext: async () => [], uncertainEffects: async () => [], review: async () => ({}) });

  suite("a task on a remote host: its recorded files and directories are looked at by that host on its own disk, and the resume check reads unchanged, changed, deleted and new members, never unknown (card L04e)", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { taskId } = await c.started(r1);
    assert.equal(((await c.storage.getAggregate({ kind: "task-placement", id: taskId }))?.body as { hostId?: string } | undefined)?.hostId, r1.id, "the dispatcher placed the task on host r1");
    const where = disk();
    const answerer = answering(r1, where);
    const deps = DependencyService.withEpoch(c.storage, c.epoch, c.options);
    try {
      where.write(taskId, "src/a.ts", "export const a = 1;\n");
      where.write(taskId, "src/b.ts", "export const b = 1;\n");
      where.write(taskId, "src/gone.ts", "export const gone = 1;\n");
      where.write(taskId, "docs/one.md", "one");
      where.write(taskId, "docs/two.md", "two");
      // A link in the checkout to a file of the host's disk outside it: never followed, so never claimed.
      writeFileSync(join(where.root, "outside.txt"), "host secret");
      // Windows without the right to make links: the case is left out there.
      let linked = true;
      try { symlinkSync(join(where.root, "outside.txt"), join(where.checkout(taskId), "src", "link.ts")); } catch { linked = false; }
      const recorded: NewDependency[] = [
        { kind: "file", key: "src/a.ts", hash: sha("export const a = 1;\n") },
        { kind: "file", key: "src/b.ts", hash: sha("export const b = 1;\n") },
        { kind: "file", key: "src/gone.ts", hash: sha("export const gone = 1;\n") },
        { kind: "directory", key: "docs", members: ["one.md", "two.md"] },
        { kind: "file", key: "../../outside.txt", hash: sha("x") },
        { kind: "file", key: "/etc/hostname", hash: sha("y") },
        { kind: "file", key: "src/link.ts", hash: sha("host secret") },
      ];
      await deps.record(c.owner, { commandId: cid("dep"), taskId, dependencies: recorded });
      // The work went on on host r1 after the checkpoint: one file changed, one was removed, a file joined the directory.
      where.write(taskId, "src/b.ts", "export const b = 2;\n");
      rmSync(join(where.checkout(taskId), "src/gone.ts"));
      where.write(taskId, "docs/three.md", "three");
      const faults: string[] = [];
      const placed = async (): Promise<string | undefined> => ((await c.storage.getAggregate({ kind: "task-placement", id: taskId }))?.body as { hostId?: string } | undefined)?.hostId;
      const observe = resumeObserver({
        manifest: (t) => deps.get(c.owner, t), placedHostOf: async () => await placed(), remoteHostIds: new Set([r1.id, r2.id]), binding: async () => undefined,
        remote: () => ({ remote: c.remote, by: c.dispatcherPrincipal }), onFault: (d) => faults.push(d),
      });
      // The checkpoint was taken on the host the work ran on; the check reads the files where they are.
      const continuations = ContinuationService.withEpoch(c.storage, c.epoch, c.options);
      await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(1) });
      const checks = ResumeCheckService.withEpoch(c.storage, c.epoch, { continuations, dependencies: deps, blockers: c.blockers, ports: ports(observe) }, c.options);
      const started = await checks.start(c.owner, { commandId: cid("s"), taskId, model: MODEL, after: "restart" });
      const status = Object.fromEntries((started.delta?.changed ?? []).map((i) => [i.key, i.status]));
      assert.equal(status["src/b.ts"], "changed", JSON.stringify(started.delta));
      assert.equal(status["src/gone.ts"], "deleted");
      assert.equal(status["docs"], "new-members");
      assert.equal(status["src/a.ts"], undefined, "an unchanged file is not listed as changed");
      assert.equal(started.delta?.unchanged, 1, "exactly the one file that did not change is unchanged");
      // Keys that name nothing inside the checkout are never looked at: they stay unknown, not unchanged.
      assert.equal(status["../../outside.txt"], "unknown");
      assert.equal(status["/etc/hostname"], "unknown");
      if (linked) assert.equal(status["src/link.ts"], "unknown", "a link out of the checkout is not followed, even with the right hash recorded");
      assert.ok(!Object.values(status).includes("unchanged"));
      // One look was asked of the host that holds the task's checkout. The host may carry the same request out twice when a poll that was already on its way returns it again just after the answer was sent (the responder's
      // behaviour for every request; the second answer is dropped by the controller), so this counts at least one look rather than exactly one.
      assert.ok(answerer.asked.length >= 1 && answerer.asked.every((a) => a.operation === "observe" && a.entries === recorded.length), JSON.stringify(answerer.asked));
      // Nothing of any file's text, and no path of the host's disk, was in anything the controller was told or logged.
      assert.equal(JSON.stringify(started).includes(where.root), false);
      assert.equal(JSON.stringify(faults).includes("export const"), false);
    } finally { await answerer.stop(); where.remove(); }
  });

  suite("a task placed on another remote host is asked of that host only; a host that has no checkout of the task, or does not answer, leaves every file unknown and the check still runs (card L04e)", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { taskId } = await c.started(r2);
    const where = disk();
    const first = answering(r1, where);
    const second = answering(r2, where);
    const deps = DependencyService.withEpoch(c.storage, c.epoch, c.options);
    try {
      where.write(taskId, "src/a.ts", "export const a = 1;\n"); // only r1's disk is shared in this test: r2 holds the task
      await deps.record(c.owner, { commandId: cid("dep"), taskId, dependencies: [{ kind: "file", key: "src/a.ts", hash: sha("export const a = 1;\n") }] });
      const observe = resumeObserver({ manifest: (t) => deps.get(c.owner, t), placedHostOf: async () => r2.id, remoteHostIds: new Set([r1.id, r2.id]), binding: async () => undefined, remote: () => ({ remote: c.remote, by: c.dispatcherPrincipal }) });
      const seen = await observe(taskId);
      assert.deepEqual(first.asked, [], "the other host was not asked");
      assert.ok(second.asked.length >= 1, "the host holding the task was asked (a poll already on its way may hand it the same request twice)");
      assert.deepEqual(Object.values(seen).map((o) => o.hash), [sha("export const a = 1;\n")]);
      // A task whose host has no checkout for it: nothing is read, nothing is claimed.
      const empty = disk();
      const none = resumeObserver({ manifest: (t) => deps.get(c.owner, t), placedHostOf: async () => r1.id, remoteHostIds: new Set([r1.id]), binding: async () => undefined, remote: () => ({ remote: c.remote, by: c.dispatcherPrincipal }) });
      await first.stop();
      const again = answering(r1, empty);
      try {
        assert.deepEqual(await none(taskId), {}, "the host looked and found no checkout: nothing is observed, so the check says unknown");
        const checks = await deps.check(c.owner, taskId, await none(taskId));
        assert.deepEqual(checks.map((k) => k.status), ["unknown"]);
      } finally { await again.stop(); empty.remove(); }
      // A host that does not answer in time: unobserved, never thrown, never "unchanged".
      const mute = await c.host("r3");
      const quiet = resumeObserver({ manifest: (t) => deps.get(c.owner, t), placedHostOf: async () => mute.id, remoteHostIds: new Set([mute.id]), binding: async () => undefined, remote: () => ({ remote: c.remote, by: c.dispatcherPrincipal }), remoteWaitMs: 60 });
      const faults: string[] = [];
      assert.deepEqual(await observeOnHost({ remote: c.remote, by: c.dispatcherPrincipal }, mute.id, { taskId, projectId: c.project }, [{ id: "dpm-1", kind: "file", key: "src/a.ts" }], undefined, { waitMs: 60, onFault: (d) => faults.push(d) }), {});
      assert.deepEqual(await quiet(taskId), {});
      assert.match(faults.join(" "), /did not answer/);
    } finally { await first.stop().catch(() => undefined); await second.stop(); where.remove(); }
  });

  suite("a host started without a look refuses it, saying so, and the files stay unknown; a request that is malformed or too big is refused before anything is sent (card L04e)", async (c) => {
    const r1 = await c.host("r1");
    const where = disk();
    const answerer = answering(r1, where, { observe: false });
    try {
      const faults: string[] = [];
      const got = await observeOnHost({ remote: c.remote, by: c.dispatcherPrincipal }, r1.id, { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project }, [{ id: "dpm-1", kind: "file", key: "a.txt" }], undefined, { waitMs: 5000, onFault: (d) => faults.push(d) });
      assert.deepEqual(got, {});
      assert.match(faults.join(" "), /cannot look at a task's files/);
      const ask = (entries: unknown, paths?: unknown) => c.remote.askObserve(c.dispatcherPrincipal, r1.id, `wsr-${"a".repeat(20)}`, { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project }, entries as never, paths as never, { waitMs: 50 });
      await refuses("invalid_command", () => ask([]));
      await refuses("invalid_command", () => ask(Array.from({ length: 21 }, (_, i) => ({ id: `d${i}`, kind: "file", key: "a" }))));
      await refuses("invalid_command", () => ask([{ id: "d1", kind: "search", key: "a" }]));
      await refuses("invalid_command", () => ask([{ id: "d1", kind: "file", key: "a\0b" }]));
      await refuses("invalid_command", () => ask([{ id: "d1", kind: "file", key: "a" }, { id: "d1", kind: "file", key: "b" }]));
      await refuses("invalid_command", () => ask([{ id: "d1", kind: "file", key: "a" }], Array.from({ length: 51 }, () => "docs")));
      await refuses("forbidden", () => c.remote.askObserve(r1.principal, r1.id, `wsr-${"b".repeat(20)}`, { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project }, [{ id: "d1", kind: "file", key: "a" }], undefined, { waitMs: 50 }));
    } finally { await answerer.stop(); where.remove(); }
  });

  suite("a host that cannot fit every answer in one reply is asked again for the rest, and one entry that can never fit is left unknown (card L04e)", async (c) => {
    const r1 = await c.host("r1");
    const where = disk();
    const task = "task-aaaaaaaaaaaaaaaaaaaa";
    const answerer = answering(r1, where);
    try {
      // Twenty directories of 28 long names each do not fit in one 4000-byte answer.
      const entries: { id: string; kind: "directory"; key: string }[] = [];
      for (let d = 0; d < 20; d++) {
        for (let n = 0; n < 28; n++) where.write(task, `dir${d}/${"n".repeat(40)}-${n}.txt`, "x");
        entries.push({ id: `dpm-${String(d).padStart(2, "0")}`, kind: "directory", key: `dir${d}` });
      }
      const got = await observeOnHost({ remote: c.remote, by: c.dispatcherPrincipal }, r1.id, { taskId: task, projectId: c.project }, entries, undefined, { waitMs: 20_000 });
      assert.equal(Object.keys(got).length, 20, `every directory was observed across several answers: ${Object.keys(got).length}`);
      assert.ok(answerer.asked.length >= 2, "more than one request was needed");
      assert.equal(got["dpm-07"]!.members!.length, 28);
      // One directory too big for any answer: left out, the others still come.
      for (let n = 0; n < 150; n++) where.write(task, `huge/${"m".repeat(60)}-${n}.txt`, "x");
      const mixed = await observeOnHost({ remote: c.remote, by: c.dispatcherPrincipal }, r1.id, { taskId: task, projectId: c.project }, [{ id: "dpm-aa", kind: "directory", key: "huge" }, { id: "dpm-bb", kind: "directory", key: "dir1" }], undefined, { waitMs: 20_000 });
      assert.equal(mixed["dpm-aa"], undefined, "an entry no answer can hold stays unknown");
      assert.equal(mixed["dpm-bb"]!.members!.length, 28);
    } finally { await answerer.stop(); where.remove(); }
  });
}
