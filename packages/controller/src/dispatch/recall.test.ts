import assert from "node:assert/strict";
import { after, test } from "node:test";
import { findAnchors } from "../context/anchor.js";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { RecallReader } from "../context/recall-source.js";
import { RecallService } from "../context/recall-service.js";
import type { RecallAnswer } from "../context/recall.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/types.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherService } from "./dispatcher.js";

after(stopServer);

// Card W13 on the real records of all four storage backends: an attempt ends and the controller writes a hand-off note too long to keep whole (card C07p), so the whole text is archived; the task's next attempt asks task.recall for
// its own task and gets the notes, the hand-off note, the cut note's whole text and the digest back. Another task of the same project and a task of another project have their own hand-offs and cut notes: their IDs read exactly like
// missing ones, and the records read for the answer are only the kinds the card allows (no chat, desk, thinking or owner record is read at all).
const EFFECTS = Array.from({ length: 200 }, (_, i) => ({ id: `eff-${String(i).padStart(3, "0")}`, state: "confirmed" as const, summary: `watered bed ${i} twice` }));
const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const ALLOWED_KINDS = new Set(["dispatch", "dispatch-task-attempts", "ctx-handoff", "ctx-note-archive", "task", "task-contract", "task-contract-version"]);

async function endAttempt(d: DispatcherService, w: DispatchWorld): Promise<void> { for (let i = 0; i < 6; i++) { await w.heartbeatHost(); await d.tick(); await d.idle(); } }

/** The task's controller hand-off: its ID and the cut note's digest. */
async function handoffOf(storage: ControllerStorage, taskId: string): Promise<{ id: string; digest: string; text: string; attemptId: string }> {
  const rows = (await storage.listAggregates("ctx-handoff", { limit: 200 })).map((r) => ({ id: r.id, body: r.body as unknown as { taskId: string; attemptId: string; source: string; text: string } }));
  const mine = rows.find((r) => r.body.taskId === taskId && r.body.source === "controller");
  assert.ok(mine !== undefined, `no controller hand-off for ${taskId}`);
  const digest = /sha256:[0-9a-f]{64}/.exec(mine.body.text)![0];
  return { id: mine.id, digest, text: mine.body.text, attemptId: mine.body.attemptId };
}

for (const backend of backends) {
  test(`${backend.name}: task.recall gives an attempt back its own task's notes, hand-off note, cut note and activity from the controller's records; another task's or project's IDs read as missing; only allowed kinds are read (W13)`, async () => {
    const store = await backend.open();
    try {
      const kinds = new Set<string>();
      let writes = 0;
      const spy = new Proxy(store.storage, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target) as unknown;
          if (prop === "applyOperation") return (...a: unknown[]) => { writes += 1; return (v as (...x: unknown[]) => unknown).apply(target, a); };
          if (prop === "getAggregate") return (ref: { kind: string }) => { kinds.add(ref.kind); return (v as (r: unknown) => unknown).call(target, ref); };
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as ControllerStorage;
      const w = await buildWorld(spy);
      const options = { clock: w.clock.now, pause: async () => undefined };
      const histories = HistoryService.withEpoch(spy, w.epoch, options);
      const desks = DeskService.withEpoch(spy, w.epoch, options);
      const retrieval = RetrievalService.withEpoch(spy, w.epoch, desks, histories, options);
      const context = ContextEnforcementService.withEpoch(spy, w.epoch, { blockers: w.blockers, retrieval }, options);
      const d = w.restart({
        context, anchor: { plan: async () => ({ maxChars: 2400, recall: true }) },
        handoffFacts: async ({ taskId }) => ({ task: `Water the beds (${taskId.slice(-4)})`, effects: EFFECTS, artifacts: [{ id: "art-001", title: "the bed plan" }], lastKnownState: "beds 1-3 watered" }),
      });
      let checked = false;
      let failure: unknown;
      let inSecond: ((attemptId: string) => Promise<void>) | undefined;
      w.worker.script = async ({ order }) => {
        if (order.taskId === annTask) {
          if (inSecond !== undefined) await inSecond(order.attemptId);
          else {
            await d.addNote(w.dispatcherPrincipal, order.attemptId, { key: "agent:ann:n1", kind: "did", text: `decided to use the rain barrel; token ${SECRET}` });
            await d.addNote(w.dispatcherPrincipal, order.attemptId, { key: "agent:ann:n2", kind: "left", text: "water the right row" });
          }
        }
        return { status: "completed", text: "the worker stopped", endKind: "normal" };
      };
      let annTask = "";
      const second = (await w.projects.createProject({ commandId: "p2", actor: w.owner.id, name: "Other" })).id;
      const ann = await w.agent("ann", workGrants(w.project, []));
      const bob = await w.agent("bob", workGrants(w.project, []));
      const cat = await w.agent("cat", workGrants(second, []));

      // The caller's own task: a first attempt that left notes and ended; a second attempt follows.
      const a1 = await w.task("Water the beds", ann, { admit: false });
      annTask = a1.taskId;
      const first = (await w.assignments.getAssignment(a1.taskId))!;
      a1.attemptId = (await w.assignments.admitAttempt({ commandId: "w13-ad1", actor: "inbox", taskId: a1.taskId, expectedRevision: first.revision, generation: first.generation, owner: { kind: "agent", id: ann.aid }, harness: "pi" })).id;
      // Other tasks, ended in the same way: one in the same project, one in another project.
      const b1 = await w.task("Prune the roses", bob);
      const c1 = await w.task("Mow the lawn", cat, { project: second });
      await endAttempt(d, w);
      const mine = await handoffOf(spy, a1.taskId), bobs = await handoffOf(spy, b1.taskId), cats = await handoffOf(spy, c1.taskId);
      assert.notEqual(mine.digest, bobs.digest);
      const asg = (await w.assignments.getAssignment(a1.taskId))!;
      const attempt2 = (await w.assignments.admitAttempt({ commandId: "w13-ad2", actor: "inbox", taskId: a1.taskId, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: ann.aid }, harness: "pi" })).id;
      await d.addNote(w.dispatcherPrincipal, a1.attemptId!, { key: "agent:ann:n3", kind: "found", text: "the tap is stiff" }).catch(() => undefined);

      inSecond = async (running) => {
        assert.equal(running, attempt2);
        try {
          await d.addNote(w.dispatcherPrincipal, running, { key: "agent:ann:n3", kind: "found", text: "the tap is stiff" });
          await check();
        } catch (error) { failure = error; throw error; }
      };
      const check = async (): Promise<void> => {
        const annP = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:ann")).token);
      const bobP = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:bob")).token);
      const byOf = (attempt: string) => (attempt === b1.attemptId ? bobP : annP);
      const reader = new RecallReader({
          attemptsOf: (t) => d.attemptIdsOf(t), attempt: (id) => d.attemptBody(id), anchorFacts: (id) => d.recallAnchorFacts(id),
          handoff: (by, id) => context.readHandoff(by, id), archive: (by, t, dg) => context.noteArchive(by, { taskId: t, digest: dg }),
        });
        const svc = new RecallService({ read: (id, by) => reader.read(id, by), settings: async () => ({ recallCalls: 50 }) });
        let n = 0;
        const ask = async (args: Record<string, unknown>, attempt = attempt2): Promise<RecallAnswer> => {
          const r = await svc.recall({ attemptId: attempt, callId: `c${n++}`, by: byOf(attempt) }, args);
          assert.ok(r.ok, JSON.stringify(r));
          return r.result;
        };
        kinds.clear();
        writes = 0;

        // (a) the anchor facts, recomputed from the records.
        const anchor = await ask({ part: "anchor" });
        assert.ok(anchor.text.includes('Goal: "Water the beds"') && anchor.text.includes(mine.id) && anchor.text.includes(mine.digest), anchor.text);
        assert.equal(findAnchors(anchor.text).length, 0);
        // (b) the agent's own notes and the hand-off note, newest first; its secret redacted.
        const decisions = await ask({ part: "decisions" });
        assert.ok(decisions.text.includes("decided to use the rain barrel") && decisions.text.includes("water the right row") && decisions.text.includes(mine.id), decisions.text);
        assert.ok(!decisions.text.includes(SECRET));
        const readAll = async (part: string, id: string): Promise<string> => {
          let all = "", cursor: string | undefined;
          for (let i = 0; i < 60; i++) {
            const page = await ask({ part, id, maxChars: 8000, ...(cursor === undefined ? {} : { cursor }) });
            assert.ok(page.found && page.text.length <= 8000, `${part} ${id}`);
            all += JSON.parse(page.text.split("\n").at(-2)!) as string;
            cursor = page.next;
            if (cursor === undefined) return all;
          }
          throw new Error("the note never ended");
        };
        const note = await readAll("decisions", mine.id);
        assert.ok(note.includes("eff-199") && note.includes(mine.digest), "the hand-off note whole, with the marker that names the cut note");
        // (c) the cut note: listed, and its whole text (the oldest effect the note itself left out) read by its digest.
        const archives = await ask({ part: "archives" });
        assert.ok(archives.text.includes(mine.digest) && !archives.text.includes(bobs.digest) && !archives.text.includes(cats.digest));
        const whole = await readAll("archives", mine.digest);
        assert.ok(whole.includes("eff-000") && whole.includes("watered bed 0 twice") && whole.includes("eff-199"), "the oldest effect the cut took is back");
        assert.ok((await context.noteArchive(annP, { taskId: a1.taskId, digest: mine.digest }))!.text.replace(/\s+/g, " ").trim() === whole, "the pages together are the archive's text");
        // (d) the activity digest.
        const activity = await ask({ part: "activity" });
        assert.ok(activity.text.includes(a1.attemptId!) && activity.text.includes(attempt2) && activity.text.includes("(this one)"), activity.text);

        // Determinism: the same records and the same question give the same answer.
        assert.deepEqual(await ask({ part: "decisions" }), decisions);

        // Another task's IDs (same project) and another project's read exactly like missing ones.
        const missing = await ask({ part: "archives", id: `sha256:${"7".repeat(64)}` });
        assert.equal(missing.found, false);
        for (const [part, id] of [["archives", bobs.digest], ["archives", cats.digest], ["decisions", bobs.id], ["decisions", cats.id]] as const) {
          const foreign = await ask({ part, id });
          assert.equal(foreign.found, false, `${part} ${id}`);
          const twin = await ask({ part, id: part === "archives" ? `sha256:${"7".repeat(64)}` : "hof-bbbbbbbbbbbbbbbbbbbb" });
          assert.deepEqual({ ...foreign, digest: undefined, chars: undefined }, { ...twin, digest: undefined, chars: undefined }, "identical shape and text");
          assert.equal(foreign.text, twin.text);
          assert.ok(!foreign.text.includes(id) && !foreign.text.includes("Prune the roses") && !foreign.text.includes("Mow the lawn"));
        }
        // The other tasks' own attempts: the same service, their own answers; neither shows the caller's words.
        const bobAnswer = await ask({ part: "decisions" }, b1.attemptId!);
        assert.ok(bobAnswer.text.includes(bobs.id) && !bobAnswer.text.includes(mine.id) && !bobAnswer.text.includes("rain barrel"));
        // An argument that names a task is refused.
        const named = await svc.recall({ attemptId: attempt2, callId: "named", by: annP }, { taskId: b1.taskId });
        assert.ok(!named.ok && named.code === "invalid_command");

        // The kinds of records read to answer all of the above: only the task's own, never chat, desk, thinking, messages or the owner's.
        assert.equal(writes, 0, "task.recall wrote nothing: not one storage write while it answered");
        const outside = [...kinds].filter((k) => !ALLOWED_KINDS.has(k));
        assert.deepEqual(outside, [], `kinds read: ${[...kinds].join(", ")}`);
        checked = true;
      };
      await endAttempt(d, w);
      if (failure !== undefined) throw failure;
      assert.ok(checked, "the second attempt ran its checks");
    } finally { await store.close(); }
  });
}
