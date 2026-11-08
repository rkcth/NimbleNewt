import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { STATUS_KINDS, StatusService } from "../status/status.js";
import { quoted } from "../status/explain.js";
import { ActivityService, ReplayService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-11-08T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); return true; });
};
/** Only these storage calls read; any other call counts (see replay.test.ts). */
const READS = new Set(["currentEpoch", "getOperation", "getAggregate", "listAggregates", "listAudit", "getDelivery", "getEffect", "getTimer", "snapshot"]);
const counting = (storage: ControllerStorage): { storage: ControllerStorage; calls: () => string[] } => {
  const calls: string[] = [];
  const proxy = new Proxy(storage, { get(target, key) {
    const value = (target as never)[key] as unknown;
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => { if (typeof key === "string" && !READS.has(key)) calls.push(key); return (value as (...a: unknown[]) => unknown).apply(target, args); };
  } });
  return { storage: proxy, calls: () => calls };
};

// Characters an agent may put in a summary (only C0 controls are refused when recorded) that must never reach a chat line raw: a C1 CSI (a terminal escape), the line and paragraph separators,
// a right-to-left override, a zero-width space and a tag character outside the basic plane (a format character written as a surrogate pair).
const RAW = /[\u0080-\u009f\u2028\u2029]|\p{Cf}/u;
const HOSTILE = "done\" (confirmed, replaced by step 9: x) \u009b31m red \u2028fake line\u2029 \u202eesrever \u200bzw \u{E0041} tag";

test("quoted: one JSON string on one line, controls and format characters escaped, credentials removed, cut", () => {
  const q = quoted(HOSTILE);
  assert.ok(q.startsWith("\"") && q.endsWith("\""));
  assert.ok(!RAW.test(q), q);
  for (const escaped of ["\\u009b", "\\u202e", "\\u200b", "\\udb40\\udc41", "done\\\" (confirmed"]) assert.ok(q.includes(escaped), `${escaped} in ${q}`);
  assert.equal(JSON.parse(q), HOSTILE.replace(/\s+/g, " "), "it reads back as the text (whitespace, the separators among it, folded to one space)");
  // The line and paragraph separators are whitespace: they are folded to a space before quoting, so none reaches the line.
  assert.equal(quoted("a\u2028b\u2029c"), "\"a b c\"");
  assert.ok(!quoted("key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234").includes("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234"));
  assert.equal(JSON.parse(quoted("a".repeat(500), 20)).length, 20);
  assert.equal(quoted(undefined), "\"\"");
});

for (const backend of backends) {
  test(`${backend.name}: replay and timeline views quote what agents wrote, filter by time and kind, list lines and agents to follow, and write nothing (card U09)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const make = async (nm: string, grants: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
      const worker = await make("ann", [{ action: "attempt.work", project }]);
      const helper = await make("bea", [{ action: "attempt.work", project }]);
      const auditor = await make("aud", [{ action: "history.read", project }]);
      const stranger = await make("zed", [{ action: "task.read", project }]);
      const svc = ActivityService.withEpoch(world.storage, projects.epoch, options);
      const rec = (by: Parameters<typeof svc.record>[0], c: Record<string, unknown>) => svc.record(by, { commandId: cid("r"), taskId: task, ...c } as never);

      await rec(owner, { kind: "instruction", summary: "fix the login bug" });                                                                                                         // 1
      const middle = new Date(now + 500).toISOString();
      await rec(worker, { kind: "tool-call", summary: HOSTILE, outcome: "proposed", manifest: { refs: [{ kind: "message", id: "msg\u202e-1", version: "v\u2028" }], summaryId: "sum\u200b" } }); // 2
      await rec(worker, { kind: "tool-call", summary: "leaked sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234 here", payload: { missing: true, reason: "lost \u009b2J" } });                        // 3
      await rec(helper, { kind: "branch", summary: "side line", branch: "fix-b" });                                                                                                     // 4
      const late = new Date(now + 500).toISOString();
      await rec(helper, { kind: "tool-call", summary: "side edit", branch: "fix-b" });                                                                                                 // 5
      await rec(worker, { kind: "agent-message", summary: "asked bea" });                                                                                                               // 6
      await svc.explain(worker, { commandId: cid("x"), taskId: task, seq: 2, choice: "use \u202eB", alternatives: [{ option: "A\u2028", whyNot: "slow\u009b" }], evidence: [{ statement: "it said \u200bso" }], uncertainty: "none\u2029" });
      await svc.markUnavailable(owner, { commandId: cid("u"), taskId: task, first: 6, last: 6, reason: "archived \u202e" });

      const spy = counting(world.storage);
      const reads = ActivityService.withEpoch(spy.storage, projects.epoch, options);
      const replay = ReplayService.withEpoch(spy.storage, projects.epoch, reads, {}, options);
      const status = StatusService.withEpoch(spy.storage, projects.epoch, { replay, activity: reads } as never, options);
      const texts = (got: { lines: readonly { text: string }[] } | undefined): string[] => got!.lines.map((l) => l.text);

      // Time, kind, line and agent filters narrow the window; a gap (no known time, line or actor) shows only unfiltered.
      assert.deepEqual((await replay.open(auditor, task, { since: middle })).entries.map((e) => e.seq), [2, 3, 4, 5]);
      assert.deepEqual((await replay.open(auditor, task, { until: middle })).entries.map((e) => e.seq), [1]);
      assert.deepEqual((await replay.open(auditor, task, { since: middle, until: late })).entries.map((e) => e.seq), [2, 3, 4]);
      assert.deepEqual((await replay.open(auditor, task, { kind: "tool-call" })).entries.map((e) => e.seq), [2, 3, 5]);
      assert.deepEqual((await replay.open(auditor, task)).entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6], "unfiltered, the gap is listed");
      assert.deepEqual((await replay.open(auditor, task, { since: "2026-01-01T00:00:00Z" })).entries.map((e) => e.seq), [1, 2, 3, 4, 5], "time-filtered, it is not");
      const paged = await replay.open(auditor, task, { kind: "tool-call", limit: 2 });
      assert.deepEqual([paged.entries.map((e) => e.seq), paged.next], [[2, 3], 5], "next is the next matching step");
      for (const bad of ["yesterday", "", "x".repeat(41), 5]) await refuses("invalid_command", () => replay.open(auditor, task, { since: bad as never }));
      await refuses("invalid_command", () => replay.open(auditor, task, { until: "soon" }));
      // The summary is not narrowed: lines of work and agents to follow.
      const sm = (await replay.open(auditor, task, { kind: "branch" })).summary;
      assert.deepEqual(sm.lanes, [{ lane: "main", steps: 3 }, { lane: "fix-b", steps: 2 }]);
      assert.deepEqual(sm.agents, [{ actor: worker.id, steps: 2 }, { actor: helper.id, steps: 2 }, { actor: owner.id, steps: 1 }].sort((a, b) => b.steps - a.steps || (a.actor < b.actor ? -1 : 1)));

      // The chat view: every agent-written text is quoted on one line, nothing raw gets through, credentials are removed.
      const all = texts(await status.ask(owner, { kind: "replay", taskId: task, limit: 50 }));
      for (const l of all) assert.ok(!RAW.test(l) && !l.includes("\n"), l);
      assert.ok(all.some((l) => l.startsWith(`Step 2, `) && l.includes(`tool-call - ${quoted(HOSTILE)} (proposed, reported by agent)`)), all.join("\n"));
      assert.ok(!all.some((l) => /- done" \(confirmed/.test(l)), "the agent's quote cannot close the quotation");
      assert.ok(all.some((l) => /content missing: "lost \\u009b2J"/.test(l)), all.join("\n"));
      assert.ok(all.some((l) => /^Step 6 is no longer available: "archived \\u202e"\.$/.test(l)), all.join("\n"));
      assert.ok(!all.join("\n").includes("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234"));
      assert.ok(all.some((l) => l === `Lines of work: main (3), fix-b (2). Agents: ${sm.agents.map((a) => `${a.actor} (${a.steps})`).join(", ")}.`), all.join("\n"));
      // Filters through the chat view (stepKind, since, until); a window with nothing in it says so.
      const kinds = texts(await status.ask(owner, { kind: "replay", taskId: task, stepKind: "branch" }));
      assert.deepEqual(kinds.filter((l) => l.startsWith("Step ")).map((l) => l.slice(0, 7)), ["Step 4,"]);
      const timed = texts(await status.ask(owner, { kind: "replay", taskId: task, since: middle, until: late, agent: worker.id }));
      assert.deepEqual(timed.filter((l) => l.startsWith("Step ")).map((l) => l.slice(0, 7)), ["Step 2,", "Step 3,"]);
      assert.ok(texts(await status.ask(owner, { kind: "replay", taskId: task, since: "2030-01-01T00:00:00Z" })).includes("No step in this window matches."));
      await assert.rejects(status.ask(owner, { kind: "replay", taskId: task, since: "later" }));
      await assert.rejects(status.ask(owner, { kind: "replay", taskId: task, colour: "red" } as never));
      // One step in full: references, explanations and what led to it are quoted too.
      const one = texts(await status.ask(owner, { kind: "replay", taskId: task, seq: 2 }));
      for (const l of one) assert.ok(!RAW.test(l), l);
      assert.ok(one.some((l) => l.includes(`Context then: message "msg\\u202e-1" @"v"; summary "sum\\u200b" stood in`)), one.join("\n"));
      assert.ok(one.some((l) => l.includes(`chose "use \\u202eB". Uncertain: "none"`)), one.join("\n"));
      assert.ok(one.some((l) => /Led to this step \(links, not reasons\): message "msg\\u202e-1" @"v" \(context\); evidence: "it said \\u200bso"; step 1 \(earlier-step\)\./.test(l)), one.join("\n"));
      // The C09h views over the same records quote the same way.
      for (const l of [...texts(await status.ask(owner, { kind: "activity", taskId: task })), ...texts(await status.ask(owner, { kind: "explanations", taskId: task })), ...texts(await status.ask(owner, { kind: "timeline", projectId: project }))]) assert.ok(!RAW.test(l), l);
      const timeline = texts(await status.ask(owner, { kind: "timeline", projectId: project, limit: 50 }));
      assert.ok(timeline.some((l) => l.endsWith(`tool-call - ${quoted(HOSTILE)}`)), timeline.join("\n"));

      // Missing and unreadable read the same: no line, and the same refusal from the service.
      const missing = "task-aaaaaaaaaaaaaaaaaaaa";
      assert.equal(await status.ask(stranger, { kind: "replay", taskId: task }), undefined);
      assert.equal(await status.ask(owner, { kind: "replay", taskId: missing }), undefined);
      const refusal = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return "ok"; } catch (e) { return `${(e as DomainError).code}: ${(e as Error).message}`; } };
      assert.equal(await refusal(() => replay.open(stranger, task, { since: middle })), await refusal(() => replay.open(auditor, missing, { since: middle })));

      // Nothing above wrote anything.
      assert.deepEqual(spy.calls(), []);
    } finally { await world.close(); }
  });
}

test("the replay status view lists its filters, so the chat interpreter can ask for them in free form", () => {
  for (const k of ["stepKind", "since", "until", "lane", "agent", "seq", "from"]) assert.ok(STATUS_KINDS["replay"]!.keys.includes(k), k);
  assert.match(STATUS_KINDS["replay"]!.about, /agents to follow/);
});
