import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { DeskService, HistoryService, RETRIEVAL_LIMITS, RetrievalService, type SourceRef } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
const wellFormed = (v: string): boolean => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    owner: Principal; desks: DeskService; histories: HistoryService; retrieval: RetrievalService; a: string; b: string; ta: string;
    agent(name: string, grants?: Grant[]): Promise<Principal>;
  }
  const suite = (name: string, body: (ctx: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const ta = (await projects.createTask({ commandId: cid("ta"), actor: "owner:rob", projectId: a, title: "task a" })).id;
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        await body({
          owner, desks, histories, a, b, ta,
          retrieval: RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options),
          agent: async (name, grants = []) => {
            await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name, grants });
            return principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token);
          },
        });
      } finally { await world.close(); }
    });
  const rights = (project: string): Grant[] => [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "history.append", project }, { action: "history.read", project }];
  const note = (project: string, extra: Record<string, unknown> = {}) => ({ commandId: cid("w"), projectId: project, kind: "note" as const, title: "Database choice", body: "We chose PostgreSQL because of the crash-recovery tests.", visibility: "shared" as const, status: "accepted" as const, ...extra });

  suite("search finds desk records and history entries with a snippet and a link to the original, and only what the reader may read", async ({ retrieval, desks, histories, agent, owner, a, b, ta }) => {
    const ann = await agent("ann", rights(a));
    const ben = await agent("ben", rights(a));
    const outsider = await agent("eve", rights(b));
    const shared = await desks.write(ann, note(a));
    const draft = await desks.write(ann, note(a, { title: "Draft thoughts", body: "Maybe PostgreSQL is wrong; secret plan.", status: "draft" }));
    const scratch = await desks.write(ann, note(a, { title: "Scratch", body: "PostgreSQL scratch numbers", visibility: "private" }));
    const other = await desks.write(outsider, note(b, { title: "Other project", body: "PostgreSQL in project B" }));
    await histories.append(ann, (await import("./histories.js")).HistoryService.taskScopeId(ta), { commandId: cid("h"), taskId: ta, text: "Benchmarks show PostgreSQL wins on recovery." });
    const chat = await histories.openScope(ann, { commandId: cid("c"), type: "chat", projectId: a, participants: [] });
    await histories.append(ann, chat.id, { commandId: cid("h"), text: "private PostgreSQL chat between ann alone" });

    const found = await retrieval.search(ben, { projectId: a, query: "postgresql recovery" });
    const kinds = found.hits.map((h) => h.source.kind).sort();
    assert.deepEqual(kinds, ["desk-record", "history-entry"], JSON.stringify(found.hits));
    const deskHit = found.hits.find((h) => h.source.kind === "desk-record")!;
    assert.deepEqual(deskHit.source, { kind: "desk-record", id: shared.id });
    assert.match(deskHit.snippet, /PostgreSQL/);
    assert.equal(deskHit.matched, 2);
    assert.ok(deskHit.snippet.length <= RETRIEVAL_LIMITS.snippet);
    const everything = JSON.stringify(found);
    for (const secret of ["secret plan", "scratch numbers", "project B", "private PostgreSQL chat"]) assert.ok(!everything.includes(secret), `${secret} must not appear`);
    // The owner of the draft and the scratch sees them; so does the chat's author through the chat.
    const mine = await retrieval.search(ann, { projectId: a, query: "postgresql" });
    const ids = mine.hits.filter((h) => h.source.kind === "desk-record").map((h) => (h.source as { id: string }).id).sort();
    assert.deepEqual(ids, [draft.id, scratch.id, shared.id].sort());
    // A reader with no rights in the project finds nothing, and cannot tell that anything exists.
    assert.deepEqual((await retrieval.search(outsider, { projectId: a, query: "postgresql" })).hits, []);
    assert.deepEqual((await retrieval.search(ben, { projectId: a, query: "nonexistentword" })).hits, []);
    void owner; void other;
  });

  suite("a search is paged by a cursor: every match once, across desk records and histories", async ({ retrieval, desks, histories, agent, a, ta }) => {
    const ann = await agent("ann", rights(a));
    for (let i = 0; i < 5; i++) await desks.write(ann, note(a, { title: `Decision ${i}`, body: `keyword number ${i}` }));
    const scope = HistoryService.taskScopeId(ta);
    for (let i = 0; i < 4; i++) await histories.append(ann, scope, { commandId: cid("h"), taskId: ta, text: `the keyword appears in message ${i}` });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await retrieval.search(ann, { projectId: a, query: "keyword", limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      assert.ok(page.hits.length <= 2);
      for (const h of page.hits) seen.push(JSON.stringify(h.source));
      cursor = page.next;
      if (cursor === undefined) break;
    }
    assert.equal(seen.length, 9, seen.join("\n"));
    assert.equal(new Set(seen).size, 9, "no match appears twice");
    await refuses("invalid_command", () => retrieval.search(ann, { projectId: a, query: "keyword", cursor: "x:../../etc" }), (e) => assert.match(e.message, /not a cursor/));
  });

  suite("following a link works only for a reader who may read the original, and missing looks the same as unreadable", async ({ retrieval, desks, agent, a, b }) => {
    const ann = await agent("ann", rights(a));
    const eve = await agent("eve", rights(b));
    const draft = await desks.write(ann, note(a, { status: "draft", body: "not for peers" }));
    const got = await retrieval.fetch(ann, { kind: "desk-record", id: draft.id });
    assert.equal(got!.text, "not for peers");
    const unreadable = await retrieval.fetch(eve, { kind: "desk-record", id: draft.id });
    const missing = await retrieval.fetch(eve, { kind: "desk-record", id: "dsk-aaaaaaaaaaaaaaaaaaaa" });
    assert.deepEqual([unreadable, missing], [undefined, undefined]);
    await refuses("invalid_command", () => retrieval.fetch(ann, { kind: "desk-record", id: "nope" }));
    await refuses("invalid_command", () => retrieval.fetch(ann, { kind: "history-entry", scopeId: "hst-aaaaaaaaaaaaaaaaaaaa", seq: 0 }));
  });

  suite("a summary keeps its originals, shows whether they changed, and is withheld from a reader who cannot read them all", async ({ retrieval, desks, histories, agent, a, b, ta }) => {
    const ann = await agent("ann", rights(a));
    const ben = await agent("ben", rights(a));
    const eve = await agent("eve", rights(b));
    const open = await desks.write(ann, note(a));
    const draft = await desks.write(ann, note(a, { status: "draft", title: "WIP", body: "first version" }));
    await histories.append(ann, HistoryService.taskScopeId(ta), { commandId: cid("h"), taskId: ta, text: "We agreed on PostgreSQL." });
    const entry: SourceRef = { kind: "history-entry", scopeId: HistoryService.taskScopeId(ta), seq: 1 };
    const deskLink: SourceRef = { kind: "desk-record", id: open.id };
    const s = await retrieval.summarize(ann, { commandId: cid("s"), projectId: a, title: "Database decision", text: "PostgreSQL was chosen; see the note and the discussion.", sources: [deskLink, entry] });
    const again = await retrieval.summarize(ann, { commandId: "same-summary", projectId: a, title: "x", text: "y", sources: [deskLink] });
    assert.equal((await retrieval.summarize(ann, { commandId: "same-summary", projectId: a, title: "x", text: "y", sources: [deskLink] })).replayed, true);
    void again;
    const seen = (await retrieval.resolve(ben, s.id))!;
    assert.equal(seen.withheld, false);
    assert.equal(seen.text, "PostgreSQL was chosen; see the note and the discussion.");
    assert.deepEqual(seen.sources.map((x) => x.state), ["current", "current"]);
    // An accepted original that is later replaced is no longer as it was.
    const replaced = await desks.write(ann, note(a, { body: "Old decision text." }));
    const forReplaced = await retrieval.summarize(ann, { commandId: cid("s"), projectId: a, title: "Old", text: "Summary of the old decision.", sources: [{ kind: "desk-record", id: replaced.id }] });
    assert.deepEqual((await retrieval.resolve(ben, forReplaced.id))!.sources.map((x) => x.state), ["current"]);
    await desks.write(ann, note(a, { body: "New decision text.", supersedes: replaced.id }));
    assert.deepEqual((await retrieval.resolve(ben, forReplaced.id))!.sources.map((x) => x.state), ["changed"], "superseding changes the record's status, which the digest covers");
    // A summary over a draft: the draft can still change, and only its owner can read it.
    const wip = await retrieval.summarize(ann, { commandId: cid("s"), projectId: a, title: "WIP summary", text: "A summary of a draft.", sources: [{ kind: "desk-record", id: draft.id }] });
    assert.deepEqual((await retrieval.resolve(ann, wip.id))!.sources.map((x) => x.state), ["current"]);
    await desks.revise(ann, { commandId: cid("r"), recordId: draft.id, expectedRevision: 1, body: "second version" });
    assert.deepEqual((await retrieval.resolve(ann, wip.id))!.sources.map((x) => x.state), ["changed"], "the original no longer matches what was summarized");
    const hidden = (await retrieval.resolve(ben, wip.id))!;
    assert.equal(hidden.withheld, true);
    assert.equal(hidden.text, undefined);
    assert.deepEqual(hidden.sources.map((x) => x.state), ["unavailable"], "ben cannot read the draft, so the summary of it is withheld, not leaked");
    // Refusals: unreadable or foreign originals, no write right, unknown or unreadable summary.
    await refuses("invalid_command", () => retrieval.summarize(ben, { commandId: cid("s"), projectId: a, title: "x", text: "y", sources: [{ kind: "desk-record", id: draft.id }] }), (e) => assert.match(e.message, /readable by the writer/));
    await refuses("forbidden", () => retrieval.summarize(ann, { commandId: cid("s"), projectId: b, title: "x", text: "y", sources: [deskLink] }));
    const both = await agent("both", [...rights(a), ...rights(b)]);
    await refuses("invalid_command", () => retrieval.summarize(both, { commandId: cid("s"), projectId: b, title: "x", text: "y", sources: [deskLink] }), (e) => assert.match(e.message, /belong to the project/));
    await refuses("forbidden", () => retrieval.summarize(eve, { commandId: cid("s"), projectId: a, title: "x", text: "y", sources: [deskLink] }));
    await refuses("invalid_command", () => retrieval.summarize(ann, { commandId: cid("s"), projectId: a, title: "x", text: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789", sources: [deskLink] }), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => retrieval.summarize(ann, { commandId: cid("s"), projectId: a, title: "x", text: "y", sources: [deskLink, deskLink] }), (e) => assert.match(e.message, /twice/));
    await refuses("invalid_command", () => retrieval.summarize(ann, { commandId: cid("s"), projectId: a, title: "x", text: "y", sources: [] }));
    assert.equal(await retrieval.resolve(eve, s.id), undefined, "a reader with no rights in the project gets nothing");
    assert.equal(await retrieval.resolve(ann, "sum-aaaaaaaaaaaaaaaaaaaa"), undefined);
  });

  suite("assembly fills a budget in order and lists everything it left out", async ({ retrieval, desks, agent, a, b }) => {
    const ann = await agent("ann", rights(a));
    const eve = await agent("eve", rights(b));
    const small = await desks.write(ann, note(a, { body: "x".repeat(300) }));
    const big = await desks.write(ann, note(a, { body: "y".repeat(5000) }));
    const last = await desks.write(ann, note(a, { body: "z".repeat(400) }));
    const draft = await desks.write(ann, note(a, { status: "draft", body: "d".repeat(100) }));
    const summary = await retrieval.summarize(ann, { commandId: cid("s"), projectId: a, title: "Sum", text: "summary text", sources: [{ kind: "desk-record", id: small.id }] });
    const items = [{ source: { kind: "desk-record" as const, id: small.id } }, { source: { kind: "desk-record" as const, id: big.id } }, { source: { kind: "desk-record" as const, id: last.id } }, { summaryId: summary.id }, { source: { kind: "desk-record" as const, id: draft.id } }];
    const out = await retrieval.assemble(ann, { items, budgetChars: 1000 });
    assert.deepEqual(out.included.map((i) => [i.text.length, i.truncated]), [[300, false], [700, true]], "the big one is cut to what is left");
    assert.deepEqual(out.omitted.map((o) => o.reason), ["over-budget", "over-budget", "over-budget"], "what no longer fits is listed, not dropped");
    assert.equal(out.usedChars, 1000);
    assert.equal(out.included.length + out.omitted.length, items.length, "every item is accounted for");
    // Unreadable items are listed as unavailable, and a roomy budget includes everything with nothing truncated.
    const eveView = await retrieval.assemble(eve, { items, budgetChars: 100_000 });
    assert.deepEqual(eveView.included, []);
    assert.deepEqual(eveView.omitted.map((o) => o.reason), ["unavailable", "unavailable", "unavailable", "unavailable", "unavailable"]);
    const all = await retrieval.assemble(ann, { items, budgetChars: 100_000 });
    assert.ok(all.included.every((i) => !i.truncated) && all.omitted.length === 0);
    assert.ok(all.usedChars <= all.budgetChars);
    await refuses("invalid_command", () => retrieval.assemble(ann, { items, budgetChars: 0 }));
    await refuses("invalid_command", () => retrieval.assemble(ann, { items: [{ nonsense: true } as never], budgetChars: 10 }));
    await refuses("invalid_command", () => retrieval.assemble(ann, { items: Array.from({ length: 101 }, () => items[0]!), budgetChars: 10 }));
  });

  suite("cutting never splits a character: snippets and truncated pieces stay well-formed text", async ({ retrieval, desks, agent, a }) => {
    const ann = await agent("ann", rights(a));
    // Emoji are two UTF-16 units; arrange for a cut to fall in the middle of one.
    const body = `${"a".repeat(59)}keyword${"😀".repeat(200)}`;
    const record = await desks.write(ann, note(a, { body }));
    const hit = (await retrieval.search(ann, { projectId: a, query: "keyword" })).hits[0]!;
    assert.ok(wellFormed(hit.snippet), "snippet is well-formed");
    for (const budget of [201, 202, 203, 300]) {
      const out = await retrieval.assemble(ann, { items: [{ source: { kind: "desk-record", id: record.id } }], budgetChars: budget });
      const piece = out.included[0]!;
      assert.ok(wellFormed(piece.text), `budget ${budget}: truncated text is well-formed`);
      assert.ok(out.usedChars <= budget);
    }
  });

  suite("queries and limits are checked", async ({ retrieval, agent, a }) => {
    const ann = await agent("ann", rights(a));
    await refuses("invalid_command", () => retrieval.search(ann, { projectId: a, query: "" }));
    await refuses("invalid_command", () => retrieval.search(ann, { projectId: a, query: "a" }), (e) => assert.match(e.message, /two or more/));
    await refuses("invalid_command", () => retrieval.search(ann, { projectId: a, query: "x".repeat(201) }));
    await refuses("invalid_command", () => retrieval.search(ann, { projectId: a, query: "word", limit: 51 }));
    await refuses("invalid_command", () => retrieval.search(ann, { projectId: a, query: "word", extra: 1 } as never));
    await refuses("invalid_command", () => retrieval.search(ann, { projectId: "proj", query: "word" }));
  });
}
