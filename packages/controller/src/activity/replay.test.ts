import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { StatusService } from "../status/status.js";
import { ActivityService, REPLAY_LABELS, ReplayService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-30T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); return true; });
};

/** The storage with every write counted: a replay must make none (no effect, no delivery, no timer, no record). */
const counting = (storage: ControllerStorage): { storage: ControllerStorage; writes: () => number } => {
  let writes = 0;
  const proxy = new Proxy(storage, { get(target, key) {
    const value = (target as never)[key] as unknown;
    if (key === "applyOperation") return (...args: unknown[]) => { writes++; return (value as (...a: unknown[]) => unknown).apply(target, args); };
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } });
  return { storage: proxy, writes: () => writes };
};

for (const backend of backends) {
  test(`${backend.name}: replay of a task's activity is read only and shows what was recorded`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const make = async (nm: string, grants: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const elsewhere = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "B" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
      const foreign = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: elsewhere, title: "other" })).id;
      const worker = await make("ann", [{ action: "attempt.work", project }]);
      const auditor = await make("aud", [{ action: "history.read", project }]);
      const stranger = await make("zed", [{ action: "task.read", project }]);
      const svc = ActivityService.withEpoch(world.storage, projects.epoch, options);
      const rec = (by: Parameters<typeof svc.record>[0], c: Omit<Parameters<typeof svc.record>[1], "commandId" | "taskId">, t = task) => svc.record(by, { commandId: cid("r"), taskId: t, ...c } as never);

      // A task with a provider switch, a compressed history, a failed tool, a branch and a later owner correction.
      await rec(owner, { kind: "instruction", summary: "fix the login bug", outcome: "confirmed", manifest: { refs: [{ kind: "message", id: "msg-1", version: "1" }] } });                                    // 1
      await rec(worker, { kind: "model-selected", summary: "chose model A", outcome: "confirmed", manifest: { refs: [{ kind: "summary", id: "sum-1", version: "3" }], summaryId: "sum-1" } });             // 2
      await rec(worker, { kind: "compression", summary: "compressed earlier history", outcome: "confirmed", manifest: { missing: true, reason: "the compressor kept no manifest" } });                    // 3
      await rec(worker, { kind: "model-selected", summary: "switched to model B", outcome: "confirmed", manifest: { refs: [{ kind: "summary", id: "sum-2", version: "1" }], summaryId: "sum-2" } });     // 4
      await rec(worker, { kind: "tool-call", summary: "ran the tests", outcome: "dispatched", payload: { text: "run: npm test; token sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234" } });                          // 5
      await rec(worker, { kind: "tool-call", summary: "ran the tests (no answer came back)", outcome: "uncertain" });                                                                                 // 6
      await rec(worker, { kind: "branch", summary: "tried a second fix on a side line", branch: "fix-b", outcome: "proposed" });                                                                      // 7
      await rec(worker, { kind: "tool-call", summary: "side line: edited auth.ts", branch: "fix-b", outcome: "confirmed" });                                                                           // 8
      await rec(worker, { kind: "tool-call", summary: "main line: edited session.ts", outcome: "confirmed" });                                                                                          // 9
      await rec(worker, { kind: "lifecycle", summary: "decided to deploy at once", outcome: "proposed" });                                                                                              // 10
      await rec(owner, { kind: "owner-message", summary: "no, do not deploy; wait for review", outcome: "confirmed", supersedes: 10, payload: { text: "please wait", sensitive: false } });                 // 11
      await rec(worker, { kind: "tool-call", summary: "sensitive step", payload: { text: "private content" } });                                                                                        // 12
      await rec(worker, { kind: "tool-call", summary: "a step later lost", outcome: "confirmed" });                                                                                                     // 13
      await svc.markUnavailable(owner, { commandId: cid("u"), taskId: task, first: 13, last: 13, reason: "archived by retention" });
      await svc.explain(worker, { commandId: cid("x"), taskId: task, seq: 4, choice: "switch to model B", alternatives: [{ option: "stay on A", whyNot: "A is rate limited" }], evidence: [{ statement: "A returned 429", ref: { kind: "tool-call", id: "call-9" } }], uncertainty: "B may be slower" });
      await svc.explainLater(auditor, { commandId: cid("l"), taskId: task, seq: 2 });
      await svc.correct(owner, { commandId: cid("k"), taskId: task, seq: 6, note: "the tests did run; the answer was lost on the way back" });
      await rec(owner, { kind: "owner-message", summary: "another project's note" }, foreign);

      // Everything below is read through a storage that counts writes.
      const spy = counting(world.storage);
      const reads = ActivityService.withEpoch(spy.storage, projects.epoch, options);
      const thinkingReads: unknown[] = [];
      const replay = ReplayService.withEpoch(spy.storage, projects.epoch, reads, { thinking: { read: async (_by, c) => { thinkingReads.push(c); return { blocks: [{ entryId: 1, block: 0, provider: "p", model: "m", text: "I think the key is sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234", opaque: false, redacted: false }], lookId: "tlk-x", replayed: false }; } }, thinkingRemoval: { removedAt: async (t) => (t.taskId === task && removed ? "2026-11-20T00:00:00.000Z" : undefined) } }, options);
      let removed = false;

      const view = await replay.open(auditor, task);
      assert.equal(view.summary.total, 13);
      assert.deepEqual(view.summary.lanes, [{ lane: "main", steps: 10 }, { lane: "fix-b", steps: 2 }], "the lost step has no known lane");
      assert.equal(view.note, REPLAY_LABELS.concurrent, "concurrent branches are said to be side by side");
      assert.deepEqual(view.summary.unavailable, [{ seq: 13, reason: "archived by retention" }]);
      assert.equal(view.summary.superseded, 1);
      assert.equal(view.summary.stepsWithoutManifest > 0, true);
      const steps = view.entries.filter((e): e is Extract<typeof e, { lane: string }> => "lane" in e);
      const bySeq = (s: number) => steps.find((e) => e.seq === s)!;
      // Proposed, dispatched, confirmed and uncertain are distinct; an outcome nobody wrote is "not recorded", never "confirmed".
      assert.deepEqual([bySeq(7).outcome, bySeq(5).outcome, bySeq(2).outcome, bySeq(6).outcome, bySeq(12).outcome], ["proposed", "dispatched", "confirmed", "uncertain", "not-recorded"]);
      // The versions used then, as recorded; a missing manifest is marked.
      assert.deepEqual(bySeq(2).versionsThen, { state: "recorded", refs: [{ kind: "summary", id: "sum-1", version: "3" }], summaryId: "sum-1" });
      assert.deepEqual(bySeq(4).versionsThen, { state: "recorded", refs: [{ kind: "summary", id: "sum-2", version: "1" }], summaryId: "sum-2" });
      assert.equal(bySeq(3).versionsThen.state, "not-recorded");
      // Branch lanes: a side-line step is on its lane with its own neighbours, not in the sequence of the main line.
      assert.equal(bySeq(8).lane, "fix-b");
      assert.equal(bySeq(8).previousInLane, 7);
      assert.equal(bySeq(8).nextInLane, undefined);
      assert.equal(bySeq(9).previousInLane, 6);
      assert.deepEqual((await replay.open(auditor, task, { lane: "fix-b" })).entries.map((e) => e.seq), [7, 8]);
      assert.deepEqual((await replay.open(auditor, task, { actor: owner.id })).entries.map((e) => e.seq), [1, 11]);
      // Superseded decisions are marked non-authoritative; the later one is current.
      assert.equal(bySeq(10).authority, "superseded");
      assert.deepEqual(bySeq(10).supersededBy, [11]);
      assert.equal(bySeq(11).authority, "current");
      assert.equal(bySeq(11).supersedes, 10);
      // Redactions are marked; gaps stay listed; corrections are counted.
      assert.equal((bySeq(5).content as { redactions: number }).redactions >= 1, true);
      assert.deepEqual(view.entries.find((e) => e.seq === 13), { seq: 13, unavailable: "archived by retention" });
      assert.equal(bySeq(6).corrections, 1);
      // Windows page with `next`.
      const page = await replay.open(auditor, task, { limit: 5 });
      assert.deepEqual(page.entries.map((e) => e.seq), [1, 2, 3, 4, 5]);
      assert.equal(page.next, 5);
      assert.deepEqual((await replay.open(auditor, task, { from: 6, limit: 50 })).entries.map((e) => e.seq), [6, 7, 8, 9, 10, 11, 12, 13]);

      // One step in full: explanations at the time and afterwards are apart and labelled.
      const detail = await replay.step(auditor, task, 4);
      assert.equal(detail.explanations.contemporaneous.items.length, 1);
      assert.equal(detail.explanations.contemporaneous.label, REPLAY_LABELS.contemporaneous);
      assert.equal(detail.explanations.retrospective.items.length, 0);
      assert.equal(detail.explanations.retrospective.label, REPLAY_LABELS.retrospective);
      const detail2 = await replay.step(auditor, task, 2);
      assert.equal(detail2.explanations.contemporaneous.items.length, 0);
      assert.equal(detail2.explanations.retrospective.items.length, 1);
      assert.equal(detail2.explanations.retrospective.items[0]!.mode, "retrospective");
      assert.equal(detail.thinking, undefined, "only the owner is told about thinking");
      await refuses("not_found", () => replay.step(auditor, task, 13));
      await refuses("not_found", () => replay.step(auditor, task, 99));

      // "What evidence and instruction led to this change?": links.
      const led = await replay.led(auditor, task, 4);
      assert.equal(led.grounded, true);
      assert.ok(led.links.some((l) => l.relation === "context" && l.kind === "summary" && l.id === "sum-2" && l.version === "1"));
      assert.ok(led.links.some((l) => l.relation === "evidence" && l.kind === "tool-call" && l.id === "call-9"));
      assert.ok(led.links.some((l) => l.relation === "earlier-step" && l.seq === 1), "the instruction before it");
      const ledMain = await replay.led(auditor, task, 9);
      assert.ok(!ledMain.links.some((l) => l.seq === 7 || l.seq === 8), "the side line is not what the main line was given");
      assert.equal((await replay.led(auditor, task, 11)).links.some((l) => l.relation === "supersedes" && l.seq === 10), true);
      assert.equal((await replay.led(auditor, task, 12)).grounded, true, "the earlier instruction and message on its line");
      const bare = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "bare" })).id;
      await rec(worker, { kind: "tool-call", summary: "did something" }, bare);
      assert.deepEqual(await replay.led(auditor, bare, 1), { seq: 1, links: [], grounded: false, note: REPLAY_LABELS.unexplained });

      // Search and export apply the same checks and carry no stored content or thinking.
      assert.deepEqual((await replay.search(auditor, task, "DEPLOY")).matches.map((m) => m.seq), [10, 11]);
      const exported = await replay.export(auditor, task);
      assert.equal(exported.entries.length, 13);
      assert.equal(exported.content, "not included");
      assert.equal(exported.thinking, "not included");
      assert.equal(exported.explanations.retrospective.length, 1);
      assert.ok(!JSON.stringify(exported).includes("private content") && !JSON.stringify(exported).includes("sk-live") && !JSON.stringify(exported).includes("please wait"));
      assert.ok(!JSON.stringify(exported).includes("another project"), "no other project's records");

      // Content: only on request, only with the right; refused content reads as "not readable", not as empty; secrets stay redacted.
      const withText = await replay.step(auditor, task, 12, { withContent: true });
      assert.equal((withText.step.content as { text?: string }).text, "private content");
      const asWorker = await replay.step(worker, task, 12, { withContent: true });
      assert.equal((asWorker.step.content as { readable?: boolean }).readable, false, "a worker may not read sensitive content");
      assert.equal((asWorker.step.content as { text?: string }).text, undefined);
      assert.ok(!JSON.stringify(await replay.open(auditor, task, { withContent: true })).includes("sk-live"));
      assert.equal((await replay.step(worker, task, 11, { withContent: true })).step.content.state, "stored");
      assert.equal(((await replay.step(worker, task, 11, { withContent: true })).step.content as { text?: string }).text, "please wait", "ordinary content is open to those working the task");

      // Permissions: the same as reading the steps; another project's task and a reader without the right read as missing.
      await refuses("not_found", () => replay.open(stranger, task));
      await refuses("not_found", () => replay.step(stranger, task, 1));
      await refuses("not_found", () => replay.led(stranger, task, 1));
      await refuses("not_found", () => replay.search(stranger, task, "x"));
      await refuses("not_found", () => replay.export(stranger, task));
      await refuses("not_found", () => replay.open(auditor, foreign));
      await refuses("not_found", () => replay.thinking(auditor, { commandId: cid("th"), taskId: task, reason: "curious" }));
      await refuses("not_found", () => replay.thinking(worker, { commandId: cid("th"), taskId: task, reason: "curious" }));
      await refuses("invalid_command", () => replay.open(auditor, task, { limit: 500 }));
      await refuses("invalid_command", () => replay.search(auditor, task, "  "));

      // Thinking: collapsed and labelled in the view for the owner; expanded only by an explicit, owner-only, recorded look; redacted; removal by retention is said and nothing else changes.
      const ownerDetail = await replay.step(owner, task, 4);
      assert.equal(ownerDetail.thinking?.state, "not-removed");
      assert.equal(thinkingReads.length, 0, "opening a step never reads the thinking");
      const expanded = await replay.thinking(owner, { commandId: cid("th"), taskId: task, reason: "checking the switch" });
      assert.equal(expanded.collapsed, true);
      assert.equal(expanded.state, "stored");
      assert.equal(expanded.label, REPLAY_LABELS.thinking);
      assert.equal(thinkingReads.length, 1);
      const before = JSON.stringify(await replay.export(owner, task));
      removed = true;
      const gone = await replay.thinking(owner, { commandId: cid("th"), taskId: task, reason: "again" });
      assert.deepEqual(gone, { collapsed: true, state: "removed-by-retention", removedAt: "2026-11-20T00:00:00.000Z", label: REPLAY_LABELS.thinkingRemoved });
      assert.equal(thinkingReads.length, 1, "removed thinking is not asked for again");
      assert.equal((await replay.step(owner, task, 4)).thinking?.state, "removed-by-retention");
      assert.equal(JSON.stringify(await replay.export(owner, task)).replace(/"exportedAt":"[^"]*"/, ""), before.replace(/"exportedAt":"[^"]*"/, ""), "the timeline is unchanged by the removal");

      // Zero effects: not one write of any kind went through storage while opening, stepping, linking, searching and exporting.
      assert.equal(spy.writes(), 0);

      // The chat view says the same in words and needs the same rights.
      const status = StatusService.withEpoch(world.storage, projects.epoch, { replay } as never, options);
      const lines = (await status.replayLines(auditor, { taskId: task, limit: 50 }))!.lines.map((l) => l.text);
      assert.ok(lines.some((l) => /Step 6, .*uncertain.*1 correction/.test(l)), lines.join("\n"));
      assert.ok(lines.some((l) => /Step 10, .*replaced by step 11/.test(l)));
      assert.ok(lines.some((l) => /Step 13 is no longer available: archived by retention/.test(l)));
      assert.ok(lines.some((l) => /branch fix-b/.test(l)));
      assert.ok(lines.some((l) => l === REPLAY_LABELS.concurrent));
      const one = (await status.replayLines(auditor, { taskId: task, seq: 4 }))!.lines.map((l) => l.text).join("\n");
      assert.match(one, /Context then: summary sum-2 @1/);
      assert.match(one, /Written at the time/);
      assert.equal(await status.replayLines(stranger, { taskId: task }), undefined);
      assert.equal(spy.writes(), 0);
    } finally { await world.close(); }
  });
}
