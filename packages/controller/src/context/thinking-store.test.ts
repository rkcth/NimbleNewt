import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type World } from "../domain/testing/backends.js";
import { RETENTION_DEFAULTS, RetentionService } from "../retention/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { InspectionService, THINKING_COLLECT, ThinkingService, ThinkingStore, cleanThinking, type ReportedThinking } from "./index.js";

after(stopServer);

const DAY = 86_400_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const AWS = "AKIAABCDEFGHIJKLMNOP";
const RLO = String.fromCharCode(0x202e); const ZW = String.fromCharCode(0x200b); const NEL = String.fromCharCode(0x85);
const rep = (entryId: number, text: string, extra: Partial<ReportedThinking> = {}): ReportedThinking => ({ entryId, block: 0, provider: "llama", model: "local-m", text, opaque: false, ...extra });

// Card U09b: the thinking a worker reports is kept by the controller, bounded and cleaned, switchable by the owner, read only by the owner, and removed by retention.
test("cleanThinking: control and invisible characters go, credentials are hidden before the cut, the cut is at a character boundary, and an enormous input is bounded first", () => {
  const dirty = cleanThinking(["line one\r\nline", String.fromCharCode(0), " two", RLO, "reversed", ZW, " hidden", String.fromCharCode(27), "[31m red\ttab", NEL, " end"].join(""));
  assert.equal(dirty.text, "line one\nline tworeversed hidden[31m red\ttab end");
  assert.equal(dirty.truncated, false);
  const key = cleanThinking(`use ${AWS} for the test`);
  assert.equal(key.redacted, true);
  assert.ok(!key.text.includes(AWS), key.text);
  // A secret broken up by invisible characters is still found: they are removed before the scan.
  assert.ok(!cleanThinking(`AKIA${ZW}ABCDEFGHIJKLMNOP`).text.includes("ABCDEFGHIJKLMNOP"));
  // So is one split by invisible tag characters, variation selectors or a combining grapheme joiner.
  for (const cp of [0xe0041, 0xe0020, 0xfe0f, 0x34f, 0x3164]) {
    const split = cleanThinking(`key AKIAABCD${String.fromCodePoint(cp)}EFGHIJKLMNOP done`);
    assert.ok(!split.text.includes("EFGHIJKLMNOP") && split.redacted, `split by U+${cp.toString(16)}: ${split.text}`);
  }
  // The rest of a private key whose BEGIN line was in the previous block is hidden too, with whatever came before its END line.
  const tail = cleanThinking("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabc==\n-----END PRIVATE KEY-----\nthen I will run the tests");
  assert.equal(tail.text, "[redacted]\nthen I will run the tests");
  assert.equal(tail.redacted, true);
  assert.equal(cleanThinking("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- after").text, "[redacted] after", "a whole key is hidden as before");
  // A secret across the cut is replaced whole, never shown as a prefix.
  const edge = cleanThinking(`${"x".repeat(THINKING_COLLECT.blockChars - 9)} ${AWS}`);
  assert.ok(!edge.text.includes("AKIAABCD"), "no prefix of the credential survives the cut");
  const wide = cleanThinking("😀".repeat(THINKING_COLLECT.blockChars));
  assert.equal(wide.truncated, true);
  assert.ok(wide.text.length <= THINKING_COLLECT.blockChars);
  assert.doesNotMatch(wide.text, /[\ud800-\udbff]$/);
  const huge = cleanThinking("a".repeat(5_000_000));
  assert.equal(huge.text.length, THINKING_COLLECT.blockChars);
  assert.equal(huge.truncated, true);
});

for (const backend of backends) {
  interface Ctx {
    world: World; owner: Principal; project: string; ta: string; tb: string; tLive: string; ann: Principal; ben: Principal; service: Principal; host: Principal; other: Principal;
    store: ThinkingStore; thinking: ThinkingService; box: { at: number }; end: (task: string, to: "done" | "cancelled") => Promise<void>;
    retention: (extra?: object) => RetentionService; epoch: number;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const box = { at: Date.parse("2026-10-01T10:00:00.000Z") };
        const options = { clock: () => new Date(box.at).toISOString(), pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const make = async (kind: "agent" | "service" | "host", name: string, grants: Grant[] = []) => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name, grants });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${name}`)).token);
        };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const mk = async (title: string) => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
        const ta = await mk("task a"); const tb = await mk("task b"); const tLive = await mk("running task");
        const end = async (task: string, to: "done" | "cancelled"): Promise<void> => {
          const path = to === "done" ? ["ready", "in_progress", "done"] : ["cancelled"];
          for (const step of path) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: step as never });
        };
        const store = ThinkingStore.withEpoch(world.storage, epoch, options);
        const inspection = InspectionService.withEpoch(world.storage, epoch, options);
        const retention = (extra: object = {}) => RetentionService.withEpoch(world.storage, epoch, { settings: { effective: async () => ({ ...RETENTION_DEFAULTS, reserveBytes: 0 }) }, now: () => box.at, ...extra } as never, options);
        await body({
          world, owner, project, ta, tb, tLive, store, box, end, retention, epoch, thinking: ThinkingService.withEpoch(world.storage, epoch, store.source(), inspection, options),
          ann: await make("agent", "ann", [{ action: "desk.read", project }]), ben: await make("agent", "ben", [{ action: "desk.read", project }]),
          service: await make("service", "recovery", [{ action: "recovery.read", project: "*" }]), host: await make("host", "h1"), other: await make("service", "dispatcher"),
        });
      } finally { await world.close(); }
    });
  const put = (c: Ctx, task: string, blocks: ReportedThinking[], extra: { attemptId?: string; agent?: string; by?: Principal } = {}) =>
    c.store.record(extra.by ?? c.host, { projectId: c.project, taskId: task, agent: extra.agent ?? "agent:ann", attemptId: extra.attemptId ?? "att-1", blocks });
  const look = (c: Ctx, who: Principal, task: string, extra: Record<string, unknown> = {}) => c.thinking.read(who, { commandId: cid("r"), projectId: c.project, taskId: task, reason: "checking what the model was weighing", ...extra });

  suite("who may record: only the controller side (a host or a service); an agent, even the one whose thinking it is, cannot write or overwrite it", async (c) => {
    await refuses("forbidden", () => put(c, c.ta, [rep(1, "my own thought")], { by: c.ann }));
    await refuses("forbidden", () => put(c, c.ta, [rep(1, "faked")], { by: c.owner }));
    assert.deepEqual(await put(c, c.ta, [rep(1, "from the worker")], { by: c.host }), { kept: 1 });
    assert.deepEqual(await put(c, c.tb, [rep(1, "from a service")], { by: c.other }), { kept: 1 });
    assert.deepEqual((await look(c, c.owner, c.ta)).blocks?.map((b) => b.text), ["from the worker"]);
  });

  suite("input is checked: shape, ids, block count, unknown fields and non-text are refused and nothing is kept", async (c) => {
    const bad = async (blocks: unknown, extra: Record<string, unknown> = {}) => refuses("invalid_command", () => c.store.record(c.host, { projectId: c.project, taskId: c.ta, agent: "agent:ann", attemptId: "att-1", blocks: blocks as never, ...extra }));
    await bad([]);
    await bad(Array.from({ length: THINKING_COLLECT.blocksPerMessage + 1 }, (_, i) => rep(i, "x")));
    await bad([{ ...rep(1, "x"), extra: 1 }]);
    await bad([rep(-1, "x")]); await bad([rep(1.5, "x")]); await bad([{ ...rep(1, "x"), text: 5 }]); await bad([{ ...rep(1, "x"), opaque: "no" }]);
    await bad([rep(1, "x", { model: "" })]); await bad([rep(1, "x", { provider: "p".repeat(81) })]); await bad(["text"]);
    await bad([rep(1, "x")], { projectId: "nope" }); await bad([rep(1, "x")], { taskId: "nope" }); await bad([rep(1, "x")], { agent: "" }); await bad([rep(1, "x")], { attemptId: "a".repeat(201) });
    assert.equal(await c.store.summary(c.owner, c.ta), undefined, "nothing was kept");
    assert.equal((await put(c, c.ta, Array.from({ length: THINKING_COLLECT.blocksPerMessage }, (_, i) => rep(i, `t${i}`)))).kept, THINKING_COLLECT.blocksPerMessage, "the largest message passes");
  });

  suite("what is kept is cleaned, redacted and bounded; the stored record never holds a credential, a control character or more than the bound", async (c) => {
    await put(c, c.ta, [rep(1, `read the file${String.fromCharCode(0)}${RLO} then use ${AWS} in the test`), rep(2, "z".repeat(50_000)), rep(3, "secret words nobody may read", { opaque: true })]);
    const page = (await look(c, c.owner, c.ta)).blocks!;
    assert.match(page[0]!.text, /\[redacted\]/, "the credential is replaced by the marker");
    assert.ok(!page[0]!.text.includes(AWS) && !page[0]!.text.includes(RLO) && !page[0]!.text.includes(String.fromCharCode(0)), page[0]!.text);
    assert.equal(page[1]!.text.length, THINKING_COLLECT.blockChars);
    assert.deepEqual([page[2]!.opaque, page[2]!.text], [true, ""], "an opaque block carries no text, whatever the process sent");
    const raw = JSON.stringify(await c.world.storage.getAggregate({ kind: "thinking-record", id: (await c.world.storage.listAggregates("thinking-record", { limit: 10 }))[0]!.id }));
    assert.ok(!raw.includes(AWS) && !raw.includes("secret words"), "not in storage either");
    assert.ok(raw.length < 3 * (THINKING_COLLECT.blockChars + 1000), `a bounded record: ${raw.length}`);
  });

  suite("the record keeps the newest blocks within its bound, counts the rest, and the owner's cursor never repeats or skips a number", async (c) => {
    for (let at = 0; at < 6; at++) await put(c, c.ta, Array.from({ length: 50 }, (_, i) => rep(at * 50 + i, `t${at * 50 + i}`)));
    assert.deepEqual(await c.store.summary(c.owner, c.ta), { kept: THINKING_COLLECT.blocksKept, dropped: 100, updatedAt: "2026-10-01T10:00:00.000Z" });
    const seen: string[] = [];
    let cursor: { entryId: number; block: number } | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const p = await look(c, c.owner, c.ta, { limit: 75, ...(cursor === undefined ? {} : { after: cursor }) });
      seen.push(...p.blocks!.map((b) => b.text));
      cursor = p.next;
      if (cursor === undefined) break;
    }
    assert.equal(seen.length, 200);
    assert.deepEqual([seen[0], seen[199]], ["t100", "t299"], "the newest 200, in order");
    assert.equal(new Set(seen).size, 200);
  });

  suite("full-size blocks: the record stays within the storage's body limit (newest kept, the rest counted), so collection never stops because the record grew too big", async (c) => {
    // Three-byte characters at the full block length: one message of 50 such blocks alone is far over the storage's 256 KB body limit.
    const wide = (i: number) => `${i} ${"思".repeat(THINKING_COLLECT.blockChars)}`;
    let total = 0;
    for (let at = 0; at < 6; at++) {
      const r = await put(c, c.ta, Array.from({ length: 50 }, (_, i) => rep(at * 50 + i, at % 2 === 0 ? wide(at * 50 + i) : `${at * 50 + i} ${"x".repeat(5000)}`)));
      assert.equal(r.kept, 50, `message ${at} was kept`);
      total += 50;
    }
    const s = (await c.store.summary(c.owner, c.ta))!;
    assert.equal(s.kept + s.dropped, total, "every block is either kept or counted");
    assert.ok(s.kept >= 1 && s.kept <= THINKING_COLLECT.blocksKept);
    const raw = await c.world.storage.getAggregate({ kind: "thinking-record", id: derivedId("tkr", `record\0${c.ta}`) });
    assert.ok(raw !== undefined && Buffer.byteLength(JSON.stringify(raw.body), "utf8") <= THINKING_COLLECT.recordBytes + 16 * 1024, "the stored record is bounded in bytes");
    const p = await look(c, c.owner, c.ta, { limit: 200 });
    assert.equal(p.blocks!.length, s.kept);
    assert.ok(p.blocks![p.blocks!.length - 1]!.text.startsWith("299 "), "the newest block is kept");
    // A later short block is still collected.
    assert.deepEqual(await put(c, c.ta, [rep(1000, "still collecting")]), { kept: 1 });
  });

  suite("replay safety: the same message again keeps nothing more, an overlapping one keeps only what is new, an older attempt's numbers do not hide a newer attempt's, and a racing writer loses nothing", async (c) => {
    const first = [rep(1, "a"), rep(2, "b")];
    assert.deepEqual(await put(c, c.ta, first), { kept: 2 });
    assert.deepEqual(await put(c, c.ta, first), { kept: 0, reason: "nothing-new" });
    assert.deepEqual(await put(c, c.ta, [rep(2, "b"), rep(3, "c")]), { kept: 1 }, "entry 2 was kept already");
    assert.deepEqual(await put(c, c.ta, [rep(3, "c"), rep(3, "c again")]), { kept: 0, reason: "nothing-new" }, "a lower or equal position from the same attempt is skipped");
    assert.deepEqual(await put(c, c.ta, [{ ...rep(3, "second of entry 3"), block: 1 }, { ...rep(3, "second of entry 3"), block: 1 }]), { kept: 1 }, "a block of an entry is kept once, even twice in a message");
    assert.deepEqual(await put(c, c.ta, [rep(1, "new attempt, own numbering")], { attemptId: "att-2" }), { kept: 1 });
    // Two writers at once (two attempts' reports): every block is kept exactly once.
    await Promise.all([put(c, c.tb, [rep(1, "x1"), rep(2, "x2")], { attemptId: "att-a" }), put(c, c.tb, [rep(1, "y1"), rep(2, "y2")], { attemptId: "att-b" })]);
    const texts = (await look(c, c.owner, c.tb)).blocks!.map((b) => b.text).sort();
    assert.deepEqual(texts, ["x1", "x2", "y1", "y2"]);
    const all = (await look(c, c.owner, c.ta)).blocks!;
    assert.deepEqual(all.map((b) => b.entryId), [0, 1, 2, 3, 4], "numbers are the order of keeping and never repeat");
    // A message is a command: sending it again after the record changed is answered, not applied twice.
    const before = await c.store.summary(c.owner, c.ta);
    await put(c, c.ta, first);
    assert.deepEqual(await c.store.summary(c.owner, c.ta), before);
  });

  suite("the owner's switch: on by default; off keeps nothing new and leaves what was kept; only the owner changes it; a stale revision is refused; on again collects again", async (c) => {
    assert.deepEqual(await c.store.collection(c.owner), { enabled: true, revision: 0 });
    await put(c, c.ta, [rep(1, "before the switch")]);
    for (const who of [c.ann, c.service, c.host]) await refuses("forbidden", () => c.store.setCollection(who, { commandId: cid("s"), enabled: false }));
    await refuses("forbidden", () => c.store.collection(c.ann));
    await refuses("invalid_command", () => c.store.setCollection(c.owner, { commandId: cid("s"), enabled: "no" as never }));
    await refuses("invalid_command", () => c.store.setCollection(c.owner, { commandId: cid("s"), enabled: false, extra: 1 } as never));
    const off = await c.store.setCollection(c.owner, { commandId: cid("off"), enabled: false });
    assert.deepEqual(await c.store.collection(c.owner), { enabled: false, revision: off.revision });
    assert.deepEqual(await put(c, c.ta, [rep(2, "while off")]), { kept: 0, reason: "off" });
    assert.deepEqual(await put(c, c.tb, [rep(1, "also off")]), { kept: 0, reason: "off" });
    assert.equal(await c.store.summary(c.owner, c.tb), undefined, "nothing is created while off");
    assert.deepEqual((await look(c, c.owner, c.ta)).blocks?.map((b) => b.text), ["before the switch"], "what was kept stays readable");
    await refuses("stale_revision", () => c.store.setCollection(c.owner, { commandId: cid("s"), enabled: true, expectedRevision: off.revision + 5 }));
    await refuses("stale_revision", () => c.store.setCollection(c.owner, { commandId: cid("s"), enabled: true }));
    await c.store.setCollection(c.owner, { commandId: cid("on"), enabled: true, expectedRevision: off.revision });
    assert.deepEqual(await put(c, c.ta, [rep(3, "after")]), { kept: 1 });
    // The same command again is answered, not applied twice.
    const cmd = cid("twice");
    const rev = (await c.store.collection(c.owner)).revision;
    const first = await c.store.setCollection(c.owner, { commandId: cmd, enabled: false, expectedRevision: rev });
    assert.equal((await c.store.setCollection(c.owner, { commandId: cmd, enabled: false, expectedRevision: rev })).replayed, true);
    assert.equal((await c.store.collection(c.owner)).revision, first.revision);
  });

  suite("who may read: only the owner, through ThinkingService; an agent (even the one whose thinking it is, or another agent), a service and a host get the answer for a task with none", async (c) => {
    await put(c, c.ta, [rep(1, "ann's private weighing")], { agent: "agent:ann" });
    await put(c, c.tb, [rep(1, "ben's private weighing")], { agent: "agent:ben" });
    const answers: string[] = [];
    for (const who of [c.ann, c.ben, c.service, c.host, c.other]) {
      for (const task of [c.ta, c.tb]) await refuses("not_found", () => look(c, who, task), (e) => answers.push(e.message));
    }
    assert.equal(new Set(answers).size, 1, "one answer for everybody who may not read, and for a task with none");
    await refuses("not_found", () => look(c, c.owner, c.tLive), (e) => assert.equal(e.message, answers[0]));
    assert.deepEqual((await look(c, c.owner, c.ta)).blocks?.map((b) => b.text), ["ann's private weighing"]);
    // A task is not read through another project's id.
    await refuses("not_found", () => c.thinking.read(c.owner, { commandId: cid("r"), projectId: "proj-aaaaaaaaaaaaaaaaaaaa", taskId: c.ta, reason: "wrong project" }));
    // The agent whose thinking it was sees that the owner looked (and not what); the other agent does not.
    assert.deepEqual((await c.thinking.looks(c.ann)).items.map((l) => [l.taskId, l.returned]), [[c.ta, 1]]);
    assert.deepEqual((await c.thinking.looks(c.ben)).items, [], "ben's thinking was not looked at, and ann's look is not his to see");
    // Nothing the store hands out is a way around the service: its read-only calls for an agent say nothing.
    assert.equal(await c.store.summary(c.ann, c.ta), undefined);
    assert.equal(await c.store.summary(c.host, c.ta), undefined);
  });

  suite("the inspection policy still decides: when the owner denied reading agents' private records, the kept thinking is not shown", async (c) => {
    await put(c, c.ta, [rep(1, "kept")]);
    await InspectionService.withEpoch(c.world.storage, c.epoch, { clock: () => new Date(c.box.at).toISOString() }).setPolicy(c.owner, { commandId: cid("p"), scratch: "denied" });
    await refuses("forbidden", () => look(c, c.owner, c.ta));
  });

  suite("retention: thinking of a finished task goes after thinkingDays and leaves a marker; a running task, a young record and a task finished recently keep theirs; nothing more is collected afterwards", async (c) => {
    await put(c, c.ta, [rep(1, "old and finished")]);
    await put(c, c.tb, [rep(1, "old but cancelled recently")]);
    await put(c, c.tLive, [rep(1, "old but still running")]);
    await c.end(c.ta, "done");
    c.box.at += 20 * DAY;
    await c.end(c.tb, "cancelled");                               // finished 20 days after the thinking, just now
    c.box.at += 3 * DAY;                                          // ta ended 23 days ago, tb 3 days ago
    const status = await c.retention().status(c.owner);
    assert.equal((status.growth as Record<string, unknown>)["thinking-record"], 3, "the owner sees how many records are kept");
    const preview = await c.retention().run(c.owner, {});
    assert.deepEqual(preview.candidates.map((x) => [x.kind, x.ageDays >= 22]), [["thinking-record", true]], "only the old record of the task that ended long ago");
    assert.equal((await look(c, c.owner, c.ta)).blocks?.length, 1, "a preview removes nothing");
    await assert.rejects(c.retention().run(c.owner, { dryRun: false }), /confirm/i);
    const run = await c.retention().run(c.owner, { dryRun: false, confirm: preview.digest! });
    assert.equal(run.removed, 1);
    // Marker: the text is gone, who/what/when stay, the source says there is none and the replay marker says retention removed it.
    await refuses("not_found", () => look(c, c.owner, c.ta));
    assert.equal(await c.store.removedAt({ projectId: c.project, taskId: c.ta }), new Date(c.box.at).toISOString());
    assert.equal(await c.store.removedAt({ projectId: c.project, taskId: c.tb }), undefined);
    const stub = JSON.stringify((await c.world.storage.listAggregates("thinking-record", { limit: 10 })).find((a) => (a.body as { taskId?: string }).taskId === c.ta));
    assert.ok(!stub.includes("old and finished"), "the text is gone from storage");
    assert.deepEqual(await c.store.summary(c.owner, c.ta), { kept: 0, dropped: 1, updatedAt: new Date(c.box.at).toISOString(), removedAt: new Date(c.box.at).toISOString() });
    // Nothing more is collected for a task whose thinking was removed (a late report of a finished task).
    assert.deepEqual(await put(c, c.ta, [rep(9, "late")]), { kept: 0, reason: "removed" });
    assert.equal((await c.retention().run(c.owner, {})).candidates.length, 0, "the marker is not a candidate again");
    // The audit names the rule and the record, never the text.
    const audit = (await c.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "retention.expire");
    assert.equal(audit.length, 1);
    assert.equal((audit[0]!.detail as { rule?: string }).rule, "thinking-days");
    assert.ok(!JSON.stringify(audit).includes("old and finished"));
    // Later: the cancelled task's thinking is old enough too, the running one never is until it ends.
    c.box.at += 15 * DAY;
    assert.deepEqual((await c.retention().run(c.owner, {})).candidates.map((x) => x.id).length, 1);
    await c.end(c.tLive, "done");
    assert.equal((await c.retention().run(c.owner, {})).candidates.length, 1, "the finished task is not old enough yet; only the cancelled one is due");
    c.box.at += 15 * DAY;
    assert.equal((await c.retention().run(c.owner, {})).candidates.length, 2);
    // A shorter setting brings the date forward; a record changed since the preview is skipped.
    const short = (v: number) => c.retention({ settings: { effective: async () => ({ ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingDays: v }) } });
    assert.equal((await short(365).run(c.owner, {})).candidates.length, 0);
    const p2 = await short(14).run(c.owner, {});
    await put(c, c.tLive, [rep(2, "changed after the preview")]);
    const done = await short(14).run(c.owner, { dryRun: false, confirm: p2.digest! }).catch((e: DomainError) => e);
    assert.ok(done instanceof DomainError ? /confirm|preview/i.test(done.message) : done.removed <= 1, "a changed set is refused or the changed record skipped");
    assert.equal((await look(c, c.owner, c.tLive)).blocks?.length, 2, "the record that changed after the preview is kept");
  });
}
