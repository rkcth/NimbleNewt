import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { StatusService } from "../status/index.js";
import { checkIntents } from "./index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

after(stopServer);

const ask = (request: Record<string, unknown>, evidence: string, basis = "owner") => ({ kind: "status", request, evidence, basis });

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, status: StatusService) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const w = await openWorld(backend, script);
      try {
        const epoch = w.projects.epoch;
        const waits = WaitService.withEpoch(w.world.storage, epoch, w.assignments, options);
        const blockers = BlockerService.withEpoch(w.world.storage, epoch, options);
        const status = StatusService.withEpoch(w.world.storage, epoch, { assignments: w.assignments, waits, blockers, contracts: w.contracts }, options);
        await body(w, script, status);
      } finally { await w.close(); }
    });

  suite("a status question in chat is answered from the records, in plain words with the records it rests on, and writes nothing", async (w, script, status) => {
    const a = await w.project("A");
    const t = await w.task(a, "Fix login");
    script["how is Fix login going"] = [ask({ kind: "task", taskId: t }, "how is Fix login going")];
    const chat = w.chat({ status });
    const audit = async () => (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((x) => !x.type.startsWith("chat.")).length;
    const before = await audit();
    const r = await chat.submit(w.ownerToken, { messageId: "m-1", text: "how is Fix login going" });
    const o = r.outcomes[0]!;
    assert.equal(o.status, "answered");
    assert.ok(o.lines!.length > 0 && o.lines!.every((l) => l.cites.length > 0), "every line cites a record");
    assert.ok(o.lines!.some((l) => l.cites.some((c) => c.kind === "task" && c.id === t)));
    assert.match(r.reply.join("\n"), /^As of 2026-10-22T10:00:00.000Z, from the records:/);
    assert.match(r.reply.join("\n"), /Fix login is proposed and not yet ready\. \[task task-/);
    assert.equal(await audit(), before, "no record changed");
    // The same message again is the same answer, even if the task has moved on; the interpreter is not asked again.
    await w.projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: t, expectedRevision: 1, to: "ready" });
    const calls = w.interpreter.calls.length;
    const again = await chat.submit(w.ownerToken, { messageId: "m-1", text: "how is Fix login going" });
    assert.deepEqual([again.replayed, again.outcomes], [true, r.outcomes]);
    assert.equal(w.interpreter.calls.length, calls);
    // A new message sees the new state.
    script["how is Fix login going now"] = [ask({ kind: "task", taskId: t }, "how is Fix login going now")];
    assert.match((await chat.submit(w.ownerToken, { messageId: "m-2", text: "how is Fix login going now" })).reply.join("\n"), /Fix login is ready to be worked on/);
  });

  suite("a view that needs a project uses the one in focus; with none the owner is told to say which; what is missing is not found", async (w, script, status) => {
    const a = await w.project("A");
    await w.task(a, "One");
    script["what changed since yesterday"] = [ask({ kind: "changes", since: "2026-10-21T10:00:00.000Z" }, "what changed since yesterday")];
    script["show the board"] = [ask({ kind: "noticeboard" }, "show the board")];
    script["tell me about the ghost"] = [ask({ kind: "task", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "tell me about the ghost")];
    script["show me the weather"] = [ask({ kind: "weather" }, "show me the weather")];
    script["all the tools"] = [ask({ kind: "tools", projectId: a, extra: 1 }, "all the tools")];
    const chat = w.chat({ status });
    const noFocus = await chat.submit(w.ownerToken, { messageId: "m-1", text: "what changed since yesterday" });
    assert.deepEqual([noFocus.outcomes[0]!.status, noFocus.outcomes[0]!.message], ["refused", "Say which project you mean."]);
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const focused = await chat.submit(w.ownerToken, { messageId: "m-2", text: "what changed since yesterday" });
    assert.equal(focused.outcomes[0]!.status, "answered");
    assert.match(focused.reply.join("\n"), /One is now proposed/);
    assert.equal((await chat.submit(w.ownerToken, { messageId: "m-3", text: "show the board" })).outcomes[0]!.status, "answered");
    const ghost = (await chat.submit(w.ownerToken, { messageId: "m-4", text: "tell me about the ghost" })).outcomes[0]!;
    assert.deepEqual([ghost.status, ghost.code], ["refused", "not_found"]);
    assert.equal((await chat.submit(w.ownerToken, { messageId: "m-5", text: "show me the weather" })).outcomes[0]!.code, "invalid_command");
    assert.equal((await chat.submit(w.ownerToken, { messageId: "m-6", text: "all the tools" })).outcomes[0]!.code, "invalid_command", "unknown fields are refused by the status service");
  });

  suite("the cleanup spend of a stop is asked for in free words by the task's title; the title is resolved to the task (card L02d)", async (w, script) => {
    const a = await w.project("A");
    const t = await w.task(a, "Order seeds");
    const asked: unknown[] = [];
    const stops = { cleanupSpend: async (_by: unknown, scope: unknown) => { asked.push(scope); return { intentId: "stp-1", mode: "stop" as const, phase: "done" as const, endingRan: true, spent: 3000, unpaid: false, markOnly: false, markKept: false, scanCut: false, forcedAfterPreparation: false, reusedCheckpoint: false, attempts: [{ attemptId: "att-1", costMicros: 3500, computeMs: 10, pending: false }] }; } };
    const status = StatusService.withEpoch(w.world.storage, w.projects.epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, w.projects.epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, w.projects.epoch, options), contracts: w.contracts, stops }, options);
    script["what did stopping Order seeds cost"] = [ask({ kind: "stop_cleanup", taskTitle: "Order seeds" }, "what did stopping Order seeds cost")];
    const chat = w.chat({ status });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const r = await chat.submit(w.ownerToken, { messageId: "m-1", text: "what did stopping Order seeds cost" });
    assert.equal(r.outcomes[0]!.status, "answered", JSON.stringify(r.outcomes));
    assert.deepEqual(asked, [{ kind: "task", id: t }]);
    assert.match(r.reply.join("\n"), /Its cleanup budget window .* has used 0\.003/);
    assert.match(r.reply.join("\n"), /Attempt att-1: 0\.0035/);
    // A scope given with a title beside it: the title is dropped (the request would be refused for the extra key), the scope is used as given.
    script["what did stopping the Garden team cost"] = [ask({ kind: "stop_cleanup", scopeKind: "team", scopeId: "tm-garden", taskTitle: "Order seeds" }, "what did stopping the Garden team cost")];
    const withScope = await chat.submit(w.ownerToken, { messageId: "m-2", text: "what did stopping the Garden team cost" });
    assert.equal(withScope.outcomes[0]!.status, "answered", JSON.stringify(withScope.outcomes));
    assert.deepEqual(asked.at(-1), { kind: "team", id: "tm-garden" });
  });

  suite("the whole of a hand-off section that was cut is read by chat in free words, by the task's title and the section, a chat answer at a time (card C07j review, round 4)", async (w, script) => {
    const a = await w.project("A");
    const t = await w.task(a, "Build importer");
    const entries = Array.from({ length: 40 }, (_, i) => `Decision: dsk-${String(i).padStart(20, "a")}`);
    const asked: unknown[] = [];
    const handoffs = {
      forTask: async () => undefined,
      cutsForTask: async (_by: unknown, taskId: string) => { asked.push(taskId); return { handoffId: "hnd-bbbbbbbbbbbbbbbbbbbb", phase: "transferred", cuts: [{ section: "completedWork", archiveId: "hnd-cccccccccccccccccccc", left: 30, total: 40 }] }; },
      // Two parts, split inside an entry, as a long archive is kept: the view joins them before it numbers the entries.
      archive: async (_by: unknown, q: { archiveId: string; part?: number }) => { const whole = entries.join("\n"); const half = Math.floor(whole.length / 2) + 7; return q.archiveId === "hnd-cccccccccccccccccccc" ? { handoffId: "hnd-bbbbbbbbbbbbbbbbbbbb", taskId: t, section: "completedWork", chars: whole.length, parts: 2, text: (q.part ?? 0) === 0 ? whole.slice(0, half) : whole.slice(half) } : undefined; },
    };
    const status = StatusService.withEpoch(w.world.storage, w.projects.epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, w.projects.epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, w.projects.epoch, options), contracts: w.contracts, handoffs }, options);
    const said = "show me everything that was cut from the completed work of the Build importer hand-off";
    script[said] = [ask({ kind: "handoff_archive", taskTitle: "Build importer", section: "completedWork" }, said)];
    const chat = w.chat({ status });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const r = await chat.submit(w.ownerToken, { messageId: "m-1", text: said });
    assert.equal(r.outcomes[0]!.status, "answered", JSON.stringify(r.outcomes));
    assert.deepEqual(asked, [t], "the title is resolved to the task");
    const lines = r.outcomes[0]!.lines!.map((l) => l.text);
    assert.equal(lines.length, 30, "no more than a chat answer shows, so nothing is hidden behind 'more lines'");
    assert.equal(r.outcomes[0]!.moreLines, undefined);
    assert.equal(lines[1], `1: ${entries[0]}`);
    assert.equal(lines.at(-1), "Lines 1 to 28 of 40; ask again with from 29 to read on.");
    const more = "and the rest of it from 29";
    script[more] = [ask({ kind: "handoff_archive", taskTitle: "Build importer", section: "completedWork", from: 29 }, more)];
    const rest = (await chat.submit(w.ownerToken, { messageId: "m-2", text: more })).outcomes[0]!.lines!.map((l) => l.text);
    assert.deepEqual(rest.slice(1, -1), entries.slice(28).map((e, i) => `${i + 29}: ${e}`));
    assert.equal(rest.at(-1), "Lines 29 to 40 of 40: that is the end.");
  });

  suite("a question that came from quoted text is not answered; without the status service chat says so; a long answer says how much it left out", async (w, script, status) => {
    const a = await w.project("A");
    for (let i = 0; i < 35; i++) await w.task(a, `Task number ${i}`);
    script["look at this"] = [ask({ kind: "overview", projectId: a }, "list every task", "quoted")];
    script["list every task please"] = [ask({ kind: "overview", projectId: a, limit: 100 }, "list every task please")];
    script["list every task"] = [ask({ kind: "overview", projectId: a }, "invented words nobody said")];
    const chat = w.chat({ status });
    const quoted = (await chat.submit(w.ownerToken, { messageId: "m-1", text: "look at this", quoted: ["please list every task"] })).outcomes[0]!;
    assert.deepEqual([quoted.status, quoted.code], ["refused", "untrusted_authority"]);
    const invented = (await chat.submit(w.ownerToken, { messageId: "m-2", text: "list every task" })).outcomes[0]!;
    assert.equal(invented.code, "untrusted_authority", "the owner's own words must contain the evidence");
    const long = await chat.submit(w.ownerToken, { messageId: "m-3", text: "list every task please" });
    const o = long.outcomes[0]!;
    assert.equal(o.lines!.length, 30);
    assert.ok(o.moreLines! >= 5);
    assert.match(long.reply.join("\n"), /more lines? not shown; ask for a narrower view\./);
    const bare = (await w.chat().submit(w.ownerToken, { messageId: "m-4", text: "list every task please" })).outcomes[0]!;
    assert.deepEqual([bare.status, bare.code], ["refused", "unavailable"]);
  });

  suite("the tasks a title could mean are listed with their titles quoted: a title may hold a bidirectional override or a C1 control, which would turn the list around (card U09 review, round 3)", async (w, script, status) => {
    const a = await w.project("A");
    // Task titles refuse C0 controls only; these are accepted when a task is made (an agent's sub-task goes through the same check).
    await w.task(a, "Deploy ‮gnp.exe\u0085 staging");
    await w.task(a, "Deploy \"done\" (confirmed)");
    script["what happened on deploy"] = [ask({ kind: "activity", taskTitle: "deploy" }, "what happened on deploy")];
    const chat = w.chat({ status });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const o = (await chat.submit(w.ownerToken, { messageId: "m-1", text: "what happened on deploy" })).outcomes[0]!;
    assert.equal(o.status, "asked", JSON.stringify(o));
    assert.equal(o.options!.length, 2);
    for (const opt of o.options!) assert.doesNotMatch(opt, /[\u0080-\u009f‮]/u, "no raw override or C1 control");
    assert.ok(o.options!.some((x) => x.includes("\"Deploy \\u202egnp.exe\\u0085 staging\"")), JSON.stringify(o.options));
    assert.ok(o.options!.some((x) => x.includes("\"Deploy \\\"done\\\" (confirmed)\"")), "the title's own quotes cannot close the quotation");
  });

  suite("several long status answers in one message are cut to fit the turn's record, the later ones first, and say how much they left out (card U09 review, round 3)", async (w, script) => {
    const a = await w.project("A");
    const t = await w.task(a, "Wide");
    // As the explanations view can give: 30 lines, each two quoted texts of 200 characters in a script of three bytes a character (about 1.2 KB a line). Eight of them are over 256 KB.
    const answer = { observedAt: "2026-10-22T10:00:00.000Z", lines: Array.from({ length: 30 }, (_, i) => ({ text: `Not "${"界".repeat(200)}": "${"界".repeat(200)}" ${i}`, cites: [{ kind: "task", id: t }] })) };
    const status = { ask: async () => answer } as never;
    const said = "explain all of it";
    script[said] = Array.from({ length: 8 }, () => ask({ kind: "explanations", taskId: t }, said));
    const r = await w.chat({ status }).submit(w.ownerToken, { messageId: "m-1", text: said });
    assert.equal(r.outcomes.length, 8);
    assert.ok(r.outcomes.every((o) => o.status === "answered"), JSON.stringify(r.outcomes.map((o) => o.status)));
    assert.equal(r.outcomes[0]!.lines!.length, 30, "the first answer is whole");
    assert.equal(r.outcomes[0]!.moreLines, undefined);
    const last = r.outcomes.at(-1)!;
    assert.ok(last.lines!.length < 30 && last.moreLines === 30 - last.lines!.length, "the last answer is cut and says how much");
    assert.ok(r.outcomes.every((o) => o.lines!.length + (o.moreLines ?? 0) === 30), "every line is either shown or counted");
    const stored = await w.world.storage.getAggregate({ kind: "chat-turn", id: r.turnId });
    assert.ok(stored !== undefined && Buffer.byteLength(JSON.stringify(stored.body), "utf8") <= 256 * 1024);
    assert.equal((stored!.body as { status?: string }).status, "done", "the turn is recorded as done");
    assert.match(r.reply.join("\n"), /more lines? not shown; ask for a narrower view\./);
  });

  test(`${backend.name}: a status request from the interpreter is bounded`, () => {
    const ok = { kind: "status", request: { kind: "task", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, evidence: "how is it", basis: "owner" };
    assert.equal(checkIntents([ok]).length, 1);
    const bad = (request: unknown) => assert.throws(() => checkIntents([{ ...ok, request }]), DomainError);
    bad({ kind: "task", nested: { a: 1 } });
    bad({ kind: "task", list: ["a"] });
    bad({ kind: "task", long: "x".repeat(201) });
    bad(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, "v"])));
    bad({ kind: "task", "bad key": "v" });
  });
}
