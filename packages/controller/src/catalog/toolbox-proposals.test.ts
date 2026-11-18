import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RETENTION_DEFAULTS, RetentionService } from "../retention/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { ACCEPTANCE_LIMIT, CatalogService, SNAPSHOT_KIND, TOOLBOX_MANAGE, ToolboxProposalService, personalNamespace, versionIdOf } from "./index.js";

// Card T08 (second slice): improvement and promotion proposals with maintainer decisions, rebase and recheck, snapshots of released text, maintainer revocation and the notices pushed to authors and fork owners.
after(stopServer);

const options = { clock: () => "2026-11-18T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };
const NO_ID = `tpp-${"a".repeat(20)}`;

for (const backend of backends) {
  interface Agent { id: string; p: Principal; reauth(): Promise<Principal> }
  interface Ctx {
    cat: CatalogService; props: ToolboxProposalService; desks: DeskService; principals: PrincipalService; owner: Principal; a: string; b: string; ta: string; storage: ControllerStorage; epoch: number; told: { taskId: string; to: string; text: string }[];
    agent(name: string, grants: Grant[], extra?: { roles?: string[] }): Promise<Agent>;
    note(by: Principal, body: string, extra?: Record<string, unknown>): Promise<string>;
    /** Changes a stored record directly (what no service allows: the test stands for a record changed under the catalogue). */
    poke(kind: string, id: string, edit: (body: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "Garden" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "Orchard" })).id;
        const ta = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "T" })).id;
        const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
        for (const role of ["coder", "reviewer"]) await agents.defineRole(owner, { commandId: cid("role"), name: role, capabilities: [] });
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const cat = CatalogService.withEpoch(world.storage, projects.epoch, desks, options);
        const told: { taskId: string; to: string; text: string }[] = [];
        const props = ToolboxProposalService.withEpoch(world.storage, projects.epoch, cat, desks, options, async (m) => { told.push({ taskId: m.taskId, to: m.to, text: m.text }); });
        await body({
          cat, props, desks, principals, owner, a, b, ta, storage: world.storage, epoch: projects.epoch, told,
          agent: async (friendlyName, grants, extra = {}) => {
            const id = (await agents.create(owner, { commandId: cid("ag"), friendlyName, ...(extra.roles === undefined ? {} : { roles: extra.roles }) })).id;
            const pid = `agent:${id}`;
            await principals.setGrants(owner, { commandId: cid("g"), principalId: pid, expectedRevision: (await principals.get(pid))!.revision, grants });
            const reauth = async () => principals.authenticate((await principals.issueCredential(owner, `agent:${id}`)).token);
            return { id, p: await reauth(), reauth };
          },
          note: async (by, text, extra = {}) => (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title: "work", body: text, visibility: "shared", status: "accepted", ...extra } as never)).id,
          poke: async (kind, id, edit) => {
            const found = (await world.storage.getAggregate({ kind, id }))!;
            await world.storage.applyOperation({ operationId: cid("poke"), epoch: projects.epoch, actor: "test", correlationId: "poke", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind, id }, expectedRevision: found.revision, body: edit(found.body as Record<string, unknown>) as JsonObject }], audit: [{ type: "test.poke", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
          },
        });
      } finally { await world.close(); }
    });

  const worker = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "catalog.read", project: "*" }, { action: "catalog.register", project: "*" }];
  /** Ann writes the first release's text; the owner publishes it for coders; Cody (a coder) and Maya (maintains every audience) take part; Rita is a reviewer, Pat maintains Orchard only. */
  const cast = async (c: Ctx) => {
    const ann = await c.agent("Ann", worker(c.a));
    const cody = await c.agent("Cody", worker(c.a), { roles: ["coder"] });
    const maya = await c.agent("Maya", [...worker(c.a), { action: TOOLBOX_MANAGE, project: "*" }]);
    const rita = await c.agent("Rita", worker(c.a), { roles: ["reviewer"] });
    const pat = await c.agent("Pat", [...worker(c.a), { action: TOOLBOX_MANAGE, project: c.b }]);
    const readme = await c.note(ann.p, "Run lint on the changed files."); const code = await c.note(ann.p, "console.log('lint')");
    const v1 = await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, audience: { roles: ["coder"] } } as never);
    return { ann, cody, maya, rita, pat, readme, code, v1 };
  };

  suite("an improvement is proposed against an exact shared version, seen only by its author, the owner and the maintainers who may decide it, and every decision is told to the author; deferred proposals are not listed as available", async (c) => {
    const { cody, maya, rita, pat } = await cast(c);
    const better = await c.note(cody.p, "console.log('lint, faster')");
    const scratch = await c.note(cody.p, "console.log('half')", { visibility: "private" });
    const propose = (by: Principal, extra: Record<string, unknown> = {}) => c.props.propose(by, { commandId: cid("pp"), name: "lint", executableRecordId: better, rationale: "Lint only the changed lines; it is three times faster.", tests: "Ran it on the garden checkout: same findings.", taskId: c.ta, ...extra } as never);
    // Outside the audience the tool does not exist; private scratch and a patch that changes nothing are refused.
    await refuses("not_found", () => propose(rita.p), /you may read/);
    await refuses("invalid_command", () => propose(cody.p, { executableRecordId: scratch }), /private scratch/);
    await refuses("invalid_command", () => propose(cody.p, { executableRecordId: undefined }), /changes nothing/);
    await refuses("forbidden", () => c.props.propose(c.owner, { commandId: cid("pp"), name: "lint", executableRecordId: better, rationale: "x", tests: "y" } as never));
    const made = await propose(cody.p, { manifest: { ...manifest, requestedAccess: ["web.read"] } });
    assert.deepEqual([made.state, made.base.version, made.changes, made.permissionChanges], ["open", "1.0.0", { instructions: false, executable: true, manifest: true }, { added: ["web.read"], removed: [] }]);
    const id = made.proposalId;
    // Who sees it: the author, the owner, a maintainer covering the tool; not a reviewer, not a maintainer of another project (the same answer as for an ID never used).
    for (const p of [cody.p, c.owner, maya.p]) assert.equal((await c.props.get(p, id)).executable, "console.log('lint, faster')");
    for (const p of [rita.p, pat.p]) { await refuses("not_found", () => c.props.get(p, id), /no such proposal/); await refuses("not_found", () => c.props.get(p, NO_ID), /no such proposal/); }
    assert.deepEqual((await c.props.list(pat.p)).items, []);
    assert.deepEqual((await c.props.list(maya.p)).items.map((x) => [x.id, x.state, x.stale]), [[id, "open", false]]);
    // The author does not decide its own proposal; a decision other than accept says why.
    await refuses("forbidden", () => c.props.decide(cody.p, { commandId: cid("d"), proposalId: id, decision: "accept" }), /own proposal/);
    await refuses("not_found", () => c.props.decide(pat.p, { commandId: cid("d"), proposalId: id, decision: "reject", reason: "no" }));
    await refuses("invalid_command", () => c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "request_changes" }), /says why/);
    await c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "request_changes", reason: "keep the old flag working" });
    let inbox = await c.cat.notices(cody.p);
    assert.equal(inbox.items.length, 1);
    assert.match(inbox.items[0]!.text, /asked for changes .* keep the old flag working/);
    assert.equal(c.told.at(-1)?.taskId, c.ta, "the decision is also filed on the task the proposal names");
    // The author revises; the maintainer defers it, which takes it off the default list.
    const better2 = await c.note(cody.p, "console.log('lint, faster, old flag kept')");
    assert.equal((await c.props.revise(cody.p, { commandId: cid("rv"), proposalId: id, executableRecordId: better2, manifest: { ...manifest, requestedAccess: ["web.read"] } })).round, 2);
    await c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "defer", reason: "after the release freeze" });
    assert.deepEqual((await c.props.list(maya.p)).items, [], "a deferred proposal is not listed as available");
    assert.deepEqual((await c.props.list(maya.p, { state: "deferred" })).items.map((x) => x.id), [id]);
    await refuses("invalid_command", () => c.props.revise(cody.p, { commandId: cid("rv"), proposalId: id, executableRecordId: better }), /deferred/);
    inbox = await c.cat.notices(cody.p, { after: inbox.last });
    assert.equal(inbox.items.length, 1, "only the newer notice");
    assert.match(inbox.items[0]!.text, /deferred .*release freeze.* not listed as available/);
    await c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "reopen" });
    // Accepted with a release: one write publishes 1.1.0 and records the decision. The unchanged part keeps the base's text and author.
    const grantsBefore = await Promise.all([cody, maya].map(async (x) => (await c.principals.get(x.p.id))!.grants));
    const accepted = await c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "accept", version: "1.1.0" });
    assert.deepEqual([accepted.state, accepted.released?.version, accepted.authorizes], ["accepted", "1.1.0", ACCEPTANCE_LIMIT]);
    const v = (await c.cat.get(c.owner, "toolbox.lint"))!;
    assert.deepEqual([v.version, v.registeredBy, v.digest, v.manifest.requestedAccess], ["1.1.0", maya.p.id, accepted.released!.digest, ["web.read"]]);
    assert.notEqual(v.instructional.author, cody.p.id, "the instructions are still the original author's");
    assert.equal(v.executable!.author, cody.p.id);
    assert.equal((await c.cat.source(cody.p, "lint")).executable, "console.log('lint, faster, old flag kept')");
    assert.deepEqual((await c.props.get(maya.p, id)).released, { version: "1.1.0", digest: v.digest, versionId: versionIdOf("toolbox.lint", "1.1.0") });
    // Accepting authorised nothing else: nobody's grants changed (the new requested access is a request, not a grant).
    assert.deepEqual(await Promise.all([cody, maya].map(async (x) => (await c.principals.get(x.p.id))!.grants)), grantsBefore);
    inbox = await c.cat.notices(cody.p);
    assert.match(inbox.items.at(-1)!.text, /accepted your proposal .* released it as 1\.1\.0\. Accepting a proposal authorises nothing beyond the toolbox release named here: no grant, push, merge or deploy\./);
    await refuses("invalid_command", () => c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "reject", reason: "late" }), /accepted/);
    assert.deepEqual((await c.props.list(cody.p, { mine: true })).items, [], "an accepted proposal is no longer waiting");
    await refuses("forbidden", () => c.cat.notices(c.owner));
  });

  suite("a stale proposal is refused on acceptance, rebased onto the version in use and checked again; a conflicting rebase and a changed record are refused; the author withdraws", async (c) => {
    const { cody, maya, readme } = await cast(c);
    const exec2 = await c.note(cody.p, "console.log('lint 2')");
    const docs2 = await c.note(cody.p, "Run lint on the changed files, then on the tests.");
    const pExec = (await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", executableRecordId: exec2, rationale: "faster", tests: "ran it" })).proposalId;
    const pDocs = (await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", instructionsRecordId: docs2, rationale: "clearer", tests: "read it" })).proposalId;
    // The owner releases 1.1.0 with a different executable: both proposals are now against an older base.
    const ownExec = await c.note(cody.p, "console.log('lint by the owner')");
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.1.0", manifest, instructionsRecordId: readme, executableRecordId: ownExec } as never);
    assert.deepEqual((await c.props.list(maya.p)).items.map((x) => [x.stale, x.current]), [[true, "1.1.0"], [true, "1.1.0"]]);
    await refuses("stale_revision", () => c.props.decide(maya.p, { commandId: cid("d"), proposalId: pDocs, decision: "accept", version: "1.2.0" }), /rebase it first/);
    await refuses("stale_revision", () => c.props.decide(maya.p, { commandId: cid("d"), proposalId: pDocs, decision: "accept" }), /rebase it first/);
    assert.equal((await c.cat.get(c.owner, "toolbox.lint"))!.version, "1.1.0", "nothing was released");
    // The instructions-only proposal rebases cleanly (the maintainer may do it; the author is told); its executable now follows 1.1.0.
    const moved = await c.props.rebase(maya.p, { commandId: cid("rb"), proposalId: pDocs });
    assert.deepEqual([moved.from, moved.to], ["1.0.0", "1.1.0"]);
    assert.match((await c.cat.notices(cody.p)).items.at(-1)!.text, /moved your proposal .* onto 1\.1\.0/);
    await c.props.decide(maya.p, { commandId: cid("d"), proposalId: pDocs, decision: "accept", version: "1.2.0" });
    const src = await c.cat.source(maya.p, "toolbox.lint");
    assert.deepEqual([src.version, src.instructions, src.executable], ["1.2.0", "Run lint on the changed files, then on the tests.", "console.log('lint by the owner')"]);
    // The executable proposal conflicts with 1.1.0 (both changed the executable): refused, nothing changed; the author re-does it on the version in use.
    await refuses("command_conflict", () => c.props.rebase(cody.p, { commandId: cid("rb"), proposalId: pExec }), /also changed the executable/);
    assert.equal((await c.props.get(cody.p, pExec)).base?.version, "1.0.0");
    const exec3 = await c.note(cody.p, "console.log('lint 3, on the owner version')");
    await c.props.revise(cody.p, { commandId: cid("rv"), proposalId: pExec, executableRecordId: exec3, onLatest: true });
    const now = await c.props.get(cody.p, pExec);
    assert.deepEqual([now.base?.version, now.stale, now.round, now.changes.instructions], ["1.2.0", false, 2, false]);
    // A record changed after proposing fails the recheck: the author supersedes its record, a new release makes the proposal stale, the rebase reads the record again.
    const exec4 = await c.note(cody.p, "console.log('lint 4')");
    const p4 = (await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", executableRecordId: exec4, rationale: "r", tests: "t" })).proposalId;
    await c.note(cody.p, "console.log('lint 4b')", { supersedes: exec4 });
    const docs3 = await c.note(cody.p, "Run lint everywhere.");
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.3.0", manifest, instructionsRecordId: docs3, executableRecordId: exec2 } as never);
    // 1.3.0 changed the executable too, so the conflict answer comes first for p4; withdraw it instead, and check the recheck on a fresh one.
    await refuses("command_conflict", () => c.props.rebase(cody.p, { commandId: cid("rb"), proposalId: p4 }));
    await c.props.withdraw(cody.p, { commandId: cid("wd"), proposalId: p4, reason: "superseded" });
    assert.equal((await c.props.get(cody.p, p4)).state, "withdrawn");
    await refuses("invalid_command", () => c.props.withdraw(cody.p, { commandId: cid("wd"), proposalId: p4 }), /withdrawn/);
    await refuses("forbidden", () => c.props.withdraw(maya.p, { commandId: cid("wd"), proposalId: pExec }), /only the author/);
    const docs5 = await c.note(cody.p, "Run lint everywhere, twice.");
    const p5 = (await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", instructionsRecordId: docs5, rationale: "r", tests: "t" })).proposalId;
    await c.note(cody.p, "Run lint everywhere, three times.", { supersedes: docs5 });
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.4.0", manifest, instructionsRecordId: docs3, executableRecordId: exec3 } as never);
    await refuses("invalid_command", () => c.props.rebase(cody.p, { commandId: cid("rb"), proposalId: p5 }), /no longer as it was/);
  });

  suite("a proposal from a personal copy, and a promotion of a personal tool: only the author's own shared records, a free name, a decider covering the audience", async (c) => {
    const { cody, maya, pat } = await cast(c);
    // From a copy: Cody copies 1.0.0, makes 1.1.0 of the copy from its own records, and proposes that.
    await c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "my-lint" });
    const myDocs = await c.note(cody.p, "Run lint, my way."); const myCode = await c.note(cody.p, "console.log('my lint')");
    await c.cat.register(cody.p, { commandId: cid("reg"), name: "my-lint", kind: "tool", version: "1.1.0", manifest, instructionsRecordId: myDocs, executableRecordId: myCode });
    await refuses("invalid_command", () => c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", fromCopy: "my-lint", executableRecordId: myCode, rationale: "r", tests: "t" }), /fromCopy takes/);
    const fromCopy = await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", fromCopy: "my-lint", rationale: "my copy works better", tests: "used it for a week" });
    const got = await c.props.get(maya.p, fromCopy.proposalId);
    assert.deepEqual([got.base?.version, got.from?.name, got.from?.version, got.changes.instructions, got.changes.executable], ["1.0.0", `${personalNamespace(cody.p.id)}.my-lint`, "1.1.0", true, true]);
    // Promotion: a personal tool of Cody's own (not a copy) becomes a shared tool.
    const fmtDocs = await c.note(cody.p, "Format the code."); const fmtCode = await c.note(cody.p, "console.log('fmt')");
    await c.cat.register(cody.p, { commandId: cid("reg"), name: "fmt", kind: "tool", version: "1.0.0", manifest: { ...manifest, purpose: "format" }, instructionsRecordId: fmtDocs, executableRecordId: fmtCode });
    const secret = await c.note(cody.p, "console.log('mine only')", { visibility: "private" });
    await c.cat.register(cody.p, { commandId: cid("reg"), name: "quiet", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: fmtDocs, executableRecordId: secret });
    const promote = (extra: Record<string, unknown>) => c.props.promote(cody.p, { commandId: cid("pm"), name: "fmt", from: "fmt", rationale: "everyone formats", tests: "formatted the garden", ...extra } as never);
    await refuses("command_conflict", () => promote({ name: "lint" }), /is taken/);
    await refuses("invalid_command", () => promote({ from: "my-lint" }), /copy of toolbox\.lint/);
    await refuses("invalid_command", () => promote({ from: "quiet" }), /private scratch/);
    await refuses("not_found", () => promote({ from: `${personalNamespace(maya.p.id)}.fmt` }), /no personal tool/);
    // Review of slice 2: a suggestion names only teams and projects the author belongs to, and one that does not exist gets the same answer (promote tells no agent which teams or projects exist).
    const notMine = await promote({ audience: { projects: ["Orchard"] } }).then(() => "accepted", (e: unknown) => (e instanceof DomainError ? `${e.code}: ${e.message}` : String(e)));
    const unknown = await promote({ audience: { projects: ["Nowhere"] } }).then(() => "accepted", (e: unknown) => (e instanceof DomainError ? `${e.code}: ${e.message}` : String(e)));
    const noTeam = await promote({ audience: { teams: ["Ghosts"] } }).then(() => "accepted", (e: unknown) => (e instanceof DomainError ? `${e.code}: ${e.message}` : String(e)));
    assert.match(notMine, /^invalid_command: audience\.projects: a suggestion names .* you belong to/);
    assert.equal(unknown, notMine);
    assert.equal(noTeam, notMine.replace("audience.projects", "audience.teams"));
    const promoted = await promote({ audience: { projects: ["Garden"] } });
    // Pat maintains Orchard only: the suggested Garden audience is not its to decide, so the proposal does not exist for it.
    await refuses("not_found", () => c.props.get(pat.p, promoted.proposalId));
    const gardenMaint = await c.agent("Gil", [...worker(c.a), { action: TOOLBOX_MANAGE, project: c.a }]);
    assert.equal((await c.props.get(gardenMaint.p, promoted.proposalId)).kind, "promotion");
    // Gil may release it for Garden only, not for all agents.
    await refuses("forbidden", () => c.props.decide(gardenMaint.p, { commandId: cid("d"), proposalId: promoted.proposalId, decision: "accept", version: "1.0.0", audience: { all: true } }), /audience/);
    const acceptId = cid("d");
    const done = await c.props.decide(gardenMaint.p, { commandId: acceptId, proposalId: promoted.proposalId, decision: "accept", version: "1.0.0" });
    const shared = (await c.cat.get(c.owner, "toolbox.fmt"))!;
    assert.deepEqual([shared.layer, shared.registeredBy, shared.instructional.author, shared.digest], ["toolbox", gardenMaint.p.id, cody.p.id, done.released!.digest]);
    assert.deepEqual((await c.cat.toolbox(c.owner)).items.find((x) => x.name === "toolbox.fmt")?.audience, { projects: [c.a] });
    // A second promotion of the same name finds it taken now.
    await refuses("command_conflict", () => promote({}), /is taken/);
    // Review of slice 2: a repeat of the committed acceptance is answered from its record, even after the author superseded a record the release was made from.
    await c.note(cody.p, "console.log('fmt 2')", { supersedes: fmtCode });
    assert.deepEqual((await c.props.decide(gardenMaint.p, { commandId: acceptId, proposalId: promoted.proposalId, decision: "accept", version: "1.0.0" })).released, done.released);
  });

  suite("a release's snapshot keeps it readable after its desk record changes; a copy keeps its own; a revocation removes the release's snapshot; the owner's deletion of the record removes its text everywhere", async (c) => {
    const { cody, code } = await cast(c);
    const vid = versionIdOf("toolbox.lint", "1.0.0");
    assert.notEqual(await c.storage.getAggregate({ kind: SNAPSHOT_KIND, id: vid }), undefined, "a shared release keeps a snapshot");
    // The record's text changes under the catalogue (an edit no service allows today, standing for any later change): the release is still served as released.
    await c.poke("desk-record", code, (b) => ({ ...b, body: "console.log('edited later')" }));
    assert.equal((await c.cat.source(cody.p, "lint")).executable, "console.log('lint')");
    // A copy made now is of the released bytes, and keeps a snapshot of its own.
    const copy = await c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "my-lint" });
    assert.equal((await c.cat.source(cody.p, copy.name)).executable, "console.log('lint')");
    // A personal tool has no snapshot: changed text is refused, as before this card.
    const mine = await c.note(cody.p, "console.log('mine')");
    await c.cat.register(cody.p, { commandId: cid("reg"), name: "mine", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: mine, executableRecordId: mine });
    await c.poke("desk-record", mine, (b) => ({ ...b, body: "changed" }));
    await refuses("invalid_command", () => c.cat.source(cody.p, `${personalNamespace(cody.p.id)}.mine`), /changed since it was registered/);
    // Revoking the release removes its snapshot (a revoked version is never served from one); the copy still reads its own.
    await c.cat.revoke(c.owner, { commandId: cid("rv"), name: "toolbox.lint", version: "1.0.0", reason: "it deletes files", runningCalls: "finish" });
    assert.equal(await c.storage.getAggregate({ kind: SNAPSHOT_KIND, id: vid }), undefined);
    await refuses("invalid_command", () => c.cat.source(c.owner, "toolbox.lint", "1.0.0"), /changed since/);
    assert.equal((await c.cat.source(cody.p, copy.name)).executable, "console.log('lint')");
    // The owner deletes the record: the copy's snapshot of it goes too, and the copy reports the text as removed.
    const retention = RetentionService.withEpoch(c.storage, c.epoch, { settings: { effective: async () => ({ ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false }) } } as never, options);
    const deleted = await retention.delete(c.owner, { commandId: cid("del"), recordId: code, reason: "the owner asked" });
    assert.equal(deleted.status, "deleted", JSON.stringify(deleted));
    assert.equal(await c.storage.getAggregate({ kind: SNAPSHOT_KIND, id: copy.versionId }), undefined);
    await refuses("not_found", () => c.cat.source(cody.p, copy.name), /removed/);
  });

  suite("every decision reaches the author's inbox even after the proposal's history is at its limit (it keeps the last 50 events)", async (c) => {
    const { cody, maya } = await cast(c);
    const better = await c.note(cody.p, "console.log('lint, faster')");
    const id = (await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", executableRecordId: better, rationale: "r", tests: "t" })).proposalId;
    for (let i = 0; i < 30; i++) {
      await c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "defer", reason: `round ${i}` });
      await c.props.decide(maya.p, { commandId: cid("d"), proposalId: id, decision: "reopen" });
    }
    assert.equal((await c.props.get(cody.p, id)).history.length, 50);
    const inbox = await c.cat.notices(cody.p, { limit: 100 });
    assert.equal(inbox.items.length, 60);
    assert.match(inbox.items.at(-2)!.text, /round 29/);
  });

  suite("retention's drop of an old shared version removes its snapshot in the same write; the versions kept keep theirs", async (c) => {
    const { ann, readme } = await cast(c);
    for (const v of ["1.1.0", "1.2.0"]) await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: v, manifest, instructionsRecordId: readme, executableRecordId: await c.note(ann.p, `console.log('lint ${v}')`) } as never);
    const found = await c.cat.retentionCandidates(c.owner, 1, 10);
    const old = found.items.find((x) => x.name === "toolbox.lint" && x.version === "1.0.0")!;
    assert.ok(old !== undefined, JSON.stringify(found));
    assert.deepEqual(await c.cat.dropVersion(c.owner, { name: "toolbox.lint", version: "1.0.0", revision: old.revision, keep: 1 }), { dropped: true });
    assert.equal(await c.storage.getAggregate({ kind: SNAPSHOT_KIND, id: versionIdOf("toolbox.lint", "1.0.0") }), undefined);
    for (const v of ["1.1.0", "1.2.0"]) assert.notEqual(await c.storage.getAggregate({ kind: SNAPSHOT_KIND, id: versionIdOf("toolbox.lint", v) }), undefined, v);
  });

  suite("a maintainer revokes a shared version its grant covers (finish or cancel only); the fork owners are sent a notice once; other maintainers get not_found", async (c) => {
    const { cody, maya, pat } = await cast(c);
    await c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "my-lint" });
    await c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "other-lint" });
    const heard: [string, string, string | undefined, string | undefined][] = [];
    c.cat.onRevoked((name, version, choice, by) => heard.push([name, version, choice, by?.id]));
    const revoke = (by: Principal, extra: Record<string, unknown> = {}, commandId = cid("rv")) => c.cat.revoke(by, { commandId, name: "toolbox.lint", version: "1.0.0", reason: "it deletes files", ...extra } as never);
    await refuses("invalid_command", () => revoke(maya.p), /finish or cancel/);
    await refuses("invalid_command", () => revoke(maya.p, { runningCalls: "pause" }), /owner's decision/);
    await refuses("not_found", () => revoke(pat.p, { runningCalls: "cancel" }), /is not in the catalog/);
    await refuses("forbidden", () => revoke(cody.p, { runningCalls: "cancel" }), /only the owner revokes/);
    const key = cid("rv");
    await revoke(maya.p, { runningCalls: "cancel" }, key);
    assert.deepEqual(heard, [["toolbox.lint", "1.0.0", "cancel", undefined]], "a maintainer's revocation gives the listeners no owner to pause tasks with");
    assert.deepEqual((await c.cat.revocations(c.owner)).items.map((r) => r.revokedBy), [maya.p.id]);
    let inbox = await c.cat.notices(cody.p);
    assert.equal(inbox.items.length, 1, "one notice for both copies");
    assert.equal(inbox.items[0]!.kind, "revocation");
    assert.match(inbox.items[0]!.text, /toolbox\.lint 1\.0\.0 was revoked: it deletes files\. Your personal copies .*my-lint 1\.0\.0.*other-lint 1\.0\.0/);
    // The same revoke again is answered from the record and sends nothing new.
    await revoke(maya.p, { runningCalls: "cancel" }, key);
    inbox = await c.cat.notices(cody.p);
    assert.equal(inbox.items.length, 1);
    assert.equal((await c.cat.copies(cody.p)).items[0]!.baseRevoked?.reason, "it deletes files");
  });
}
