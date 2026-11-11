import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { OPERATIONS } from "../api/operations.js";
import { StatusService, STATUS_KINDS } from "../status/index.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// Card K06d: the owner asks in their own words how much room is left, which quotas are near, which backups are kept and what retention deleted lately.

after(stopServer);

const ask = (request: Record<string, unknown>, evidence: string, basis = "owner") => ({ kind: "status", request, evidence, basis });

test("the interpreter prompt tells the model the retention view answers room, reserve, quota, backup and deletion questions, from the one status-kind table; the API's table says the same (card K06d)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "how much room is left", quoted: [], focus: {}, proposals: [] });
  const kind = STATUS_KINDS["retention"]!;
  assert.deepEqual(kind.keys, [], "it takes no arguments");
  assert.ok(system.includes(`retention(${kind.keys.join(", ")}) - ${kind.about}`), "listed from the one table");
  for (const word of ["free room", "reserve", "quotas", "backups", "latest", "deletions", "how much room is left", "which quotas are near their limit", "which backups are kept", "what retention deleted lately"]) assert.ok(kind.about.includes(word), word);
  const op = OPERATIONS.find((o) => o.name === "status.ask")!;
  assert.ok(op.summary.includes("same state as `retention.status`"), "the API summary says what the kind now answers");
  assert.ok(OPERATIONS.some((o) => o.name === "retention.status" && o.kind === "query"));
});

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, status: StatusService) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const w = await openWorld(backend, script);
      try {
        const epoch = w.projects.epoch;
        const waits = WaitService.withEpoch(w.world.storage, epoch, w.assignments, options);
        const blockers = BlockerService.withEpoch(w.world.storage, epoch, options);
        const answer = { disk: { freeBytes: 1_000_000_000, totalBytes: 4_000_000_000, reserve: { wantedBytes: 16_777_216, inUse: false, short: false } }, quotaLimits: { projectBytes: 2048, agentBytes: null, warnPercent: 80 }, quotaUsage: { project: { quota: 2048, scopes: 1, totalBytes: 1900, top: [{ id: "proj-a", used: 1900 }] } }, quotas: [{ scope: "project", id: "proj-a", used: 1900, quota: 2048, percent: 92, level: "warn" }], backups: { configured: true, count: 2, untrusted: 0, latest: { name: "backup-1", at: "2026-10-21T01:00:00.000Z", trusted: true }, counts: { daily: 7, weekly: 4 } }, deletions: [{ id: "rtd-1", recordId: "dsk-1", at: "2026-10-20T01:00:00.000Z", status: "deleted", derived: { copies: ["x"] } }], runs: [] };
        const retention = { check: async () => ({ retained: false, reasons: [] as string[] }), settings: async () => ({ revision: 1, settings: {}, effective: { derivedDays: 30 } }), status: async () => answer };
        const status = StatusService.withEpoch(w.world.storage, epoch, { assignments: w.assignments, waits, blockers, contracts: w.contracts, retention }, options);
        await body(w, script, status);
      } finally { await w.close(); }
    });

  suite("the owner asks about room, quotas, backups and deletions in free words and each is answered from the one retention view, every line citing its records, with nothing written", async (w, script, status) => {
    const chat = w.chat({ status });
    const audit = async () => (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((x) => !x.type.startsWith("chat.")).length;
    const before = await audit();
    const questions = ["how much room have I got left on the disk?", "which quotas are close to full", "do we have backups, and when was the last one", "what did retention throw away lately", "is the safety reserve still there"];
    for (const text of questions) script[text] = [ask({ kind: "retention" }, text)];
    for (const text of questions) {
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      const o = r.outcomes[0]!;
      assert.equal(o.status, "answered", JSON.stringify(o));
      assert.ok(o.lines!.every((l) => l.cites.length > 0), "every line cites a record");
      const said = o.lines!.map((l) => l.text).join("\n");
      assert.match(said, /The data disk has 953\.7 MiB free of 3\.73 GiB \(25% free\)\./);
      assert.match(said, /16\.0 MiB is set aside as the reserve/);
      assert.match(said, /Project proj-a is at 92% of its storage quota/);
      assert.match(said, /The latest backup is backup-1/);
      assert.match(said, /Deletion rtd-1 of record dsk-1: deleted/);
      assert.match(r.reply.join("\n"), /^As of /);
    }
    assert.equal(await audit(), before, "no record changed");
    // The kind takes no arguments: a model that adds one gets a refusal, not a guess.
    script["how much room, in project X"] = [ask({ kind: "retention", projectId: "p1" }, "how much room, in project X")];
    const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text: "how much room, in project X" });
    assert.notEqual(r.outcomes[0]!.status, "answered", JSON.stringify(r.outcomes[0]));
  });
}
