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
