import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { DependencyService, type NewDependency } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T17:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const H = (s: string): string => createHash("sha256").update(s).digest("hex");

for (const backend of backends) {
  interface Ctx { deps: DependencyService; desks: DeskService; owner: Principal; ann: Principal; ben: Principal; reader: Principal; a: string; b: string; task: string; note(text: string, extra?: Record<string, unknown>): Promise<string> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const ann = await agent("ann", [{ action: "attempt.work", project: a }, { action: "desk.write", project: a }, { action: "desk.read", project: a }]);
        const ben = await agent("ben", [{ action: "attempt.work", project: b }, { action: "desk.write", project: a }, { action: "desk.read", project: a }]);
        const reader = await agent("reader", [{ action: "history.read", project: a }]);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        await body({ deps: DependencyService.withEpoch(world.storage, projects.epoch, options), desks, owner, ann, ben, reader, a, b, task, note: async (text, extra = {}) => (await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "t", body: text, visibility: "shared", status: "accepted", ...extra } as never)).id });
      } finally { await world.close(); }
    });
  const rec = (c: Ctx, dependencies: NewDependency[], by = c.ann) => c.deps.record(by, { commandId: cid("r"), taskId: c.task, dependencies });
  const idOf = async (c: Ctx, key: string): Promise<string> => (await c.deps.get(c.ann, c.task))!.entries.find((e) => e.key === key)!.id;

  suite("files, directories and searches: unchanged, changed, deleted, new members, unknown, expired cursor", async (c) => {
    await rec(c, [
      { kind: "file", key: "src/a.ts", hash: H("one") }, { kind: "file", key: "src/gone.ts", hash: H("x") }, { kind: "file", key: "src/unread.ts", hash: H("u") },
      { kind: "directory", key: "src", members: ["a.ts", "gone.ts", "unread.ts"] }, { kind: "directory", key: "docs", members: ["a.md", "b.md"] }, { kind: "directory", key: "lib", members: ["x"] },
      { kind: "search", key: "todo", scope: { projectId: c.a, query: "TODO" }, cursor: 40, hash: H("results-1") }, { kind: "search", key: "old", scope: { query: "old" }, cursor: 3, hash: H("r") },
    ]);
    const ids = { a: await idOf(c, "src/a.ts"), gone: await idOf(c, "src/gone.ts"), unread: await idOf(c, "src/unread.ts"), src: await idOf(c, "src"), docs: await idOf(c, "docs"), lib: await idOf(c, "lib"), todo: await idOf(c, "todo"), old: await idOf(c, "old") };
    const results = await c.deps.check(c.ann, c.task, {
      [ids.a]: { hash: H("two") }, [ids.gone]: { exists: false }, [ids.src]: { members: ["a.ts", "gone.ts", "unread.ts"] }, [ids.docs]: { members: ["a.md", "b.md", "c.md"] }, [ids.lib]: { members: [] },
      [ids.todo]: { hash: H("results-1"), cursorFloor: 10 }, [ids.old]: { hash: H("r"), cursorFloor: 10 },
    });
    const by = Object.fromEntries(results.map((r) => [r.key, r.status]));
    assert.deepEqual(by, { "src/a.ts": "changed", "src/gone.ts": "deleted", "src/unread.ts": "unknown", src: "unchanged", docs: "new-members", lib: "changed", todo: "unchanged", old: "cursor-expired" });
    assert.match(results.find((r) => r.key === "docs")!.detail, /c\.md/);
    // Nothing observed is never "unchanged".
    assert.ok((await c.deps.check(c.ann, c.task)).every((r) => r.status === "unknown"));
    // The same file recorded again replaces its observation.
    await rec(c, [{ kind: "file", key: "src/a.ts", hash: H("two") }]);
    assert.equal((await c.deps.check(c.ann, c.task, { [ids.a]: { hash: H("two") } })).find((r) => r.key === "src/a.ts")!.status, "unchanged");
    assert.equal((await c.deps.get(c.ann, c.task))!.entries.length, 8);
  });

  suite("shared records, decisions, tool versions, environments and negative lookups are judged from the controller's own state", async (c) => {
    const record = await c.note("the plan is X");
    const decision = await c.desks.write(c.ann, { commandId: cid("w"), projectId: c.a, kind: "decision", title: "d", body: "we chose Y", visibility: "shared", status: "accepted" } as never);
    await rec(c, [
      { kind: "record", key: record, hash: H("the plan is X") }, { kind: "decision", key: decision.id, hash: H("we chose Y") }, { kind: "record", key: "dsk-aaaaaaaaaaaaaaaaaaaa", hash: H("never") },
      { kind: "negative", key: "desk-record:dsk-bbbbbbbbbbbbbbbbbbbb" },
    ]);
    await refuses("invalid_command", () => rec(c, [{ kind: "negative", key: "desk-record:" + record }]), (e) => assert.match(e.message, /exists/));
    await refuses("invalid_command", () => rec(c, [{ kind: "record", key: record, hash: H("a guess") }]), (e) => assert.match(e.message, /as it is now/));
    const status = async () => Object.fromEntries((await c.deps.check(c.ann, c.task)).map((r) => [r.key, r.status]));
    assert.deepEqual(await status(), { [record]: "unchanged", [decision.id]: "unchanged", "dsk-aaaaaaaaaaaaaaaaaaaa": "deleted", "desk-record:dsk-bbbbbbbbbbbbbbbbbbbb": "unchanged" });
    // The record is superseded by a newer one: the dependency on it has changed.
    await c.desks.write(c.ann, { commandId: cid("w"), projectId: c.a, kind: "note", title: "t", body: "the plan is Z", visibility: "shared", status: "accepted", supersedes: record } as never);
    assert.equal((await status())[record], "changed");
  });

  suite("external resources and MCP reads: a conditional read tells, an unchecked one is freshness-uncertain, and a missing observation is unknown", async (c) => {
    await rec(c, [
      { kind: "external", key: "https://example.invalid/spec", etag: "\"v1\"", freshness: "conditional-read" }, { kind: "external", key: "https://example.invalid/page", hash: H("page"), freshness: "none" },
      { kind: "external", key: "https://example.invalid/api", hash: H("api"), freshness: "authoritative-query" },
      { kind: "mcp-resource", key: "mcp://docs/readme", server: "docs-server", protocol: "2025-06-18", etag: "\"r1\"", freshness: "conditional-read" },
    ]);
    const ids = { spec: await idOf(c, "https://example.invalid/spec"), page: await idOf(c, "https://example.invalid/page"), api: await idOf(c, "https://example.invalid/api"), mcp: await idOf(c, "mcp://docs/readme") };
    const by = async (obs: Record<string, never> | Record<string, object>) => Object.fromEntries((await c.deps.check(c.ann, c.task, obs as never)).map((r) => [r.key, r.status]));
    assert.deepEqual(await by({ [ids.spec]: { etag: "\"v1\"" }, [ids.page]: { hash: H("page") }, [ids.api]: { hash: H("api2") }, [ids.mcp]: { etag: "\"r2\"" } }), {
      "https://example.invalid/spec": "unchanged", "https://example.invalid/page": "freshness-uncertain", "https://example.invalid/api": "changed", "mcp://docs/readme": "changed",
    });
    assert.deepEqual(Object.values(await by({})).sort(), ["freshness-uncertain", "unknown", "unknown", "unknown"]);
    const entry = (await c.deps.get(c.ann, c.task))!.entries.find((e) => e.kind === "mcp-resource")!;
    assert.deepEqual([entry.server, entry.protocol, entry.observedAt], ["docs-server", "2025-06-18", "2026-10-22T17:00:00.000Z"]);
    assert.equal((await by({ [ids.mcp]: { exists: false } }))["mcp://docs/readme"], "deleted");
  });

  suite("each kind must say enough to be checked later, and only people on the task record or read the manifest", async (c) => {
    for (const bad of [{ kind: "file", key: "a" }, { kind: "file", key: "a", hash: "xyz" }, { kind: "directory", key: "d" }, { kind: "search", key: "s", hash: H("r") }, { kind: "search", key: "s", scope: { query: "q" }, hash: H("r") }, { kind: "external", key: "u", etag: "e" }, { kind: "external", key: "u", freshness: "none" }, { kind: "mcp-resource", key: "m", etag: "e", freshness: "none" }, { kind: "mcp-resource", key: "m", server: "s", protocol: "p", freshness: "none" }, { kind: "record", key: "dsk-x" }, { kind: "party", key: "a", hash: H("a") }, { kind: "file", key: "", hash: H("a") }, { kind: "file", key: "a\nb", hash: H("a") }, { kind: "file", key: "a", hash: H("a"), extra: 1 }, { kind: "file", key: "a", hash: H("a"), freshness: "sometimes" }, { kind: "directory", key: "d", members: ["x"].concat(Array.from({ length: 201 }, (_, i) => `m${i}`)) }]) await assert.rejects(() => rec(c, [bad as never]), DomainError, JSON.stringify(bad).slice(0, 60));
    await assert.rejects(() => rec(c, []), DomainError);
    await refuses("forbidden", () => rec(c, [{ kind: "file", key: "a", hash: H("a") }], c.ben), undefined);
    await rec(c, [{ kind: "file", key: "a", hash: H("a") }]);
    assert.ok((await c.deps.get(c.reader, c.task)) !== undefined, "someone who may read the project's histories sees it");
    assert.equal(await c.deps.get(c.ben, c.task), undefined);
    await refuses("not_found", () => c.deps.check(c.ben, c.task));
    assert.ok((await c.deps.get(c.owner, c.task)) !== undefined);
    await refuses("forbidden", () => rec(c, [{ kind: "file", key: "a", hash: H("a") }], c.reader));
  });

  suite("a repeated record command is one recording, and the manifest is bounded", async (c) => {
    const id = cid("r");
    const one = await c.deps.record(c.ann, { commandId: id, taskId: c.task, dependencies: [{ kind: "file", key: "a", hash: H("a") }] });
    const two = await c.deps.record(c.ann, { commandId: id, taskId: c.task, dependencies: [{ kind: "file", key: "a", hash: H("a") }] });
    assert.deepEqual([one, two], [{ recorded: 1 }, { recorded: 1 }]);
    const many = Array.from({ length: 499 }, (_, i) => ({ kind: "file" as const, key: `f${i}`, hash: H(`f${i}`) }));
    await rec(c, many);
    await refuses("unavailable", () => rec(c, [{ kind: "file", key: "one-too-many", hash: H("x") }]));
  });

  suite("what the controller judges itself is recorded as it really is and only judged for those who may read it: a guess at someone's private scratch confirms nothing", async (c) => {
    const secret = (await c.desks.write(c.ben, { commandId: cid("w"), projectId: c.a, kind: "note", title: "s", body: "ben's private thinking", visibility: "private", status: "accepted" } as never)).id;
    // ann guesses the content: recording succeeds (it says nothing about the record), but nothing can be learned from checking it.
    await rec(c, [{ kind: "record", key: secret, hash: H("ben's private thinking") }, { kind: "record", key: "dsk-zzzzzzzzzzzzzzzzzzzz", hash: H("x") }, { kind: "negative", key: `desk-record:${secret}` }]);
    const by = Object.fromEntries((await c.deps.check(c.ann, c.task)).map((r) => [r.key, r.status]));
    assert.deepEqual(by, { [secret]: "unknown", "dsk-zzzzzzzzzzzzzzzzzzzz": "deleted", [`desk-record:${secret}`]: "unknown" });
    const wrong = Object.fromEntries((await (async () => { await rec(c, [{ kind: "record", key: secret, hash: H("a wrong guess") }]); return c.deps.check(c.ann, c.task); })()).map((r) => [r.key, r.status]));
    assert.equal(wrong[secret], "unknown", "a right and a wrong guess look the same");
    const kept = (await c.deps.get(c.owner, c.task))!.entries.find((e) => e.key === secret)!;
    assert.equal(kept.unverified, true, "the entry says its hash was only the recorder's word");
    // The owner, who may read it, sees the truth.
    assert.equal((await c.deps.check(c.owner, c.task)).find((r) => r.key === secret)!.status, "changed");
  });

  suite("a search's position can be judged only against an oldest readable event position that is given; a directory reports gone members too; weak ETags match strong ones", async (c) => {
    await rec(c, [{ kind: "search", key: "q", scope: { query: "q" }, cursor: 5, hash: H("r") }, { kind: "directory", key: "d", members: ["a", "b"] }, { kind: "external", key: "https://example.invalid/x", etag: "\"t1\"", freshness: "conditional-read" }]);
    const ids = { q: await idOf(c, "q"), d: await idOf(c, "d"), x: await idOf(c, "https://example.invalid/x") };
    const by = Object.fromEntries((await c.deps.check(c.ann, c.task, { [ids.q]: { hash: H("r") }, [ids.d]: { members: ["a", "c"] }, [ids.x]: { etag: "W/\"t1\"" } })).map((r) => [r.key, r]));
    assert.equal(by["q"]!.status, "unknown");
    assert.deepEqual([by["d"]!.status, /new: c/.test(by["d"]!.detail), /gone: b/.test(by["d"]!.detail)], ["new-members", true, true]);
    assert.equal(by["https://example.invalid/x"]!.status, "unchanged");
  });
}
