import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type World } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { PublicationService, WorkingNoteService } from "./index.js";
import { ReviewService } from "../review/index.js";
import { CREDENTIAL_PATTERNS, findCredentialShapes, redactText } from "../security/index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    world: World; owner: Principal; projects: ProjectService; notes: WorkingNoteService; paths: PublicationService; review: ReviewService; a: string; b: string; ta: string; tb: string;
    agent(name: string, grants?: Grant[]): Promise<Principal>;
    host(name: string): Promise<Principal>;
  }
  const suite = (name: string, body: (ctx: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const make = async (kind: "agent" | "host", name: string, grants: Grant[] = []) => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name, grants });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${name}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const ta = (await projects.createTask({ commandId: cid("ta"), actor: "owner:rob", projectId: a, title: "task a" })).id;
        const tb = (await projects.createTask({ commandId: cid("tb"), actor: "owner:rob", projectId: b, title: "task b" })).id;
        await body({
          world, owner, projects, a, b, ta, tb,
          notes: WorkingNoteService.withEpoch(world.storage, projects.epoch, options), paths: PublicationService.withEpoch(world.storage, projects.epoch, options), review: ReviewService.withEpoch(world.storage, projects.epoch, options),
          agent: (name, grants) => make("agent", name, grants), host: (name) => make("host", name),
        });
      } finally { await world.close(); }
    });
  const writer = (project: string): Grant[] => [{ action: "desk.write", project }, { action: "desk.read", project }];
  const note = (project: string, extra: Record<string, unknown> = {}) => ({ commandId: cid("n"), projectId: project, category: "status" as const, title: "Migration at step 3", body: "Tables copied; indexes next.", ...extra });

  suite("a member reads an agent's shared notes with record and revision but cannot write or revise them, and cannot read scratch or drafts", async ({ notes, agent, a, owner }) => {
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", writer(a));
    const n = await notes.write(ann, note(a));
    const seen = await notes.read(ben, n.id);
    assert.deepEqual([seen.id, seen.revision, seen.owner, seen.author, seen.visibility, seen.title], [n.id, 1, "agent:ann", "agent:ann", "shared", "Migration at step 3"]);
    assert.equal((await notes.list(ben, { ownerId: "agent:ann", limit: 10 })).items[0]?.revision, 1);
    await refuses("forbidden", () => notes.revise(ben, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "ben was here" }), (e) => assert.match(e.message, /may not revise/));
    await refuses("forbidden", () => notes.revise(owner, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "even the owner" }));
    const lead = await agent("lead", [{ action: "*", project: "*" }]);
    await refuses("forbidden", () => notes.revise(lead, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "rank changes nothing" }));
    await refuses("forbidden", () => notes.setVisibility(ben, { commandId: cid("v"), noteId: n.id, expectedRevision: 1, visibility: "private" }));
    await refuses("forbidden", () => notes.promote(ben, { commandId: cid("p"), noteId: n.id, expectedRevision: 1, target: "docs", path: "docs/x.md", reason: "r" }));
    assert.equal((await notes.read(ben, n.id)).body, "Tables copied; indexes next.");
    // Notes are a separate tier: the notes service does not open desk drafts or scratch, and a reader with no desk.read gets nothing.
    const stranger = await agent("eve");
    await refuses("forbidden", () => notes.read(stranger, n.id));
    assert.deepEqual((await notes.list(stranger, { limit: 10 })).items, []);
    await refuses("forbidden", () => notes.write(owner, note(a)), (e) => assert.match(e.message, /notes belong to agents/));
    const reader = await agent("rae", [{ action: "desk.read", project: a }]);
    await refuses("forbidden", () => notes.write(reader, note(a)), (e) => assert.match(e.message, /desk\.write/));
    await refuses("forbidden", () => notes.read(ben, "wnt-aaaaaaaaaaaaaaaaaaaa"));
    await refuses("not_found", () => notes.read(owner, "wnt-aaaaaaaaaaaaaaaaaaaa"));
  });

  suite("notes are a tier beside the desk: a member who reads an agent's shared notes still cannot read its private scratch or drafts", async ({ notes, agent, a, world, projects }) => {
    const { DeskService } = await import("./index.js");
    const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", writer(a));
    const n = await notes.write(ann, note(a));
    const scratch = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "thinking", body: "maybe wrong", visibility: "private", status: "accepted" });
    const draft = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "plan", title: "draft", body: "wip", visibility: "shared" });
    assert.ok(await notes.read(ben, n.id));
    await refuses("forbidden", () => desks.read(ben, scratch.id));
    await refuses("forbidden", () => desks.read(ben, draft.id));
    await refuses("forbidden", () => notes.read(ben, scratch.id), (e) => assert.match(e.message, /may not read/));
    assert.deepEqual((await notes.list(ben, { limit: 10 })).items.map((i) => i.id), [n.id], "only notes are listed");
    assert.deepEqual((await desks.list(ben, { ownerId: "agent:ann", limit: 10 })).items, [], "notes are not desk records");
  });

  suite("every revision keeps its author and content; size is bounded; a decision needs its reason; stale and repeated commands behave", async ({ notes, agent, a, owner }) => {
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", writer(a));
    const n = await notes.write(ann, note(a, { category: "decision", reason: "the second server was too costly" }));
    await refuses("invalid_command", () => notes.write(ann, note(a, { category: "decision" })), (e) => assert.match(e.message, /says why/));
    const r2 = await notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "Indexes done." });
    assert.equal(r2.revision, 2);
    await refuses("stale_revision", () => notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "old view" }));
    const c = await notes.correct(owner, { commandId: cid("c"), noteId: n.id, expectedRevision: 2, body: "Indexes done (corrected)." });
    assert.equal(c.revision, 3);
    const versions = await notes.versions(ben, n.id);
    assert.deepEqual(versions.map((v) => [v.noteRevision, v.author, v.correction, v.body]), [[1, "agent:ann", false, "Tables copied; indexes next."], [2, "agent:ann", false, "Indexes done."], [3, "owner:rob", true, "Indexes done (corrected)."]]);
    const now = await notes.read(ben, n.id);
    assert.deepEqual([now.author, now.owner, now.reason], ["owner:rob", "agent:ann", "the second server was too costly"]);
    await refuses("invalid_command", () => notes.write(ann, note(a, { body: "x".repeat(8001) })), (e) => assert.match(e.message, /1 to 8000 characters/));
    await refuses("invalid_command", () => notes.write(ann, note(a, { title: "x".repeat(201) })));
    await refuses("invalid_command", () => notes.write(ann, note(a, { body: "" })));
    await refuses("invalid_command", () => notes.write(ann, note(a, { category: "gossip" as never })));
    await refuses("invalid_command", () => notes.write(ann, { ...note(a), visibility: "private" } as never));
    await refuses("invalid_command", () => notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 3 }));
    const ok = await notes.write(ann, note(a, { body: "x".repeat(8000) }));
    assert.equal((await notes.read(ben, ok.id)).body.length, 8000);
    // Repeats apply once.
    const cmd = note(a, { commandId: "write-once" });
    const first = await notes.write(ann, cmd);
    assert.deepEqual(await notes.write(ann, cmd), { ...first, replayed: true });
    const rv = { commandId: "revise-once", noteId: first.id, expectedRevision: 1, body: "again" };
    const r = await notes.revise(ann, rv);
    assert.deepEqual(await notes.revise(ann, rv), { ...r, replayed: true });
    assert.equal((await notes.versions(ann, first.id)).length, 2);
    // Revisions are capped.
    let last = r.revision;
    for (; last < 50; last++) await notes.revise(ann, { commandId: cid("loop"), noteId: first.id, expectedRevision: last, body: `rev ${last}` });
    await refuses("invalid_command", () => notes.revise(ann, { commandId: cid("loop"), noteId: first.id, expectedRevision: 50, body: "one too many" }), (e) => assert.match(e.message, /at most 50/));
    // At the cap an agent can still take a note back, and the owner can still correct it; text revisions stay refused.
    const back = await notes.setVisibility(ann, { commandId: cid("v"), noteId: first.id, expectedRevision: 50, visibility: "private" });
    assert.equal(back.revision, 51);
    for (let rev = 51; rev < 60; rev++) await notes.correct(owner, { commandId: cid("c"), noteId: first.id, expectedRevision: rev, body: `correction ${rev}` });
    assert.equal((await notes.read(owner, first.id)).revision, 60);
    await refuses("invalid_command", () => notes.correct(owner, { commandId: cid("c"), noteId: first.id, expectedRevision: 60, body: "one too many" }), (e) => assert.match(e.message, /at most 60 revisions in all; delete it/));
    await refuses("invalid_command", () => notes.revise(ann, { commandId: cid("loop"), noteId: first.id, expectedRevision: 60, body: "still too many" }));
    assert.equal((await notes.versions(owner, first.id)).length, 60);
    await notes.delete(owner, { commandId: cid("d"), noteId: first.id, expectedRevision: 60, reason: "too long" });
    await refuses("invalid_command", () => notes.list(ann, { limit: 5, afterId: "nope" }), (e) => assert.match(e.message, /not a note ID/));
  });

  suite("an entry that matches the credential-pattern list is refused at write time, in every field and on revision, correction and promotion", async ({ notes, agent, a, owner }) => {
    const ann = await agent("ann", writer(a));
    const n = await notes.write(ann, note(a));
    const secrets = ["Bearer abcdefghijklmnopqrstuvwxyz0123456789", "key sk-abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "AKIAABCDEFGHIJKLMNOP", "-----BEGIN RSA PRIVATE KEY-----\nabc", "postgres://user:hunter2@db/x", "password: hunter2hunter2", "AIza" + "a".repeat(35), "npm_" + "a".repeat(36)];
    for (const s of secrets) {
      await refuses("invalid_command", () => notes.write(ann, note(a, { body: `connect with ${s}` })), (e) => assert.match(e.message, /credential/));
    }
    await refuses("invalid_command", () => notes.write(ann, note(a, { title: "key sk-abcdefghijklmnopqrstuvwxyz" })));
    await refuses("invalid_command", () => notes.write(ann, note(a, { category: "decision", reason: "because Bearer abcdefghijklmnopqrstuvwxyz0123456789" })));
    await refuses("invalid_command", () => notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), (e) => { assert.match(e.message, /GitHub token/); assert.doesNotMatch(e.message, /ghp_abc/); });
    await refuses("invalid_command", () => notes.correct(owner, { commandId: cid("c"), noteId: n.id, expectedRevision: 1, body: "sk-abcdefghijklmnopqrstuvwxyz" }));
    await refuses("invalid_command", () => notes.promote(ann, { commandId: cid("p"), noteId: n.id, expectedRevision: 1, target: "docs", path: "docs/a.md", reason: "token=abcd1234efgh" }));
    assert.equal((await notes.list(ann, { limit: 50 })).items.length, 1, "nothing refused was stored");
    // The reusable list: shapes are found by name, plain prose is not, and redaction still uses the same list.
    assert.ok(CREDENTIAL_PATTERNS.length >= 14);
    assert.deepEqual(findCredentialShapes("nothing secret-looking here, token count 42"), []);
    assert.deepEqual(findCredentialShapes("Bearer abcdefghijklmnopqrstuvwxyz0123456789 and again Bearer abcdefghijklmnopqrstuvwxyz0123456789"), ["bearer token"]);
    assert.equal(redactText("use sk-abcdefghijklmnopqrstuvwxyz now"), "use [redacted] now");
  });

  suite("an agent marks a note private again (and shares it again); private notes are read by the agent and owner only", async ({ notes, agent, a, owner }) => {
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", [...writer(a), { action: "desk.scratch.read", project: a }, { action: "notes.chair.read", project: a }]);
    const n = await notes.write(ann, note(a));
    assert.ok(await notes.read(ben, n.id));
    const p = await notes.setVisibility(ann, { commandId: cid("v"), noteId: n.id, expectedRevision: 1, visibility: "private" });
    assert.equal(p.revision, 2);
    await refuses("forbidden", () => notes.read(ben, n.id), (e) => assert.match(e.message, /may not read/));
    assert.deepEqual((await notes.list(ben, { limit: 10 })).items, []);
    await refuses("forbidden", () => notes.versions(ben, n.id));
    assert.equal((await notes.read(ann, n.id)).visibility, "private");
    assert.equal((await notes.read(owner, n.id)).visibility, "private");
    await refuses("invalid_command", () => notes.setVisibility(ann, { commandId: cid("v"), noteId: n.id, expectedRevision: 2, visibility: "private" }), (e) => assert.match(e.message, /already private/));
    await refuses("stale_revision", () => notes.setVisibility(ann, { commandId: cid("v"), noteId: n.id, expectedRevision: 1, visibility: "shared" }));
    // Text written while the note was private is not handed to peers when it is shared again, though the current text is theirs to read.
    await notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 2, body: "private thinking" });
    await notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 3, body: "private thinking, edited" });
    await notes.setVisibility(ann, { commandId: cid("v"), noteId: n.id, expectedRevision: 4, visibility: "shared" });
    assert.equal((await notes.read(ben, n.id)).body, "private thinking, edited");
    assert.deepEqual((await notes.versions(ann, n.id)).map((v) => v.visibility), ["shared", "private", "private", "private", "shared"]);
    assert.deepEqual((await notes.versions(owner, n.id)).length, 5);
    assert.deepEqual((await notes.versions(ben, n.id)).map((v) => [v.noteRevision, v.body]), [[1, "Tables copied; indexes next."], [5, "private thinking, edited"]]);
  });

  suite("an agent promotes a note through the review path: the request is recorded against the revision and digest, changes nothing, and only the author makes it", async ({ notes, review, agent, a, b, owner, ta, tb }) => {
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", writer(a));
    const n = await notes.write(ann, note(a, { taskId: ta }));
    const cmd = { commandId: "promote-once", noteId: n.id, expectedRevision: 1, target: "docs" as const, path: "docs/migration.md", reason: "the steps are worth keeping" };
    const p = await notes.promote(ann, cmd);
    assert.deepEqual(await notes.promote(ann, cmd), { ...p, replayed: true });
    const [rec] = await notes.promotions(ann, { noteId: n.id });
    assert.deepEqual([rec?.id, rec?.state, rec?.noteRevision, rec?.target, rec?.path, rec?.requestedBy, rec?.contentDigest.length], [p.id, "requested", 1, "docs", "docs/migration.md", "agent:ann", 64]);
    assert.equal((await notes.read(ben, n.id)).revision, 1, "promoting does not change the note");
    assert.equal((await notes.promotions(ben)).length, 0);
    assert.equal((await notes.promotions(owner)).length, 1);
    await refuses("stale_revision", () => notes.promote(ann, { ...cmd, commandId: cid("p"), expectedRevision: 5 }));
    for (const path of ["/etc/passwd", "../x", "docs/../../x", "a b"]) await refuses("invalid_command", () => notes.promote(ann, { ...cmd, commandId: cid("p"), path }), (e) => assert.match(e.message, /relative path/));
    await refuses("invalid_command", () => notes.promote(ann, { ...cmd, commandId: cid("p"), target: "wiki" as never }));
    await refuses("invalid_command", () => notes.promote(ann, { ...cmd, commandId: cid("p"), reviewId: "rev-aaaaaaaaaaaaaaaaaaaa" }), (e) => assert.match(e.message, /review request you made/));
    const t = await notes.promote(ann, { ...cmd, commandId: cid("p"), target: "codebase", path: "packages/x/notes.ts" });
    assert.notEqual(t.id, p.id);
    // With a real review request: the agent's own, in the note's project.
    const asker = (project: string): Grant[] => [...writer(project), { action: "review.request", project }, { action: "attempt.work", project }];
    const op = { name: "run-script", args: { cwd: "/work" }, script: "echo promote\n", target: { kind: "workspace", id: "main" } };
    const ctx = { toolVersion: "1", authoritySource: "task grant", expectedEffects: ["adds a doc"], affectedResources: ["workspace:main"] };
    const ask = (who: Principal, task: string) => review.request(who, { commandId: cid("rq"), taskId: task, operation: op, note: "promote a note", context: ctx });
    const cat = await agent("cat", asker(a));
    const dan = await agent("dan", asker(a));
    const eli = await agent("eli", [...asker(a), ...asker(b)]);
    const n2 = await notes.write(cat, note(a, { taskId: ta }));
    const mine = await ask(cat, ta);
    const ok = await notes.promote(cat, { commandId: cid("p"), noteId: n2.id, expectedRevision: 1, target: "docs", path: "docs/x.md", reason: "keep it", reviewId: mine.id });
    assert.equal((await notes.promotions(cat, { noteId: n2.id }))[0]?.reviewId, mine.id);
    assert.ok(ok.id);
    // Another agent's review, and a review from another project, are refused.
    const theirs = await ask(dan, ta);
    await refuses("invalid_command", () => notes.promote(cat, { commandId: cid("p"), noteId: n2.id, expectedRevision: 1, target: "docs", path: "docs/x.md", reason: "keep it", reviewId: theirs.id }), (e) => assert.match(e.message, /review request you made/));
    const n3 = await notes.write(eli, note(a));
    const otherProject = await ask(eli, tb);
    await refuses("invalid_command", () => notes.promote(eli, { commandId: cid("p"), noteId: n3.id, expectedRevision: 1, target: "docs", path: "docs/y.md", reason: "keep it", reviewId: otherProject.id }), (e) => assert.match(e.message, /review request you made/));
    // Requests are capped per note, and found by note, not by scanning every request in the installation.
    const n4 = await notes.write(dan, note(a));
    for (let i = 0; i < 20; i++) await notes.promote(dan, { commandId: cid("p"), noteId: n4.id, expectedRevision: 1, target: "docs", path: `docs/${i}.md`, reason: `request ${i}` });
    await refuses("invalid_command", () => notes.promote(dan, { commandId: cid("p"), noteId: n4.id, expectedRevision: 1, target: "docs", path: "docs/21.md", reason: "one too many" }), (e) => assert.match(e.message, /at most 20 promotion requests/));
    assert.equal((await notes.promotions(dan, { noteId: n4.id })).length, 20);
    assert.equal((await notes.promotions(cat, { noteId: n4.id })).length, 0, "another agent sees none of them");
    for (let i = 0; i < 4; i++) { const m = await notes.write(eli, note(a)); for (let j = 0; j < 20; j++) await notes.promote(eli, { commandId: cid("p"), noteId: m.id, expectedRevision: 1, target: "docs", path: `docs/e${i}-${j}.md`, reason: "unrelated" }); }
    // Deleting the note blanks what its promotion requests may have echoed.
    const d = await notes.delete(owner, { commandId: cid("d"), noteId: n2.id, expectedRevision: 1, reason: "named a customer" });
    assert.ok(d.id);
    const [scrubbed] = await notes.promotions(owner, { noteId: n2.id });
    assert.deepEqual([scrubbed?.reason, scrubbed?.path, scrubbed?.scrubbed, scrubbed?.reviewId], ["", "", true, mine.id]);
    // The deleted note with all 20 requests: every one is scrubbed, whatever else was filed meanwhile.
    await notes.delete(owner, { commandId: cid("d"), noteId: n4.id, expectedRevision: 1, reason: "named a customer" });
    const all = await notes.promotions(owner, { noteId: n4.id });
    assert.deepEqual([all.length, all.every((x) => x.scrubbed === true && x.reason === "" && x.path === "")], [20, true]);
    assert.equal((await notes.promotions(owner)).filter((x) => x.noteId !== n2.id && x.noteId !== n4.id && x.scrubbed === true).length, 0, "unrelated requests are untouched");
  });

  suite("a chair (stand-in grant) reads shared notes with record and revision; a project's notes are invisible to another project without an A10 path", async ({ notes, paths, agent, a, b, owner }) => {
    const ann = await agent("ann", writer(a));
    const chair = await agent("chair", [{ action: "notes.chair.read", project: a }]);
    const n = await notes.write(ann, note(a));
    await notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "second" });
    const seen = await notes.read(chair, n.id);
    assert.deepEqual([seen.id, seen.revision, seen.body], [n.id, 2, "second"]);
    assert.equal((await notes.list(chair, { limit: 10 })).items.length, 1);
    const otherChair = await agent("chair2", [{ action: "notes.chair.read", project: b }]);
    await refuses("forbidden", () => notes.read(otherChair, n.id));
    // Project B's member:
    const bea = await agent("bea", writer(b));
    await refuses("forbidden", () => notes.read(bea, n.id));
    await refuses("forbidden", () => notes.read(bea, n.id, { viaProject: b }), (e) => assert.match(e.message, /may not read/));
    assert.deepEqual((await notes.list(bea, { limit: 10 })).items, []);
    assert.deepEqual((await notes.list(bea, { limit: 10, viaProject: b })).items, []);
    await paths.open(owner, { commandId: cid("open"), fromProject: a, toProject: b, reason: "B builds on A" });
    assert.equal((await notes.read(bea, n.id, { viaProject: b })).revision, 2);
    assert.equal((await notes.list(bea, { limit: 10, viaProject: b })).items.length, 1);
    assert.equal((await notes.versions(bea, n.id, { viaProject: b })).length, 2);
    // The path is one-way, needs read access in the named project, and without naming it nothing changes.
    await refuses("forbidden", () => notes.read(bea, n.id));
    const nobody = await agent("nobody");
    await refuses("forbidden", () => notes.read(nobody, n.id, { viaProject: b }));
    const nb = await notes.write(bea, note(b));
    await refuses("forbidden", () => notes.read(ann, nb.id, { viaProject: a }));
    const closed = await paths.get(owner, a, b);
    await paths.close(owner, { commandId: cid("close"), fromProject: a, toProject: b, expectedRevision: closed!.revision });
    await refuses("forbidden", () => notes.read(bea, n.id, { viaProject: b }));
    // A task credential of A stays in A.
  });

  suite("a note's writer cannot write into another project; losing the grant ends revising; a task-scoped principal stays in its project", async ({ notes, agent, a, b, ta, tb, owner, world }) => {
    const ann = await agent("ann", writer(a));
    await refuses("forbidden", () => notes.write(ann, note(b)));
    await refuses("invalid_command", () => notes.write(ann, note(a, { taskId: tb })), (e) => assert.match(e.message, /not in project/));
    const zed = await agent("zed", writer("proj-aaaaaaaaaaaaaaaaaaaa"));
    await refuses("not_found", () => notes.write(zed, note("proj-aaaaaaaaaaaaaaaaaaaa")));
    const n = await notes.write(ann, note(a, { taskId: ta }));
    const principals = PrincipalService.withEpoch(world.storage, await world.storage.currentEpoch(), options);
    await principals.setGrants(owner, { commandId: cid("g"), principalId: "agent:ann", expectedRevision: (await principals.get("agent:ann"))!.revision, grants: [] });
    const annNow: Principal = { ...ann, grants: [] };
    await refuses("forbidden", () => notes.revise(annNow, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "still editing" }));
    // Taking a note back stays possible; sharing again does not.
    await notes.setVisibility(annNow, { commandId: cid("v"), noteId: n.id, expectedRevision: 1, visibility: "private" });
    await refuses("forbidden", () => notes.setVisibility(annNow, { commandId: cid("v"), noteId: n.id, expectedRevision: 2, visibility: "shared" }));
    const scoped: Principal = { ...ann, taskScope: { taskId: tb, projectId: b } };
    await refuses("forbidden", () => notes.read(scoped, n.id));
  });

  suite("shared notes stay readable while the author is inside a long-running command, and reading touches nothing of the author's", async ({ notes, agent, a, world }) => {
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", writer(a));
    const n = await notes.write(ann, note(a));
    // The author's turn is "busy": nothing in it holds the note, and a read is not a write, so it neither waits for the author nor changes anything the author holds.
    const before = await world.storage.currentEpoch();
    for (let i = 0; i < 3; i++) assert.equal((await notes.read(ben, n.id)).revision, 1);
    assert.equal((await notes.list(ben, { ownerId: "agent:ann", limit: 5 })).items.length, 1);
    assert.equal((await notes.versions(ben, n.id)).length, 1);
    assert.equal(await world.storage.currentEpoch(), before);
    // Meanwhile the author's own next write still works at revision 1: readers did not advance it.
    assert.equal((await notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 1, body: "after the long command" })).revision, 2);
  });

  suite("the owner reads, corrects and deletes shared notes; deletion removes the content everywhere, is recorded, and repeats once", async ({ notes, agent, a, owner }) => {
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", writer(a));
    const n = await notes.write(ann, note(a, { body: "the plan, with a stray detail" }));
    await notes.setVisibility(ann, { commandId: cid("v"), noteId: n.id, expectedRevision: 1, visibility: "private" });
    assert.equal((await notes.read(owner, n.id)).body, "the plan, with a stray detail", "the owner reads private notes too");
    const fixed = await notes.correct(owner, { commandId: cid("c"), noteId: n.id, expectedRevision: 2, body: "the plan" });
    await refuses("forbidden", () => notes.correct(ann, { commandId: cid("c"), noteId: n.id, expectedRevision: 3, body: "x" }) as never, (e) => assert.match(e.message, /not the owner/));
    await refuses("forbidden", () => notes.delete(ann, { commandId: cid("d"), noteId: n.id, expectedRevision: fixed.revision, reason: "mine" }));
    await refuses("forbidden", () => notes.deletions(ann));
    await refuses("stale_revision", () => notes.delete(owner, { commandId: cid("d"), noteId: n.id, expectedRevision: 1, reason: "stale" }));
    await refuses("invalid_command", () => notes.delete(owner, { commandId: cid("d"), noteId: n.id, expectedRevision: fixed.revision, reason: "token=abcd1234efgh" }));
    const cmd = { commandId: "delete-once", noteId: n.id, expectedRevision: fixed.revision, reason: "it named a customer" };
    const d = await notes.delete(owner, cmd);
    assert.deepEqual(await notes.delete(owner, cmd), { ...d, replayed: true });
    const [rec] = await notes.deletions(owner);
    assert.deepEqual([rec?.id, rec?.noteId, rec?.noteOwner, rec?.deletedBy, rec?.reason, rec?.finalRevision, rec?.contentDigest.length], [d.id, n.id, "agent:ann", "owner:rob", "it named a customer", 3, 64]);
    assert.ok(!JSON.stringify(rec).includes("the plan"), "the record keeps no content");
    const tomb = await notes.read(owner, n.id);
    assert.deepEqual([tomb.title, tomb.body, tomb.deleted?.deletionId], ["", "", d.id]);
    for (const v of await notes.versions(owner, n.id)) assert.deepEqual([v.body, v.deleted], ["", true]);
    await refuses("forbidden", () => notes.read(ann, n.id));
    await refuses("forbidden", () => notes.read(ben, n.id));
    assert.deepEqual((await notes.list(owner, { limit: 10 })).items, []);
    await refuses("invalid_command", () => notes.delete(owner, { commandId: cid("d"), noteId: n.id, expectedRevision: 4, reason: "again" }), (e) => assert.match(e.message, /already deleted/));
    await refuses("invalid_command", () => notes.correct(owner, { commandId: cid("c"), noteId: n.id, expectedRevision: 4, body: "revive" }), (e) => assert.match(e.message, /deleted/));
    await refuses("forbidden", () => notes.revise(ann, { commandId: cid("r"), noteId: n.id, expectedRevision: 4, body: "revive" }));
    await refuses("not_found", () => notes.delete(owner, { commandId: cid("d"), noteId: "wnt-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 1, reason: "x" }));
  });

  suite("two agents can use the same command ID without meeting; concurrent revisions let exactly one win", async ({ notes, agent, a }) => {
    const ann = await agent("ann", writer(a));
    const ben = await agent("ben", writer(a));
    const one = await notes.write(ann, note(a, { commandId: "same" }));
    const two = await notes.write(ben, note(a, { commandId: "same", title: "ben's" }));
    assert.notEqual(one.id, two.id);
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => notes.revise(ann, { commandId: cid("race"), noteId: one.id, expectedRevision: 1, body: `try ${i}` })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await notes.versions(ben, one.id)).length, 2);
  });
}
