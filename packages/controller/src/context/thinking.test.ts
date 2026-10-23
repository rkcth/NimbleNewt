import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type World } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { InspectionService, THINKING_RETENTION_DAYS, ThinkingService, deleteAfter, type ThinkingBlock, type ThinkingSource } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const block = (entryId: number, text: string, extra: Partial<ThinkingBlock> = {}): ThinkingBlock => ({ entryId, provider: "anthropic", model: "claude-x", text, opaque: false, ...extra });
const AWS = "AKIAABCDEFGHIJKLMNOP";

for (const backend of backends) {
  interface Ctx {
    world: World; owner: Principal; a: string; ta: string; tb: string; tEmpty: string;
    thinking: ThinkingService; inspection: InspectionService; ann: Principal; ben: Principal; service: Principal; host: Principal;
    blocks: Map<string, ThinkingBlock[]>; reads: { count: number };
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const make = async (kind: "agent" | "service" | "host", name: string, grants: Grant[] = []) => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name, grants });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${name}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const ta = (await projects.createTask({ commandId: cid("ta"), actor: "owner:rob", projectId: a, title: "task a" })).id;
        const tb = (await projects.createTask({ commandId: cid("tb"), actor: "owner:rob", projectId: a, title: "task b" })).id;
        const tEmpty = (await projects.createTask({ commandId: cid("te"), actor: "owner:rob", projectId: a, title: "task without conversation" })).id;
        const blocks = new Map<string, ThinkingBlock[]>();
        const reads = { count: 0 };
        const source: ThinkingSource = { read: async ({ projectId, taskId }) => { reads.count++; const found = projectId === a ? blocks.get(taskId) : undefined; return found === undefined ? undefined : { agent: "agent:ann", blocks: found }; } };
        const inspection = InspectionService.withEpoch(world.storage, projects.epoch, options);
        await body({
          world, owner, a, ta, tb, tEmpty, blocks, reads, inspection, thinking: ThinkingService.withEpoch(world.storage, projects.epoch, source, inspection, options),
          ann: await make("agent", "ann", [{ action: "desk.write", project: a }, { action: "desk.read", project: a }]),
          ben: await make("agent", "ben", [{ action: "desk.read", project: a }]),
          service: await make("service", "recovery", [{ action: "recovery.read", project: "*" }]), host: await make("host", "h1"),
        });
      } finally { await world.close(); }
    });
  const read = (c: Ctx, who: Principal, task: string, extra: Record<string, unknown> = {}) => c.thinking.read(who, { commandId: cid("r"), projectId: c.a, taskId: task, reason: "checking what the model was weighing", ...extra });

  suite("only the owner reads stored thinking: everyone else, and a task that has none, get the same answer, and nothing is recorded for them", async (c) => {
    c.blocks.set(c.ta, [block(3, "maybe the vendor is wrong")]);
    const first = await read(c, c.owner, c.ta);
    assert.deepEqual(first.blocks?.map((b) => b.text), ["maybe the vendor is wrong"]);
    const answers: string[] = [];
    for (const who of [c.ann, c.service, c.host]) {
      await refuses("not_found", () => read(c, who, c.ta), (e) => answers.push(e.message));
      assert.equal((await c.thinking.looks(who)).items.length, who === c.ann ? 1 : 0, "only the agent whose thinking it was sees the owner's look");
    }
    c.blocks.delete(c.tEmpty);
    await refuses("not_found", () => read(c, c.owner, c.tEmpty), (e) => answers.push(e.message));
    assert.equal(new Set(answers).size, 1, `one answer for a peer, a service, a host and a task with none: ${answers.join(" | ")}`);
    assert.equal((await c.thinking.looks(c.owner)).items.length, 1, "only the owner's successful look is recorded");
    // The source is not even asked for a principal that may not read: a peer cannot probe which tasks have thinking.
    const asked = c.reads.count;
    await refuses("not_found", () => read(c, c.ann, c.tb));
    assert.equal(c.reads.count, asked);
    // A caller cannot name another principal to act as, or pass the blocks themselves.
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { actor: "owner:rob" }));
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { blocks: [] }));
  });

  suite("the owner's read is bounded, paged without losing blocks, redacted like private scratch, recorded as a look with its reason, and a repeat command returns no text", async (c) => {
    c.blocks.set(c.ta, [block(2, `use the key ${AWS} to test`), block(4, "second thought"), block(6, "", { opaque: true }), block(8, "last")]);
    const one = await read(c, c.owner, c.ta, { limit: 2, reason: "audit of the pricing decision" });
    assert.deepEqual(one.blocks?.map((b) => [b.entryId, b.redacted]), [[2, true], [4, false]]);
    assert.ok(!JSON.stringify(one.blocks).includes(AWS), "the secret never reaches the owner's view");
    assert.deepEqual(one.next, { entryId: 4, block: 0 });
    const two = await read(c, c.owner, c.ta, { limit: 2, after: one.next });
    assert.deepEqual(two.blocks?.map((b) => [b.entryId, b.opaque, b.text]), [[6, true, ""], [8, false, "last"]]);
    assert.equal(two.next, undefined);
    const looks = (await c.thinking.looks(c.owner)).items;
    assert.deepEqual(looks.map((l) => [l.taskId, l.returned, l.reason, l.inspector]).sort(), [[c.ta, 2, "audit of the pricing decision", c.owner.id], [c.ta, 2, "checking what the model was weighing", c.owner.id]]);
    assert.ok(!JSON.stringify(looks).includes("vendor") && !JSON.stringify(looks).includes("second thought"), "a look records who and why, never the text");
    // Repeating a command (a retry after a lost answer) returns the look and no content, and does not make a second look.
    const command = { commandId: cid("again"), projectId: c.a, taskId: c.ta, reason: "once" };
    const original = await c.thinking.read(c.owner, command);
    const replay = await c.thinking.read(c.owner, command);
    assert.equal(replay.replayed, true);
    assert.equal(replay.blocks, undefined);
    assert.equal(replay.lookId, original.lookId);
    assert.equal((await c.thinking.looks(c.owner)).items.length, 3);
    // Bounds and shapes.
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { limit: 0 }), (e) => assert.equal(e.field, "limit"));
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { limit: 201 }));
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { reason: `because ${AWS}` }), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { reason: "" }));
    await refuses("invalid_command", () => read(c, c.owner, "not-a-task"));
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { after: { entryId: -5, block: 0 } }));
    await refuses("invalid_command", () => read(c, c.owner, c.ta, { after: { entryId: 1, block: 0, extra: 1 } }));
  });

  suite("an entry with several blocks is paged by (entry, block): none is skipped or shown twice, whatever the page size", async (c) => {
    c.blocks.set(c.ta, [block(2, "a"), block(2, "b"), block(2, "c"), block(5, "d"), block(5, "e")]);
    for (const limit of [1, 2, 3, 5]) {
      const seen: string[] = [];
      let cursor: { entryId: number; block: number } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await read(c, c.owner, c.ta, { limit, ...(cursor === undefined ? {} : { after: cursor }) });
        seen.push(...page.blocks!.map((b) => `${b.entryId}.${b.block}:${b.text}`));
        cursor = page.next;
        if (cursor === undefined) break;
      }
      assert.deepEqual(seen, ["2.0:a", "2.1:b", "2.2:c", "5.0:d", "5.1:e"], `limit ${limit}`);
    }
  });

  suite("looks at stored thinking are visible to the owner and to the agent whose thinking it was, and to no other agent; a completed read still replays after the policy turns to denied", async (c) => {
    c.blocks.set(c.ta, [block(2, "x")]);
    const command = { commandId: cid("r"), projectId: c.a, taskId: c.ta, reason: "routine check" };
    const first = await c.thinking.read(c.owner, command);
    assert.deepEqual((await c.thinking.looks(c.ann)).items.map((l) => [l.id, l.agent, l.policy, l.reason]), [[first.lookId, "agent:ann", "allowed", "routine check"]]);
    assert.deepEqual((await c.thinking.looks(c.ben)).items, []);
    assert.equal((await c.thinking.looks(c.owner)).items.length, 1);
    assert.deepEqual((await c.thinking.looks(c.ann, { limit: 1 })).next, first.lookId);
    await c.inspection.setPolicy(c.owner, { commandId: cid("pol"), scratch: "denied" });
    assert.equal((await c.thinking.read(c.owner, command)).replayed, true, "the completed read replays; it does not read again");
    await refuses("forbidden", () => read(c, c.owner, c.ta));
  });

  suite("the A10 inspection policy applies to the owner's read of stored thinking, and the change takes effect at once", async (c) => {
    c.blocks.set(c.ta, [block(2, "hidden reasoning")]);
    await c.inspection.setPolicy(c.owner, { commandId: cid("pol"), scratch: "denied" });
    await refuses("forbidden", () => read(c, c.owner, c.ta), (e) => assert.match(e.message, /inspection policy/));
    assert.equal((await c.thinking.looks(c.owner)).items.length, 0, "a refused read leaves no look");
    const policy = await c.inspection.policy();
    await c.inspection.setPolicy(c.owner, { commandId: cid("pol"), scratch: "allowed", expectedRevision: policy.revision });
    assert.equal((await read(c, c.owner, c.ta)).blocks?.length, 1);
  });

  suite("exports carry no stored thinking unless the owner turned that on; then only redacted text, never opaque blocks; and only the owner decides", async (c) => {
    const stored = [block(2, `note ${AWS}`), block(4, "", { opaque: true }), block(6, "plain")];
    assert.deepEqual(await c.thinking.exportPolicy(), { includeThinking: false, revision: 0 });
    assert.deepEqual(await c.thinking.forExport(c.owner, stored), { blocks: [], omitted: 3 });
    for (const who of [c.ann]) await refuses("forbidden", () => c.thinking.setExportPolicy(who, { commandId: cid("x"), includeThinking: true }));
    await refuses("forbidden", () => c.thinking.setExportPolicy(c.host, { commandId: cid("x"), includeThinking: true }));
    await refuses("invalid_command", () => c.thinking.setExportPolicy(c.owner, { commandId: cid("x"), includeThinking: "yes" as never }));
    const set = await c.thinking.setExportPolicy(c.owner, { commandId: cid("x"), includeThinking: true });
    await refuses("stale_revision", () => c.thinking.setExportPolicy(c.owner, { commandId: cid("x"), includeThinking: false }), (e) => assert.match(e.message, /already exists/));
    const out = await c.thinking.forExport(c.host, stored);
    assert.deepEqual(out.blocks.map((b) => [b.entryId, b.redacted]), [[2, true], [6, false]]);
    assert.equal(out.omitted, 1);
    assert.ok(!JSON.stringify(out).includes(AWS));
    await refuses("not_found", () => c.thinking.forExport(c.ann, stored));
    await c.thinking.setExportPolicy(c.owner, { commandId: cid("x"), includeThinking: false, expectedRevision: set.revision });
    assert.deepEqual(await c.thinking.forExport(c.owner, stored), { blocks: [], omitted: 3 });
  });

  suite("a drop of stored thinking after a model change is recorded by the dispatcher only, once per command, and shown to the owner", async (c) => {
    const drop = { projectId: c.a, taskId: c.ta, model: "openai/gpt-x", dropped: 2, kept: 0 };
    await refuses("forbidden", () => c.thinking.recordDrop(c.ann, { commandId: cid("d"), ...drop }));
    const command = { commandId: cid("d"), ...drop };
    const first = await c.thinking.recordDrop(c.host, command);
    assert.equal((await c.thinking.recordDrop(c.host, command)).replayed, true);
    assert.equal((await c.thinking.drops(c.owner, c.ta)).length, 1);
    assert.deepEqual((await c.thinking.drops(c.owner, c.ta)).map((d) => [d.id, d.dropped, d.kept, d.model, d.by]), [[first.id, 2, 0, "openai/gpt-x", c.host.id]]);
    assert.deepEqual(await c.thinking.drops(c.owner, c.tb), []);
    assert.deepEqual(await c.thinking.drops(c.ann, c.ta), [], "peers see no drops");
    await refuses("invalid_command", () => c.thinking.recordDrop(c.host, { commandId: cid("d"), ...drop, dropped: 0 }));
    await refuses("invalid_command", () => c.thinking.recordDrop(c.host, { commandId: cid("d"), ...drop, taskId: "x" }));
    await refuses("invalid_command", () => c.thinking.recordDrop(c.host, { commandId: cid("d"), ...drop, actor: "owner:rob" } as never));
    // The same command ID with different content is a conflict, not a second record.
    await assert.rejects(() => c.thinking.recordDrop(c.host, { ...command, dropped: 5 }));
  });
}

test("stored thinking is kept for 14 days after the task ends, counted from the end time given", () => {
  assert.equal(THINKING_RETENTION_DAYS, 14);
  assert.equal(deleteAfter("2026-10-22T10:00:00.000Z"), "2026-11-05T10:00:00.000Z");
  assert.equal(deleteAfter("2026-12-25T23:59:59.000Z"), "2027-01-08T23:59:59.000Z");
  assert.throws(() => deleteAfter("soon"), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
});
