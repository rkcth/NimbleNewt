import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { CatalogService, checkHost, checkManifest, personalNamespace, runAction, type HostFacts } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const manifest = (extra: Record<string, unknown> = {}) => ({
  purpose: "fetch a page", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/fetch.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux", "darwin"], arch: ["x64", "arm64"], dependencies: [{ name: "undici", version: "7.0.0" }], requestedAccess: ["network.fetch"], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart", ...extra,
});
const host: HostFacts = { os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: { undici: "7.0.0" }, cpus: 4, memoryMb: 4096 };

for (const backend of backends) {
  interface Ctx { cat: CatalogService; desks: DeskService; owner: Principal; ann: Principal; ben: Principal; reader: Principal; a: string; b: string; ta: string; grants: GrantService; principals: PrincipalService; note(by: Principal, body: string, extra?: Record<string, unknown>): Promise<string> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        const worker = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }];
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const ann = await agent("ann", [...worker(a), { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: "history.read", project: a }]);
        const ben = await agent("ben", [...worker(a), { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }]);
        const reader = await agent("reader", [{ action: "history.read", project: b }, { action: "catalog.read", project: "*" }]);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        await body({
          cat: CatalogService.withEpoch(world.storage, projects.epoch, desks, options), desks, owner, ann, ben, reader, a, b, ta, grants, principals,
          note: async (by, text, extra = {}) => (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title: "work", body: text, visibility: "shared", status: "accepted", ...extra } as never)).id,
        });
      } finally { await world.close(); }
    });

  suite("a tool is registered from the registrant's own accepted work, in its own namespace, as an immutable version with a digest over its exact sources", async (c) => {
    const readme = await c.note(c.ann, "Use fetch to read a page."); const code = await c.note(c.ann, "console.log('fetch')");
    const v1 = await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.0.0", manifest: manifest(), instructionsRecordId: readme, executableRecordId: code });
    assert.equal(v1.name, `${personalNamespace(c.ann.id)}.fetch`);
    const got = (await c.cat.get(c.ann, v1.name))!;
    assert.deepEqual([got.version, got.digest === v1.digest, got.registeredBy, got.layer, got.kind], ["1.0.0", true, "agent:ann", "agent", "tool"]);
    assert.deepEqual([got.instructional.recordId, got.executable!.recordId], [readme, code]);
    assert.equal(await c.cat.content(c.ann, v1.name, "1.0.0", "executable"), "console.log('fetch')");
    // The same bytes again are a no-op; other bytes under the published version are refused; a version must go up.
    const again = await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.0.0", manifest: manifest(), instructionsRecordId: readme, executableRecordId: code });
    assert.equal(again.digest, v1.digest);
    await refuses("command_conflict", () => c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.0.0", manifest: manifest({ purpose: "something else" }), instructionsRecordId: readme, executableRecordId: code }));
    const newer = await c.note(c.ann, "console.log('fetch v2')");
    await refuses("invalid_command", () => c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "0.9.0", manifest: manifest(), instructionsRecordId: readme, executableRecordId: newer }));
    const v2 = await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.1.0", manifest: manifest(), instructionsRecordId: readme, executableRecordId: newer });
    assert.notEqual(v2.digest, v1.digest);
    assert.equal((await c.cat.get(c.ann, v1.name))!.version, "1.1.0", "the latest live version is chosen");
    assert.equal((await c.cat.get(c.ann, v1.name, "1.0.0"))!.digest, v1.digest, "the old version is unchanged");
    await refuses("invalid_command", () => c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "skill", version: "1.2.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: readme }), (e) => assert.match(e.message, /keeps its kind/));
    // An entry point the worker's runner could never start is refused when the tool is registered, not at its first use.
    for (const [n, entryPoint] of ["a/./b.js", "a//b.js", "bin/", "../x.js", "/abs.js"].entries()) await refuses("invalid_command", () => c.cat.register(c.ann, { commandId: cid("r"), name: `entry-${n}`, kind: "tool", version: "1.0.0", manifest: manifest({ entryPoint }), instructionsRecordId: readme, executableRecordId: code }), (e) => assert.match(e.message, /entry point/));
  });

  suite("only accepted original work of the registrant's own desk can be registered; another agent's content, a draft and a wrong kind of source are refused", async (c) => {
    const theirs = await c.note(c.ben, "ben's code"); const mine = await c.note(c.ann, "ann's notes");
    const draft = await c.note(c.ann, "unfinished", { status: "draft" });
    const reg = (executable: string | undefined, instructions = mine, kind: "tool" | "skill" = "tool") => c.cat.register(c.ann, { commandId: cid("r"), name: "tool-one", kind, version: "1.0.0", manifest: manifest(kind === "skill" ? { entryPoint: undefined, interpreter: undefined } : {}), instructionsRecordId: instructions, ...(executable === undefined ? {} : { executableRecordId: executable }) });
    await refuses("forbidden", () => reg(theirs));
    await refuses("forbidden", () => reg(mine, theirs));
    await refuses("invalid_command", () => reg(draft));
    await refuses("invalid_command", () => reg(undefined), (e) => assert.match(e.message, /needs its executable/));
    await refuses("invalid_command", () => reg(mine, mine, "skill").then(() => c.cat.register(c.ann, { commandId: cid("r"), name: "tool-two", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: mine, executableRecordId: mine })));
    // A copy of another agent's record is data too.
    await refuses("forbidden", () => reg("rec-aaaaaaaaaaaaaaaaaaaa"));
    await refuses("forbidden", () => c.cat.register(c.reader, { commandId: cid("r"), name: "x", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: mine }));
  });

  suite("shared and system releases are the owner's own versions: a personal edit cannot change them, and a personal tool is invisible to other agents", async (c) => {
    const note = await c.note(c.ann, "ann's instructions");
    const mine = await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: note });
    // The owner publishes a shared release from the owner's own work; it is a different name and its own versions.
    const ownerNote = { id: await c.note(c.ben, "ben's fetch instructions, reviewed and released by the owner") };
    const shared = await c.cat.register(c.owner, { commandId: cid("r"), name: "toolbox.fetch", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: ownerNote.id });
    const system = await c.cat.register(c.owner, { commandId: cid("r"), name: "nimblenewt.fetch", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: ownerNote.id });
    assert.equal((await c.cat.get(c.owner, "toolbox.fetch"))!.instructional.author, "agent:ben", "the author stays recorded");
    const scratch = await c.note(c.ben, "private thinking", { visibility: "private" });
    await refuses("forbidden", () => c.cat.register(c.owner, { commandId: cid("r"), name: "toolbox.scratch", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: scratch }));
    const unfinished = await c.note(c.ben, "not accepted", { status: "draft" });
    await refuses("invalid_command", () => c.cat.register(c.owner, { commandId: cid("r"), name: "toolbox.draft", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: unfinished }));
    assert.deepEqual([shared.name, system.name, mine.name === shared.name], ["toolbox.fetch", "nimblenewt.fetch", false]);
    const note2 = await c.note(c.ann, "ann edits her own");
    await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "skill", version: "2.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: note2 });
    assert.equal((await c.cat.get(c.ben, "toolbox.fetch"))!.version, "1.0.0");
    assert.equal((await c.cat.get(c.ben, "toolbox.fetch"))!.digest, shared.digest, "the shared release did not move");
    // An agent cannot register shared or system names, or another agent's namespace.
    await refuses("invalid_command", () => c.cat.register(c.ann, { commandId: cid("r"), name: "toolbox.evil", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: note }));
    await refuses("invalid_command", () => c.cat.register(c.ann, { commandId: cid("r"), name: `${personalNamespace(c.ben.id)}.evil`, kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: note }));
    await refuses("invalid_command", () => c.cat.register(c.owner, { commandId: cid("r"), name: mine.name, kind: "skill", version: "9.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: ownerNote.id }));
    // Visibility.
    assert.equal(await c.cat.get(c.ben, mine.name), undefined, "another agent does not see a personal artifact");
    assert.ok((await c.cat.get(c.owner, mine.name)) !== undefined);
    assert.deepEqual((await c.cat.list(c.ben)).map((x) => x.name).sort(), ["nimblenewt.fetch", "toolbox.fetch"]);
    assert.deepEqual((await c.cat.list(c.ann)).map((x) => x.name).sort(), [mine.name, "nimblenewt.fetch", "toolbox.fetch"].sort());
    assert.equal((await c.cat.list(c.owner)).length, 3);
  });

  suite("a skill cannot run anything, a tool needs a grant naming it, a revoked version is refused and the latest live one is chosen", async (c) => {
    const readme = await c.note(c.ann, "docs"); const code = await c.note(c.ann, "code"); const code2 = await c.note(c.ann, "code 2");
    const skill = await c.cat.register(c.ann, { commandId: cid("r"), name: "howto", kind: "skill", version: "1.0.0", manifest: manifest({ entryPoint: undefined, interpreter: undefined }), instructionsRecordId: readme });
    const tool = await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.0.0", manifest: manifest(), instructionsRecordId: readme, executableRecordId: code });
    const run = (by: Principal, name: string, version?: string, h: HostFacts = host) => c.cat.authorizeRun(by, { commandId: cid("u"), name, ...(version === undefined ? {} : { version }), taskId: c.ta, projectId: c.a, host: h });
    await refuses("forbidden", () => run(c.ann, skill.name), (e) => assert.match(e.message, /cannot run anything/));
    // An agent holds the grant for its own tool namespace from enrolment (card T06b): it needs no grant from the owner to run what it made itself.
    assert.equal((await run(c.ann, tool.name)).ready, true);
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: c.ann.id, action: runAction(tool.name), project: c.a, source: "direct", basis: "may run fetch" });
    const ann = await c.principals.authenticate((await c.principals.issueCredential(c.owner, c.ann.id)).token);
    const ok = await run(ann, tool.name);
    assert.deepEqual([ok.ready, ok.ready && ok.version], [true, "1.0.0"]);
    // Another agent has no grant and cannot even see a personal tool.
    await refuses("forbidden", () => run(c.ben, tool.name));
    // A task of another project is not a place to run it.
    await refuses("forbidden", () => c.cat.authorizeRun(ann, { commandId: cid("u"), name: tool.name, taskId: c.ta, projectId: c.b, host }));
    // A newer version, then revoked: the earlier live one is chosen again and a run of the revoked one is refused.
    await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.1.0", manifest: manifest(), instructionsRecordId: readme, executableRecordId: code2 });
    assert.equal((await run(ann, tool.name) as { version: string }).version, "1.1.0");
    await refuses("forbidden", () => c.cat.revoke(ann, { commandId: cid("v"), name: tool.name, version: "1.1.0", reason: "bad" }));
    await c.cat.revoke(c.owner, { commandId: cid("v"), name: tool.name, version: "1.1.0", reason: "it leaked a token: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });
    assert.equal((await run(ann, tool.name) as { version: string }).version, "1.0.0");
    await refuses("forbidden", () => run(ann, tool.name, "1.1.0"), (e) => assert.match(e.message, /revoked/));
    assert.ok(!JSON.stringify((await c.cat.get(c.owner, tool.name, "1.1.0"))!.revoked).includes("sk-ant-api03"));
    await refuses("invalid_command", () => c.cat.revoke(c.owner, { commandId: cid("v"), name: tool.name, version: "1.1.0", reason: "again" }));
    await refuses("not_found", () => c.cat.revoke(c.owner, { commandId: cid("v"), name: tool.name, version: "7.0.0", reason: "none" }));
  });

  suite("a version can be set aside or rolled back by the owner: it is no longer chosen, a task that pinned it still runs it, nothing is deleted, and a revoked one is refused (card T02)", async (c) => {
    const readme = await c.note(c.ann, "docs");
    const reg = async (version: string) => c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version, manifest: manifest(), instructionsRecordId: readme, executableRecordId: await c.note(c.ann, `code ${version}`) });
    const tool = await reg("1.0.0"); await reg("1.1.0"); await reg("1.2.0");
    const ann = await c.principals.authenticate((await c.principals.issueCredential(c.owner, c.ann.id)).token);
    const run = (version?: string) => c.cat.authorizeRun(ann, { commandId: cid("u"), name: tool.name, ...(version === undefined ? {} : { version }), taskId: c.ta, projectId: c.a, host });
    assert.equal((await run() as { version: string }).version, "1.2.0");
    // Only the owner changes which version is chosen.
    await refuses("forbidden", () => c.cat.rollback(ann, { commandId: cid("b"), name: tool.name, toVersion: "1.0.0", reason: "not mine" }));
    await refuses("forbidden", () => c.cat.deprecate(ann, { commandId: cid("b"), name: tool.name, version: "1.2.0", reason: "not mine" }));
    await c.cat.deprecate(c.owner, { commandId: cid("d"), name: tool.name, version: "1.2.0", reason: "slow" });
    assert.equal((await run() as { version: string }).version, "1.1.0", "the next one down is chosen");
    assert.equal((await run("1.2.0") as { version: string }).version, "1.2.0", "a task that pinned the deprecated version still runs it");
    assert.equal((await c.cat.get(c.owner, tool.name, "1.2.0"))!.version, "1.2.0", "it is kept for inspection");
    // Rolling back sets aside everything above the target; the target comes back into use if it had been set aside.
    await c.cat.rollback(c.owner, { commandId: cid("b"), name: tool.name, toVersion: "1.0.0", reason: "1.1 breaks resumes" });
    assert.equal((await run() as { version: string }).version, "1.0.0");
    assert.equal((await run("1.1.0") as { version: string }).version, "1.1.0", "set aside, not withdrawn");
    await refuses("not_found", () => c.cat.rollback(c.owner, { commandId: cid("b"), name: tool.name, toVersion: "9.9.9", reason: "none" }));
    // A revoked version cannot be rolled back to, and stays revoked whatever is chosen.
    await c.cat.revoke(c.owner, { commandId: cid("v"), name: tool.name, version: "1.0.0", reason: "leaked" });
    await refuses("invalid_command", () => c.cat.rollback(c.owner, { commandId: cid("b"), name: tool.name, toVersion: "1.0.0", reason: "back" }));
    await refuses("forbidden", () => run("1.0.0"), (e) => assert.match(e.message, /revoked/));
    await c.cat.rollback(c.owner, { commandId: cid("b"), name: tool.name, toVersion: "1.1.0", reason: "back to 1.1" });
    assert.equal((await run() as { version: string }).version, "1.1.0");
    // Publishing a new version keeps what was set aside: the version rolled back from does not come back when the new one is revoked.
    await c.cat.rollback(c.owner, { commandId: cid("b"), name: tool.name, toVersion: "1.1.0", reason: "no change" });
    await reg("1.3.0");
    assert.equal((await run() as { version: string }).version, "1.3.0");
    await c.cat.revoke(c.owner, { commandId: cid("v"), name: tool.name, version: "1.3.0", reason: "bad" });
    assert.equal((await run() as { version: string }).version, "1.1.0", "1.2.0 stays set aside");
  });

  suite("a host that cannot run a tool is told why before anything starts, and a run is recorded with who, which exact version, task and project, visible only inside that project", async (c) => {
    const readme = await c.note(c.ann, "docs"); const code = await c.note(c.ann, "code");
    const tool = await c.cat.register(c.ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.0.0", manifest: manifest(), instructionsRecordId: readme, executableRecordId: code });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: c.ann.id, action: runAction(tool.name), project: c.a, source: "direct", basis: "x" });
    const ann = await c.principals.authenticate((await c.principals.issueCredential(c.owner, c.ann.id)).token);
    const run = (h: HostFacts) => c.cat.authorizeRun(ann, { commandId: cid("u"), name: tool.name, taskId: c.ta, projectId: c.a, host: h });
    const bad = await run({ os: "win32", arch: "x64", interpreters: { node: "20.0.0" }, packages: {}, cpus: 1, memoryMb: 100 });
    assert.equal(bad.ready, false);
    assert.equal(bad.ready ? [] : bad.reasons.length, 4, bad.ready ? "" : bad.reasons.join(" | "));
    assert.deepEqual((await c.cat.usage(c.owner, { projectId: c.a })).items, [], "nothing is recorded for a run that cannot start");
    const id = cid("u");
    const good = await c.cat.authorizeRun(ann, { commandId: id, name: tool.name, taskId: c.ta, projectId: c.a, host });
    await c.cat.authorizeRun(ann, { commandId: id, name: tool.name, taskId: c.ta, projectId: c.a, host });
    assert.equal(good.ready, true);
    const uses = (await c.cat.usage(c.owner, { projectId: c.a })).items;
    assert.equal(uses.length, 1, "a repeated command is one use");
    assert.deepEqual([uses[0]!.usedBy, uses[0]!.version, uses[0]!.digest === tool.digest, uses[0]!.taskId, uses[0]!.projectId], ["agent:ann", "1.0.0", true, c.ta, c.a]);
    assert.equal((await c.cat.usage(ann, { projectId: c.a })).items.length, 1);
    const paged = await c.cat.usage(c.owner, { projectId: c.a, limit: 1 });
    assert.deepEqual([paged.items.length, paged.next !== undefined], [1, true]);
    assert.deepEqual((await c.cat.usage(c.owner, { projectId: c.a, limit: 1, after: paged.next! })).items, []);
    await refuses("forbidden", () => c.cat.usage(c.reader, { projectId: c.a }));
    assert.deepEqual((await c.cat.usage(c.reader, { projectId: c.b })).items, [], "another project's readers see nothing of A");
    await refuses("forbidden", () => c.cat.usage(c.ben, { projectId: c.a }));
  });

  suite("manifests are checked field by field, and a host check names every reason", async () => {
    for (const bad of [{ purpose: "" }, { os: [] }, { os: ["plan9"] }, { arch: ["mips"] }, { limits: { cpus: 0, memoryMb: 1, seconds: 1 } }, { limits: undefined }, { cancellation: "ask nicely" }, { recovery: "pray" }, { entryPoint: "../escape.sh" }, { entryPoint: "/abs.sh" }, { dependencies: [{ name: "x" }] }, { input: [] }, { output: { $ref: "https://evil.example/schema" } }, { requestedAccess: ["Not An Action"] }, { extra: 1 }, { interpreter: { name: "node" } }]) assert.throws(() => checkManifest(manifest(bad), "tool"), (e) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(bad));
    assert.throws(() => checkManifest(manifest(), "skill"), (e) => e instanceof DomainError && /instructions only/.test(e.message));
    assert.throws(() => checkManifest(manifest({ input: { type: "x".repeat(9000) } }), "tool"), (e) => e instanceof DomainError && /at most/.test(e.message));
    const m = checkManifest(manifest({ os: ["darwin", "linux", "linux"] }), "tool");
    assert.deepEqual(m.os, ["darwin", "linux"]);
    assert.deepEqual(checkHost(m, host), { ok: true, reasons: [] });
    const reasons = checkHost(m, { os: "win32", arch: "arm64", interpreters: {}, packages: { undici: "6.0.0" }, cpus: 0, memoryMb: 10 }).reasons;
    assert.equal(reasons.length, 5);
    assert.ok(reasons.every((r) => typeof r === "string" && r.length > 10));
  });

  suite("revoking falls back to the highest live version, whatever its number, and a revoked number is never reused or backported", async (c) => {
    const doc = await c.note(c.ann, "docs");
    const reg = async (version: string) => c.cat.register(c.ann, { commandId: cid("r"), name: "multi", kind: "tool", version, manifest: manifest(), instructionsRecordId: doc, executableRecordId: await c.note(c.ann, `code ${version}`) });
    const first = await reg("1.0.5"); const name = first.name;
    await reg("1.1.0"); await reg("2.0.0"); await reg("2.0.250");
    const latest = async () => (await c.cat.get(c.ann, name))?.version;
    assert.equal(await latest(), "2.0.250");
    await c.cat.revoke(c.owner, { commandId: cid("v"), name, version: "2.0.250", reason: "r" });
    assert.equal(await latest(), "2.0.0");
    await c.cat.revoke(c.owner, { commandId: cid("v"), name, version: "2.0.0", reason: "r" });
    assert.equal(await latest(), "1.1.0");
    await c.cat.revoke(c.owner, { commandId: cid("v"), name, version: "1.1.0", reason: "r" });
    assert.equal(await latest(), "1.0.5", "the highest live version, not the nearest x.y.0");
    await c.cat.revoke(c.owner, { commandId: cid("v"), name, version: "1.0.5", reason: "r" });
    assert.equal(await latest(), undefined, "all revoked: none");
    assert.equal((await c.cat.get(c.ann, name, "1.0.5"))!.revoked?.reason, "r");
    await refuses("invalid_command", () => reg("1.9.9"), (e) => assert.match(e.message, /higher/));
  });

  suite("schemas may refer only to themselves", async () => {
    for (const bad of [{ $ref: "https://evil.example/s" }, { $ref: "ftp://x/y" }, { $ref: "urn:x:y" }, { $ref: "//host/x" }, { $ref: "data:application/json,{}" }, { a: { b: [{ $ref: "other.json" }] } }, { $id: "https://x/y" }, { $schema: "https://evil.example/meta" }, { $dynamicRef: "http://x" }]) assert.throws(() => checkManifest(manifest({ input: bad }), "tool"), (e) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(bad));
    checkManifest(manifest({ input: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { a: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string" } } } }), "tool");
  });
}
