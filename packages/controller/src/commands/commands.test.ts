import assert from "node:assert/strict";
import { after, test } from "node:test";
import { catalogSource as _unused } from "./resolve.js";
import { CatalogService, personalNamespace } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { COMMAND_ALIASES, CommandResolver, CommandService, catalogSource, parseInvocation, type CommandSource, type Resolution } from "./index.js";

after(stopServer);
void _unused;

const options = { clock: () => "2026-10-27T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const manifest = (extra: Record<string, unknown> = {}) => ({
  purpose: "run the tests", input: { type: "object", properties: { filter: { type: "string" } } }, output: { type: "object" }, entryPoint: "bin/run.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart", ...extra,
});

for (const backend of backends) {
  interface Ctx {
    cmd: CommandService; cat: CatalogService; owner: Principal; ann: Principal; ben: Principal; annNs: string; benNs: string; a: string;
    tool(by: Principal, name: string, version?: string, extra?: Record<string, unknown>): Promise<{ name: string; digest: string }>;
    resolve(by: Principal, typed: string, context?: Record<string, unknown>): Promise<Resolution>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const grants: Grant[] = [{ action: "desk.write", project: a }, { action: "desk.read", project: a }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }];
        const agent = async (nm: string) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const ann = await agent("ann");
        const ben = await agent("ben");
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const cat = CatalogService.withEpoch(world.storage, projects.epoch, desks, options);
        const cmd = CommandService.withEpoch(world.storage, projects.epoch, catalogSource(cat), options);
        const note = async (by: Principal, text: string) => (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title: "work", body: text, visibility: "shared", status: "accepted" } as never)).id;
        const tool: Ctx["tool"] = async (by, name, version = "1.0.0", extra = {}) => {
          // The owner releases a shared or system tool from an agent's accepted work.
          const author = by.kind === "owner" ? ben : by;
          const readme = await note(author, `Use ${name}.`), code = await note(author, `console.log('${name} ${version}')`);
          return cat.register(by, { commandId: cid("r"), name, kind: "tool", version, manifest: manifest(extra), instructionsRecordId: readme, executableRecordId: code });
        };
        await body({ cmd, cat, owner, ann, ben, annNs: personalNamespace(ann.id), benNs: personalNamespace(ben.id), a, tool, resolve: (by, typed, context) => cmd.resolver().resolve(by, typed, context as never) });
      } finally { await world.close(); }
    });

  suite("a typed command resolves, before anything is queued, to the canonical operation, the exact version and digest, the schema, the owner and a label, all kept separate (card T09)", async (c) => {
    const mine = await c.tool(c.ann, "run-tests");
    await c.tool(c.owner, "nimblenewt.pause"); await c.tool(c.owner, "toolbox.lint");
    const r = await c.resolve(c.ann, `/${c.annNs}.run-tests --only fast`);
    assert.equal(r.status, "resolved");
    if (r.status !== "resolved") return;
    assert.deepEqual([r.target.operationId, r.target.layer, r.target.version, r.target.digest === mine.digest, r.target.ownerId, r.target.displayName, r.rest], [`${c.annNs}.run-tests`, "agent", "1.0.0", true, c.annNs.slice(2), "run-tests", "--only fast"]);
    assert.match(r.target.schemaDigest, /^[0-9a-f]{32}$/);
    const pause = await c.resolve(c.owner, "/nimblenewt.pause");
    assert.deepEqual(pause.status === "resolved" && [pause.target.layer, pause.target.ownerId], ["protected", "controller"]);
    const lint = await c.resolve(c.ann, "/toolbox.lint");
    assert.deepEqual(lint.status === "resolved" && [lint.target.layer, lint.target.ownerId], ["toolbox", "toolbox"]);
    // A newer version changes the revision and the schema digest but not the operation identity; a particular version can be asked for.
    await c.tool(c.ann, "run-tests", "1.1.0", { input: { type: "object", properties: { filter: { type: "string" }, retries: { type: "number" } } } });
    const next = await c.resolve(c.ann, `/${c.annNs}.run-tests`);
    const old = await c.resolve(c.ann, `/${c.annNs}.run-tests`, { version: "1.0.0" });
    assert.ok(next.status === "resolved" && old.status === "resolved");
    if (next.status === "resolved" && old.status === "resolved") {
      assert.deepEqual([next.target.operationId === old.target.operationId, next.target.version, old.target.version, next.target.schemaDigest === old.target.schemaDigest], [true, "1.1.0", "1.0.0", false]);
    }
  });

  suite("a typed command, a model's tool call by its wire name and a UI action end in the same target (card T09)", async (c) => {
    await c.tool(c.ann, "run-tests");
    const typed = await c.resolve(c.ann, `/${c.annNs}.run-tests`);
    const wire = await c.cmd.resolver().resolveWire(c.ann, `${c.annNs}__run-tests`);
    const action = await c.cmd.resolver().resolveAction(c.ann, `${c.annNs}.run-tests`);
    assert.ok(typed.status === "resolved");
    assert.deepEqual(wire.status === "resolved" && wire.target, typed.status === "resolved" && typed.target);
    assert.deepEqual(action.status === "resolved" && action.target, typed.status === "resolved" && typed.target);
    for (const bad of ["run-tests", `${c.annNs}_run-tests`, "nimblenewt__", "__x", "Nimblenewt__pause", `${c.annNs}__run-tests__x`]) assert.equal((await c.cmd.resolver().resolveWire(c.ann, bad)).status === "resolved", false, bad);
    assert.equal((await c.cmd.resolver().resolveAction(c.ann, "run-tests")).status, "refused");
  });

  suite("another agent's personal command, a revoked version and a name nobody registered are unknown; identical names under different agents stay distinct (card T09)", async (c) => {
    await c.tool(c.ann, "run-tests"); await c.tool(c.ben, "run-tests");
    assert.equal((await c.resolve(c.ben, `/${c.annNs}.run-tests`)).status, "unknown", "ben cannot see ann's personal tool");
    assert.equal((await c.resolve(c.ann, `/${c.annNs}.nothing`)).status, "unknown");
    const mine = await c.resolve(c.ann, `/${c.annNs}.run-tests`), theirs = await c.resolve(c.ben, `/${c.benNs}.run-tests`);
    assert.ok(mine.status === "resolved" && theirs.status === "resolved");
    if (mine.status === "resolved" && theirs.status === "resolved") assert.notEqual(mine.target.operationId, theirs.target.operationId);
    await c.cat.revoke(c.owner, { commandId: cid("rv"), name: `${c.annNs}.run-tests`, version: "1.0.0", reason: "bad" });
    assert.equal((await c.resolve(c.ann, `/${c.annNs}.run-tests`)).status, "unknown", "no live version");
    assert.equal((await c.resolve(c.ann, `/${c.annNs}.run-tests`, { version: "1.0.0" })).status, "unknown", "a revoked version asked for by number");
  });

  test("the grammar: lower-case ASCII only, nothing normalised, no unprefixed or unknown namespace, and an agent cannot take a reserved one (card T09)", () => {
    const ok = parseInvocation("/nimblenewt.pause now please");
    assert.deepEqual([ok?.namespace, ok?.name, ok?.rest], ["nimblenewt", "pause", "now please"]);
    assert.deepEqual(parseInvocation("/a_abc123.run-tests")?.namespace, "a_abc123");
    assert.deepEqual([...COMMAND_ALIASES], ["agent", "custom"]);
    for (const bad of ["pause", "/pause", "/nimblenewt", "/nimblenewt.", "/NimbleNewt.pause", "/nimblenewt.Pause", "/nimblenewt.pa%75se", "/nimblenewt.pause​", "/nimblеwt.pause", "/nımblenewt.pause", "/nimblenewt.pa_use", "/nimblenewt.-pause", "/nimblenewt.pause-", "/nimblenewt.pa--use",
      "/a_ABC123.x", "/a_ab.x", "/a_.x", "/other.x", "/nimblenewt..pause", "/nimblenewt.pause.again", "//nimblenewt.pause", " /nimblenewt.pause", "/nimblenewt.pause\u0000", "/" + "a".repeat(300) + ".x", "/nimblenewt." + "a".repeat(29)] as unknown[]) assert.equal(parseInvocation(bad), undefined, JSON.stringify(bad));
    assert.equal(parseInvocation(undefined), undefined);
    assert.equal(parseInvocation(42), undefined);
  });

  suite("something filed under a reserved name by anyone but its owner is never run as one, and a layer that disagrees with the namespace is refused (card T09)", async () => {
    const source: CommandSource = {
      names: async () => [],
      version: async (_by, name) => ({ name, layer: name.startsWith("nimblenewt.") ? "agent" : "toolbox", version: "1.0.0", digest: "d", schemaDigest: "s", revoked: false }),
    };
    const resolver = new CommandResolver(source);
    const by = { kind: "owner", id: "owner:rob" } as Principal;
    const forged = await resolver.resolve(by, "/nimblenewt.pause");
    assert.equal(forged.status, "refused");
    assert.match(forged.status === "refused" ? forged.reason : "", /not registered in its own namespace/);
    assert.equal((await resolver.resolve(by, "/toolbox.lint")).status, "resolved");
  });

  suite("/agent.<name> binds to the explicitly selected agent; with none selected it never picks one: two agents with the same command are ambiguous, one is a request for the agent, and each agent sees only its own (card T09)", async (c) => {
    await c.tool(c.ann, "run-tests"); await c.tool(c.ben, "run-tests"); await c.tool(c.ann, "only-ann");
    const bound = await c.resolve(c.owner, "/agent.run-tests", { agent: c.benNs.slice(2) });
    assert.deepEqual(bound.status === "resolved" && bound.target.operationId, `${c.benNs}.run-tests`);
    const other = await c.resolve(c.owner, "/agent.run-tests", { agent: c.annNs.slice(2) });
    assert.deepEqual(other.status === "resolved" && other.target.operationId, `${c.annNs}.run-tests`, "switching the selected agent changes what the shortcut means, which is why the target is what gets queued");
    const ambiguous = await c.resolve(c.owner, "/agent.run-tests");
    assert.equal(ambiguous.status, "ambiguous");
    assert.deepEqual(ambiguous.status === "ambiguous" && ambiguous.candidates, [`${c.annNs}.run-tests`, `${c.benNs}.run-tests`].sort());
    const one = await c.resolve(c.owner, "/agent.only-ann");
    assert.deepEqual([one.status, one.status === "needs_context" && one.needs, one.status === "needs_context" && one.candidates], ["needs_context", "agent", [`${c.annNs}.only-ann`]]);
    assert.equal((await c.resolve(c.ann, "/agent.run-tests")).status, "needs_context", "ann sees only her own command, and still has to say which agent");
    assert.equal((await c.resolve(c.owner, "/agent.nothing")).status, "unknown");
    assert.equal((await c.resolve(c.owner, "/agent.run-tests", { agent: "Ann" })).status, "refused", "a friendly name is not an agent");
    assert.equal((await c.resolve(c.owner, "/agent.run-tests", { agent: "abcdef1" })).status, "unknown", "an agent with no such command");
  });

  suite("/custom.<name> resolves only in the scope it was defined in, names one canonical command, grants nothing and is the owner's to define, replace and remove (card T09)", async (c) => {
    await c.tool(c.ann, "run-tests"); await c.tool(c.owner, "toolbox.lint");
    await refuses("forbidden", () => c.cmd.defineAlias(c.ann, { commandId: cid("al"), scope: "project:a", alias: "t", target: `${c.annNs}.run-tests` }));
    const defined = await c.cmd.defineAlias(c.owner, { commandId: cid("al"), scope: "project:a", alias: "t", target: `${c.annNs}.run-tests` });
    assert.equal(defined.replayed, false);
    assert.equal((await c.resolve(c.owner, "/custom.t")).status, "needs_context", "no scope given");
    const hit = await c.resolve(c.ann, "/custom.t", { scope: "project:a" });
    assert.deepEqual(hit.status === "resolved" && hit.target.operationId, `${c.annNs}.run-tests`);
    assert.equal((await c.resolve(c.ann, "/custom.t", { scope: "project:b" })).status, "unknown", "another scope has no such command");
    const blind = await c.resolve(c.ben, "/custom.t", { scope: "project:a" });
    const none = await c.resolve(c.ben, "/custom.zz", { scope: "project:a" });
    assert.deepEqual([blind.status, none.status], ["unknown", "unknown"], "the alias grants nothing: ben cannot see ann's personal command");
    assert.equal(blind.status === "unknown" && blind.reason.replace("t in", "zz in"), none.status === "unknown" && none.reason, "and the answer does not say the alias exists or whose it names");
    await refuses("forbidden", () => c.cmd.removeAlias(c.ann, { commandId: cid("rm"), scope: "project:a", alias: "t", expectedRevision: 1 }));
    // An alias names a canonical command, not another alias; a missing or invisible target and a bad name or scope are refused; an existing one cannot be overwritten.
    await refuses("invalid_command", () => c.cmd.defineAlias(c.owner, { commandId: cid("al"), scope: "project:a", alias: "u", target: "custom.t" }), (e) => assert.equal(e.field, "target"));
    await refuses("not_found", () => c.cmd.defineAlias(c.owner, { commandId: cid("al"), scope: "project:a", alias: "u", target: "toolbox.nothing" }));
    await refuses("invalid_command", () => c.cmd.defineAlias(c.owner, { commandId: cid("al"), scope: "Project A", alias: "u", target: "toolbox.lint" }), (e) => assert.equal(e.field, "scope"));
    await refuses("invalid_command", () => c.cmd.defineAlias(c.owner, { commandId: cid("al"), scope: "project:a", alias: "Bad Name", target: "toolbox.lint" }), (e) => assert.equal(e.field, "alias"));
    await refuses("invalid_command", () => c.cmd.defineAlias(c.owner, { commandId: cid("al"), scope: "project:a", alias: "t", target: "toolbox.lint" }), (e) => assert.match(e.message, /already exists/));
    // Repeating the definition is a replay; the list shows it; removing it makes the name unknown and lets it be defined again.
    const same = { commandId: "al-fixed", scope: "project:a", alias: "v", target: "toolbox.lint" };
    assert.equal((await c.cmd.defineAlias(c.owner, same)).replayed, false);
    assert.equal((await c.cmd.defineAlias(c.owner, same)).replayed, true);
    const list = await c.cmd.aliases(c.owner, "project:a");
    assert.deepEqual(list.map((x) => [x.alias, x.target]), [["t", `${c.annNs}.run-tests`], ["v", "toolbox.lint"]]);
    await refuses("forbidden", () => c.cmd.aliases(c.ann, "project:a"));
    const t = list[0]!;
    await refuses("stale_revision", () => c.cmd.removeAlias(c.owner, { commandId: cid("rm"), scope: "project:a", alias: "t", expectedRevision: t.revision + 5 }));
    await c.cmd.removeAlias(c.owner, { commandId: cid("rm"), scope: "project:a", alias: "t", expectedRevision: t.revision });
    assert.equal((await c.resolve(c.ann, "/custom.t", { scope: "project:a" })).status, "unknown");
    assert.deepEqual((await c.cmd.aliases(c.owner, "project:a")).map((x) => x.alias), ["v"]);
    await c.cmd.defineAlias(c.owner, { commandId: cid("al"), scope: "project:a", alias: "t", target: "toolbox.lint" });
    const again = await c.resolve(c.ann, "/custom.t", { scope: "project:a" });
    assert.deepEqual(again.status === "resolved" && again.target.operationId, "toolbox.lint", "defined again, it means what it now says");
  });

  suite("queued work stores the resolved target, not the shortcut: a later change of the selected agent or alias changes nothing already queued; what does not resolve is returned and nothing is queued (card T09)", async (c) => {
    await c.tool(c.ann, "run-tests"); await c.tool(c.ben, "run-tests");
    const first = await c.cmd.enqueue(c.owner, { commandId: "q1", typed: "/agent.run-tests --fast", context: { agent: c.annNs.slice(2) } });
    assert.equal(first.status, "queued");
    if (first.status !== "queued") return;
    assert.equal(first.target.operationId, `${c.annNs}.run-tests`);
    const stored = (await c.cmd.queued(c.owner, first.id))!;
    assert.deepEqual([stored.typed, stored.target.operationId, stored.args, stored.requestedBy, stored.context], ["/agent.run-tests --fast", `${c.annNs}.run-tests`, "--fast", c.owner.id, { agent: c.annNs.slice(2) }]);
    // The same command ID again is the same queued item, even if the screen has moved to another agent since.
    const replay = await c.cmd.enqueue(c.owner, { commandId: "q1", typed: "/agent.run-tests --fast", context: { agent: c.annNs.slice(2) } });
    assert.deepEqual(replay.status === "queued" && [replay.id, replay.replayed], [first.id, true]);
    // A different selection is a different item with its own target.
    const second = await c.cmd.enqueue(c.owner, { commandId: "q2", typed: "/agent.run-tests --fast", context: { agent: c.benNs.slice(2) } });
    assert.ok(second.status === "queued" && second.id !== first.id && second.target.operationId === `${c.benNs}.run-tests`);
    assert.equal((await c.cmd.queued(c.owner, first.id))!.target.operationId, `${c.annNs}.run-tests`, "the first is unchanged");
    // Not queued: ambiguous, needs a context, unknown, refused.
    for (const [typed, status] of [["/agent.run-tests", "ambiguous"], ["/custom.t", "needs_context"], ["/nimblenewt.nothing", "unknown"], ["pause", "refused"]] as const) {
      const r = await c.cmd.enqueue(c.owner, { commandId: cid("qx"), typed });
      assert.equal(r.status, status, typed);
    }
    assert.equal((await c.cmd.queued(c.owner, "qcm-aaaaaaaaaaaaaaaaaaaa")), undefined);
    // Who may queue and read: the owner or an agent; another agent reads a queued command like a missing one; the arguments are bounded and redacted.
    const mine = await c.cmd.enqueue(c.ann, { commandId: "q3", typed: `/${c.annNs}.run-tests token=sk-ABCDEFGHIJKLMNOPQRSTUV` });
    assert.equal(mine.status, "queued");
    if (mine.status === "queued") {
      const rec = (await c.cmd.queued(c.ann, mine.id))!;
      assert.ok(!rec.args.includes("sk-ABCDEFGHIJKLMNOPQRSTUV") && !rec.typed.includes("sk-ABCDEFGHIJKLMNOPQRSTUV"), "the secret is in neither the arguments nor the typed text");
      assert.equal(await c.cmd.queued(c.ben, mine.id), undefined);
      assert.ok(await c.cmd.queued(c.owner, mine.id));
    }
    // A retry of a queued command is answered from the record even after the name stopped resolving; the same ID for something else conflicts.
    await c.cat.revoke(c.owner, { commandId: cid("rv"), name: `${c.annNs}.run-tests`, version: "1.0.0", reason: "gone" });
    const retry = await c.cmd.enqueue(c.owner, { commandId: "q1", typed: "/agent.run-tests --fast", context: { agent: c.annNs.slice(2) } });
    assert.deepEqual(retry.status === "queued" && [retry.id, retry.replayed], [first.id, true]);
    await refuses("command_conflict", () => c.cmd.enqueue(c.owner, { commandId: "q1", typed: "/agent.run-tests --slow", context: { agent: c.annNs.slice(2) } }));
    await refuses("forbidden", () => c.cmd.enqueue({ kind: "host", id: "host:h" } as Principal, { commandId: cid("qx"), typed: "/nimblenewt.pause" }));
    await refuses("invalid_command", () => c.cmd.enqueue(c.owner, { commandId: cid("qx"), typed: "x".repeat(5000) }));
    await refuses("invalid_command", () => c.cmd.enqueue(c.owner, { commandId: cid("qx"), typed: "/nimblenewt.pause", context: { agent: "abcdef1", extra: 1 } as never }));
  });
}
