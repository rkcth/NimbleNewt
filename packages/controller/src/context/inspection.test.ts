import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConversationService } from "../conversations/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type World } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { DeskService, HistoryService, InspectionService, PublicationService, RetrievalService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    world: World; owner: Principal; a: string; b: string;
    desks: DeskService; inspection: InspectionService; paths: PublicationService; retrieval: RetrievalService; conversations: ConversationService; grants: GrantService; principals: PrincipalService;
    ann: Principal; ben: Principal; both: Principal; service: Principal;
    agent(name: string, grants?: Grant[]): Promise<Principal>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const make = async (kind: "agent" | "service", name: string, grants: Grant[] = []) => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name, grants });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${name}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const writer = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }];
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        await body({
          world, owner, a, b, desks, histories: undefined as never, inspection: InspectionService.withEpoch(world.storage, projects.epoch, options), paths: PublicationService.withEpoch(world.storage, projects.epoch, options),
          retrieval: RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options), conversations: ConversationService.withEpoch(world.storage, projects.epoch, options),
          grants: GrantService.withEpoch(world.storage, projects.epoch, options), principals,
          ann: await make("agent", "ann", [...writer(a), ...writer(b)]), ben: await make("agent", "ben", writer(a)), both: await make("agent", "both", [...writer(a), ...writer(b)]),
          service: await make("service", "recovery", [{ action: "recovery.read", project: "*" }]), agent: (name, grants) => make("agent", name, grants),
        } as Ctx);
      } finally { await world.close(); }
    });
  const rec = (project: string, extra: Record<string, unknown> = {}) => ({ commandId: cid("w"), projectId: project, kind: "note" as const, title: "a note", body: "something worth keeping", visibility: "shared" as const, status: "accepted" as const, ...extra });
  const audit = async (c: Ctx, type: string) => (await c.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((e) => e.type === type);

  suite("the owner reads everything the ordinary way; an inspection is an optional recorded look under the policy, kept where the agent can see it", async (c) => {
    const scratch = await c.desks.write(c.ann, rec(c.a, { visibility: "private", title: "thinking", body: "maybe the vendor is wrong" }));
    const draft = await c.desks.write(c.ann, rec(c.a, { status: "draft", title: "unfinished" }));
    const published = await c.desks.write(c.ann, rec(c.a, { title: "public" }));
    // The owner reads them the ordinary way, with no reason and no record; peers still cannot.
    assert.equal((await c.desks.read(c.owner, scratch.id)).body, "maybe the vendor is wrong");
    assert.equal((await c.desks.read(c.owner, draft.id)).title, "unfinished");
    assert.deepEqual((await c.desks.list(c.owner, { ownerId: "agent:ann", limit: 10 })).items.map((i) => i.id).sort(), [scratch.id, draft.id, published.id].sort());
    assert.ok((await c.retrieval.search(c.owner, { projectId: c.a, query: "vendor" })).hits.length > 0);
    assert.deepEqual((await c.inspection.inspections(c.ann)).items, [], "an ordinary read leaves nothing for the agent to see");
    await refuses("forbidden", () => c.desks.read(c.ben, scratch.id));
    // Policy: allowed by default; only the owner changes it.
    assert.deepEqual(await c.inspection.policy(), { scratch: "allowed", revision: 0 });
    await refuses("forbidden", () => c.inspection.setPolicy(c.ann, { commandId: cid("p"), scratch: "denied" }));
    const look = await c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: scratch.id, reason: "troubleshooting a stuck task" });
    assert.equal(look.record!.body, "maybe the vendor is wrong");
    assert.equal((await c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: draft.id, reason: "checking progress" })).record!.title, "unfinished");
    const mine = await c.inspection.inspections(c.ann);
    assert.deepEqual(mine.items.map((i) => [i.inspector, i.via, i.recordId === scratch.id || i.recordId === draft.id, i.policy]), [["owner:rob", "owner", true, "allowed"], ["owner:rob", "owner", true, "allowed"]]);
    assert.equal(mine.items.find((i) => i.id === look.inspectionId)!.reason, "troubleshooting a stuck task");
    assert.deepEqual((await c.inspection.inspections(c.ben)).items, [], "another agent sees nothing of it");
    assert.equal((await c.inspection.inspections(c.owner)).items.length, 2);
    assert.equal((await audit(c, "desk.inspect")).length, 2);
    // A repeat of the same command is one look.
    const again = await c.inspection.inspect(c.owner, { commandId: "same-look", recordId: scratch.id, reason: "once" });
    const twice = await c.inspection.inspect(c.owner, { commandId: "same-look", recordId: scratch.id, reason: "once" });
    assert.equal(again.inspectionId, twice.inspectionId);
    assert.deepEqual([again.replayed, again.record !== undefined, twice.replayed, twice.record], [false, true, true, undefined], "a repeat of a look returns the record of the look, not the content");
    assert.equal((await audit(c, "desk.inspect")).length, 3);
    // Reading again, or reading later content, is another look with its own command and its own record.
    const revised = await c.desks.write(c.ann, rec(c.a, { status: "draft", title: "version one" }));
    const first = await c.inspection.inspect(c.owner, { commandId: "look-draft", recordId: revised.id, reason: "first look" });
    await c.desks.revise(c.ann, { commandId: cid("rv"), recordId: revised.id, expectedRevision: 1, title: "version two" });
    assert.equal((await c.inspection.inspect(c.owner, { commandId: "look-draft", recordId: revised.id, reason: "first look" })).record, undefined);
    const second = await c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: revised.id, reason: "second look" });
    assert.deepEqual([first.record!.title, second.record!.title], ["version one", "version two"]);
    assert.equal((await audit(c, "desk.inspect")).length, 5);
    // Published records are read the ordinary way; missing ones are missing; others cannot inspect; a reason is needed and may not hold a credential.
    await refuses("invalid_command", () => c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: published.id, reason: "x" }), (e) => assert.match(e.message, /published/));
    await refuses("not_found", () => c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: "dsk-aaaaaaaaaaaaaaaaaaaa", reason: "x" }));
    await refuses("forbidden", () => c.inspection.inspect(c.ben, { commandId: cid("i"), recordId: scratch.id, reason: "x" }));
    await refuses("invalid_command", () => c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: scratch.id, reason: "" }));
    await refuses("invalid_command", () => c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: scratch.id, reason: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
    await refuses("invalid_command", () => c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: "nope", reason: "x" }));
    // Denying the owner's inspection stops it, and nothing is recorded for a refused look.
    const set = await c.inspection.setPolicy(c.owner, { commandId: cid("p"), scratch: "denied" });
    await refuses("forbidden", () => c.inspection.inspect(c.owner, { commandId: cid("i"), recordId: scratch.id, reason: "x" }), (e) => assert.match(e.message, /policy does not allow/));
    assert.equal((await audit(c, "desk.inspect")).length, 5);
    await refuses("stale_revision", () => c.inspection.setPolicy(c.owner, { commandId: cid("p"), scratch: "allowed" }));
    await c.inspection.setPolicy(c.owner, { commandId: cid("p"), scratch: "allowed", expectedRevision: set.revision });
    assert.equal((await c.inspection.policy()).scratch, "allowed");
  });

  suite("the recovery service is a service principal that only the owner creates; it reads unpublished records to restore state, and no agent, grant or conversation can make use of it", async (c) => {
    const scratch = await c.desks.write(c.ann, rec(c.a, { visibility: "private", body: "recovery needs this" }));
    const look = await c.inspection.recoveryRead(c.service, { commandId: cid("r"), recordId: scratch.id, reason: "restoring ann after a crash" });
    assert.equal(look.record!.body, "recovery needs this");
    const seen = (await c.inspection.inspections(c.ann)).items[0]!;
    assert.deepEqual([seen.inspector, seen.via, seen.policy], ["service:recovery", "recovery", "not-applicable"]);
    assert.equal((await audit(c, "desk.recovery-read")).length, 1);
    // The service has no other way in: not the ordinary read, and a policy denying the owner does not apply to it.
    await refuses("forbidden", () => c.desks.read(c.service, scratch.id));
    await c.inspection.setPolicy(c.owner, { commandId: cid("p"), scratch: "denied" });
    assert.ok(await c.inspection.recoveryRead(c.service, { commandId: cid("r"), recordId: scratch.id, reason: "again" }));
    // An agent cannot use the service's path, even holding the same grant name; the owner path is not the service's either.
    const holder = await c.agent("holder", [{ action: "recovery.read", project: "*" }]);
    await refuses("forbidden", () => c.inspection.recoveryRead(holder, { commandId: cid("r"), recordId: scratch.id, reason: "x" }));
    await refuses("forbidden", () => c.inspection.recoveryRead(c.ann, { commandId: cid("r"), recordId: scratch.id, reason: "x" }));
    await refuses("forbidden", () => c.inspection.inspect(c.service, { commandId: cid("r"), recordId: scratch.id, reason: "x" }));
    const bare = await c.principals.authenticate((await (async () => { await c.principals.enroll(c.owner, { commandId: cid("e"), kind: "service", name: "bare" }); return c.principals.issueCredential(c.owner, "service:bare"); })()).token);
    await refuses("forbidden", () => c.inspection.recoveryRead(bare, { commandId: cid("r"), recordId: scratch.id, reason: "x" }));
    // A service may hold only recovery actions, however it is granted.
    for (const bad of ["task.read", "*", "recovery.*", "desk.scratch.read", "conversation.send"]) {
      await refuses("invalid_command", () => c.principals.enroll(c.owner, { commandId: cid("e"), kind: "service", name: `x${n}`, grants: [{ action: bad, project: "*" }] }), (e) => assert.match(e.message, /only recovery actions/));
      await refuses("invalid_command", () => c.grants.grant(c.owner, { commandId: cid("g"), grantee: "service:bare", action: bad, project: c.a, source: "direct", basis: "test" }), (e) => assert.match(e.message, /only recovery actions/));
    }
    // It cannot be addressed in a conversation, and a conversation cannot start as it.
    await refuses("invalid_command", () => c.conversations.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["service:recovery"], text: "hello recovery" }), (e) => assert.match(e.message, /to\[0\]/));
    await refuses("forbidden", () => c.conversations.start(c.service, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:ann"], text: "x" }));
  });

  suite("a record moves between projects only along a path the owner opened, one way, and a closed path stops later citations and copies", async (c) => {
    const inA = await c.desks.write(c.both, rec(c.a, { title: "a finding", body: "the cause is the cache" }));
    await refuses("forbidden", () => c.paths.open(c.both, { commandId: cid("o"), fromProject: c.a, toProject: c.b, reason: "x" }));
    await refuses("forbidden", () => c.desks.write(c.both, rec(c.b, { sources: [inA.id] })), (e) => assert.match(e.message, /has not opened a path/));
    await refuses("forbidden", () => c.desks.copy(c.both, { commandId: cid("c"), recordId: inA.id, projectId: c.b }), (e) => assert.match(e.message, /has not opened a path/));
    await refuses("invalid_command", () => c.paths.open(c.owner, { commandId: cid("o"), fromProject: c.a, toProject: c.a, reason: "x" }));
    await refuses("not_found", () => c.paths.open(c.owner, { commandId: cid("o"), fromProject: c.a, toProject: "proj-aaaaaaaaaaaaaaaaaaaa", reason: "x" }));
    const opened = await c.paths.open(c.owner, { commandId: cid("o"), fromProject: c.a, toProject: c.b, reason: "the same team works on both" });
    await refuses("invalid_command", () => c.paths.open(c.owner, { commandId: cid("o"), fromProject: c.a, toProject: c.b, reason: "again" }), (e) => assert.match(e.message, /already open/));
    assert.equal(await c.paths.isOpen(c.a, c.b), true);
    assert.equal(await c.paths.isOpen(c.b, c.a), false, "a path goes one way");
    const cited = await c.desks.write(c.both, rec(c.b, { title: "from a", sources: [inA.id] }));
    assert.deepEqual((await c.desks.read(c.both, cited.id)).sources, [inA.id]);
    const copy = await c.desks.copy(c.both, { commandId: cid("c"), recordId: inA.id, projectId: c.b });
    assert.equal((await c.desks.read(c.both, copy.id)).projectId, c.b);
    // Nothing goes the other way, and a record that cannot be read cannot be cited.
    const inB = await c.desks.write(c.both, rec(c.b, { title: "b finding" }));
    await refuses("forbidden", () => c.desks.write(c.both, rec(c.a, { sources: [inB.id] })));
    const hidden = await c.desks.write(c.ann, rec(c.a, { visibility: "private" }));
    await refuses("invalid_command", () => c.desks.write(c.both, rec(c.a, { sources: [hidden.id] })), (e) => assert.match(e.message, /not a record you can read/));
    await refuses("invalid_command", () => c.desks.write(c.both, rec(c.a, { sources: ["dsk-aaaaaaaaaaaaaaaaaaaa"] })));
    for (const bad of ["x", Array.from({ length: 21 }, (_, i) => `dsk-${"a".repeat(19)}${"abcdefg"[i % 7]}${i}`)]) await refuses("invalid_command", () => c.desks.write(c.both, rec(c.a, { sources: bad as never })));
    // Closing it stops later ones; what was copied stays.
    await c.paths.close(c.owner, { commandId: cid("cl"), fromProject: c.a, toProject: c.b, expectedRevision: opened.revision });
    await refuses("forbidden", () => c.desks.copy(c.both, { commandId: cid("c"), recordId: inA.id, projectId: c.b }));
    await refuses("forbidden", () => c.desks.write(c.both, rec(c.b, { sources: [inA.id] })));
    assert.ok(await c.desks.read(c.both, copy.id));
    await refuses("invalid_command", () => c.paths.close(c.owner, { commandId: cid("cl"), fromProject: c.a, toProject: c.b, expectedRevision: opened.revision + 1 }), (e) => assert.match(e.message, /already closed/));
    assert.equal((await c.paths.get(c.owner, c.a, c.b))!.state, "closed");
    assert.equal(await c.paths.get(c.both, c.a, c.b), undefined);
    // A summary stays inside one project whatever paths exist.
    await refuses("invalid_command", () => c.retrieval.summarize(c.both, { commandId: cid("sm"), projectId: c.b, title: "t", text: "summary", sources: [{ kind: "desk-record", id: inA.id }] }), (e) => assert.match(e.message, /belong to the project/));
  });

  suite("a copy is never more public than its source, and a scratch grant is bound by the inspection policy like the owner is", async (c) => {
    const secret = await c.desks.write(c.ann, rec(c.a, { visibility: "private", title: "private thoughts", body: "alice private thoughts" }));
    const draft = await c.desks.write(c.ann, rec(c.a, { status: "draft", title: "half done", body: "alice draft" }));
    const published = await c.desks.write(c.ann, rec(c.a, { title: "published", body: "alice public" }));
    const sup = await c.agent("sup", [...[{ action: "desk.write", project: c.a }, { action: "desk.read", project: c.a }], { action: "desk.scratch.read", project: c.a }]);
    const bob = await c.agent("bob", [{ action: "desk.read", project: c.a }]);
    // The supervisor may read the scratch (an explicit grant) but cannot publish a copy of it.
    assert.equal((await c.desks.read(sup, secret.id)).body, "alice private thoughts");
    await refuses("invalid_command", () => c.desks.copy(sup, { commandId: cid("c"), recordId: secret.id, visibility: "shared" }), (e) => assert.match(e.message, /only into your own private scratch/));
    // A draft is its owner's alone, so a peer cannot copy it at all; its owner may copy it, but not into a shared record.
    await refuses("forbidden", () => c.desks.copy(sup, { commandId: cid("c"), recordId: draft.id }));
    await refuses("invalid_command", () => c.desks.copy(c.ann, { commandId: cid("c"), recordId: draft.id, visibility: "shared" }), (e) => assert.match(e.message, /only into your own private scratch/));
    const kept = await c.desks.copy(sup, { commandId: cid("c"), recordId: secret.id });
    await c.desks.revise(sup, { commandId: cid("rv"), recordId: kept.id, expectedRevision: 1, status: "accepted" });
    await refuses("forbidden", () => c.desks.read(bob, kept.id));
    assert.deepEqual((await c.desks.list(bob, { ownerId: "agent:sup", limit: 10 })).items, []);
    assert.equal((await c.desks.copy(sup, { commandId: cid("c"), recordId: published.id, visibility: "shared" })).revision, 1, "a published record can be copied to shared");
    // The same grant stops working when the installation denies inspection of private records; the agent's own reads are untouched.
    await c.inspection.setPolicy(c.owner, { commandId: cid("p"), scratch: "denied" });
    await refuses("forbidden", () => c.desks.read(sup, secret.id));
    await refuses("forbidden", () => c.desks.copy(sup, { commandId: cid("c"), recordId: secret.id }));
    assert.deepEqual((await c.desks.list(sup, { ownerId: "agent:ann", limit: 10 })).items.map((i) => i.id), [published.id]);
    assert.equal((await c.desks.independence(sup, [secret.id, published.id])).unavailable[0], secret.id);
    assert.equal((await c.desks.read(c.ann, secret.id)).body, "alice private thoughts");
    // Search finds only sup's own earlier copy, never alice's record; a copy made while the grant worked stays where it was made (the policy cannot take back what was read).
    const found = (await c.retrieval.search(sup, { projectId: c.a, query: "thoughts" })).hits.map((h) => (h.source.kind === "desk-record" ? h.source.id : ""));
    assert.deepEqual(found, [kept.id]);
  });

  suite("a copy keeps the original's identity at its root, lands in the copier's scratch as a draft, and counts with the original, not apart from it", async (c) => {
    const original = await c.desks.write(c.ann, rec(c.a, { title: "the investigation", body: "the cache is the cause" }));
    const mine = await c.desks.copy(c.ben, { commandId: cid("c"), recordId: original.id });
    const copy = await c.desks.read(c.ben, mine.id);
    assert.deepEqual([copy.owner, copy.status, copy.visibility, copy.copiedFrom, copy.origin, copy.sources], ["agent:ben", "draft", "private", original.id, { recordId: original.id, owner: "agent:ann", projectId: c.a }, [original.id]]);
    // A copy of a copy still points at the first original: `both` copies it as a shared draft and accepts it, then `ann` copies that.
    const chain = await c.desks.copy(c.both, { commandId: cid("c"), recordId: original.id, visibility: "shared" });
    await c.desks.revise(c.both, { commandId: cid("rv"), recordId: chain.id, expectedRevision: 1, status: "accepted" });
    const chain2 = await c.desks.copy(c.ann, { commandId: cid("c"), recordId: chain.id });
    const deep = await c.desks.read(c.ann, chain2.id);
    assert.deepEqual([deep.copiedFrom, deep.origin?.recordId, deep.origin?.owner], [chain.id, original.id, "agent:ann"]);
    // Independence: the original and every copy of it are one source; unrelated work is another; a record that cannot be read is listed apart.
    const other = await c.desks.write(c.ben, rec(c.a, { title: "separate analysis", body: "measured the load" }));
    const verdict = await c.desks.independence(c.ann, [original.id, chain.id, chain2.id, other.id, "dsk-aaaaaaaaaaaaaaaaaaaa"]);
    assert.equal(verdict.independent, 2);
    assert.deepEqual(verdict.groups.find((g) => g.origin === original.id)!.records.sort(), [chain.id, chain2.id, original.id].sort());
    assert.deepEqual(verdict.groups.find((g) => g.origin === other.id)!.records, [other.id]);
    assert.deepEqual(verdict.unavailable, ["dsk-aaaaaaaaaaaaaaaaaaaa"]);
    // Copying needs a record you can read and the right to write.
    const hidden = await c.desks.write(c.ann, rec(c.a, { visibility: "private" }));
    await refuses("forbidden", () => c.desks.copy(c.ben, { commandId: cid("c"), recordId: hidden.id }));
    const reader = await c.agent("reader", [{ action: "desk.read", project: c.a }]);
    await refuses("forbidden", () => c.desks.copy(reader, { commandId: cid("c"), recordId: original.id }), (e) => assert.match(e.message, /desk\.write/));
    await refuses("forbidden", () => c.desks.copy(c.owner, { commandId: cid("c"), recordId: original.id }));
    await refuses("invalid_command", () => c.desks.copy(c.ben, { commandId: cid("c"), recordId: "nope" }));
  });

  suite("content from another desk, or a copy of it, never becomes a skill or tool; only an agent's own accepted work does", async (c) => {
    const own = await c.desks.write(c.ann, rec(c.a, { kind: "note", title: "my script", body: "echo hi" }));
    const draft = await c.desks.write(c.ann, rec(c.a, { status: "draft", title: "unfinished" }));
    assert.deepEqual((await c.desks.executableSource(c.ann, own.id)).body, "echo hi");
    await refuses("forbidden", () => c.desks.executableSource(c.ben, own.id), (e) => assert.match(e.message, /another agent's desk/));
    const copy = await c.desks.copy(c.ben, { commandId: cid("c"), recordId: own.id });
    await c.desks.revise(c.ben, { commandId: cid("rv"), recordId: copy.id, expectedRevision: 1, status: "accepted" });
    await refuses("forbidden", () => c.desks.executableSource(c.ben, copy.id), (e) => assert.match(e.message, /copy of/));
    await refuses("invalid_command", () => c.desks.executableSource(c.ann, draft.id), (e) => assert.match(e.message, /accepted/));
    const hidden = await c.desks.write(c.ann, rec(c.a, { visibility: "private" }));
    await refuses("forbidden", () => c.desks.executableSource(c.ben, hidden.id));
    await refuses("forbidden", () => c.desks.executableSource(c.owner, own.id));
    await refuses("forbidden", () => c.desks.executableSource(c.ann, "nope"));
  });
}
