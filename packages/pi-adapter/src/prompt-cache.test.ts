import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { requestId, type AuditEvent } from "@nimblenewt/contracts";
import { PiAdapter, UnstablePromptError, assertStableText, sharedSystemText, sortedTools, volatileContext, type AdapterTool, type PrefixReport, type PromptLayout } from "./index.js";
import { rig, wireBody, type Rig } from "./testing/wire.js";

// Card C06b. These tests look at the bytes pi-ai would send to the provider (its own request builder is run on what the harness handed the provider), not only at Pi's log.

const dirs: string[] = [];
const adapters: PiAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const tool = (name: string, description = `the ${name} tool`): AdapterTool => ({ name, description, parameters: Type.Object({ q: Type.Optional(Type.String()) }), execute: async () => "done" });
const LAYOUT: PromptLayout = { preamble: "You work for NimbleNewt. Be brief and exact.", project: "Project Aster: a ledger service in TypeScript.", agent: "You review pull requests." };

/** What the provider's cache sees: cache markers are not part of the content, and a text given as a string equals the same text as one block. */
const clean = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === "cache_control" ? undefined : x))));
const head = (body: Record<string, unknown>): string => JSON.stringify({ tools: clean(body["tools"]), system: clean(body["system"]) });
const turns = (body: Record<string, unknown>): string[] => (body["messages"] as { role: string; content: unknown }[]).map((m) => JSON.stringify(clean({ role: m.role, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content })));
const startsWith = (longer: readonly string[], shorter: readonly string[]): boolean => shorter.length <= longer.length && shorter.every((s, i) => s === longer[i]);

async function open(world: Rig, extra: Partial<Parameters<typeof PiAdapter.open>[0]> = {}) {
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: world.models, model: world.ref, promptLayout: LAYOUT, ...extra });
  adapters.push(adapter);
  return adapter;
}

test("audit: Pi renders no system text of its own, replays the sections and tools into one leading system message, and a section or tool change rewrites that head", async () => {
  const world = rig("anthropic-messages");
  const reports: PrefixReport[] = [];
  const audit: AuditEvent[] = [];
  const adapter = await open(world, { tools: [tool("zeta"), tool("alpha")], cache: { onRequest: (r) => reports.push(r) }, audit: (e) => { audit.push(e); } });
  world.reply("one", "two", "three");
  await (await adapter.root().submit(input("r1", "first"))).result();
  await (await adapter.root().submit(input("r2", "second"))).result();
  const first = world.seen[0]!.context.messages as { role: string; content?: unknown; sections?: Record<string, string>; toolsAdded?: { name: string }[] }[];
  // The leading message is the one system message; it carries the sections in order and the tools sorted by name.
  assert.equal(first[0]!.role, "system");
  assert.deepEqual(Object.keys(first[0]!.sections!), ["nn_preamble", "nn_project", "nn_agent"]);
  assert.deepEqual(first[0]!.toolsAdded!.map((t) => t.name), ["alpha", "zeta"]);
  assert.equal(first.filter((m) => m.role === "system").length, 1);
  // Turn two: nothing in the head moved, so the request only extends the earlier one.
  assert.equal(reports[1]!.source, "same-conversation");
  assert.equal(reports[1]!.firstChanged, undefined);
  assert.equal(reports[1]!.sharedSegments, reports[0]!.segments, "the whole first request is shared; the second only adds to it");
  // A deliberate change of the layout rewrites the head: the first segment differs and nothing after it is shared.
  const change = await adapter.changePromptLayout({ ...LAYOUT, agent: "You review pull requests and write release notes." }, "role widened by the owner");
  assert.notEqual(change.from, change.to);
  await (await adapter.root().submit(input("r3", "third"))).result();
  assert.equal(reports[2]!.firstChanged, 0);
  assert.equal(reports[2]!.sharedSegments, 0);
  const changes = audit.filter((e) => e.type === "prompt_layout_change");
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { type: "prompt_layout_change", at: (changes[0] as { at: number }).at, reason: "role widened by the owner", from: change.from, to: change.to });
  assert.ok(!JSON.stringify(changes).includes("release notes"), "the audit carries fingerprints, never prompt text");
  assert.equal(adapter.promptFingerprint(), change.to);
});

test("audit: on a model that takes system messages mid-conversation a layout change is only appended, so the prefix survives; on every other model it rewrites the head", async () => {
  const world = rig("anthropic-messages");
  (world.models.getModel(world.ref.provider, world.ref.modelId) as { compat?: unknown }).compat = { supportsMidConvoSystemMessages: true };
  const reports: PrefixReport[] = [];
  const adapter = await open(world, { cache: { onRequest: (r) => reports.push(r) } });
  world.reply("one", "two");
  await (await adapter.root().submit(input("r1", "first"))).result();
  await adapter.changePromptLayout({ ...LAYOUT, agent: "You review pull requests and write release notes." }, "role widened");
  await (await adapter.root().submit(input("r2", "second"))).result();
  assert.equal(reports[1]!.firstChanged, undefined, "the change is a later message in the request, after everything already cached");
  assert.equal(reports[1]!.sharedSegments, reports[0]!.segments);
});

test("the prefix of the provider request is the same bytes on every turn: tools sorted, sections fixed, history only appended (Anthropic)", async () => {
  const world = rig("anthropic-messages");
  const adapter = await open(world, { tools: [tool("zeta"), tool("mid"), tool("alpha")] });
  world.reply("one", "two", "three", "four");
  for (const [i, text] of ["first", "second", "third", "fourth"].entries()) await (await adapter.root().submit(input(`r${i}`, text))).result();
  const bodies = await Promise.all(world.seen.map(wireBody));
  assert.deepEqual((bodies[0]!["tools"] as { name: string }[]).map((t) => t.name), ["alpha", "mid", "zeta"]);
  for (let i = 1; i < bodies.length; i++) {
    assert.equal(head(bodies[i]!), head(bodies[0]!), `tools and system differ on turn ${i + 1}`);
    assert.ok(startsWith(turns(bodies[i]!), turns(bodies[i - 1]!)), `turn ${i + 1} does not extend turn ${i}`);
  }
  // Pi's own markers: the system block, the last tool and the last message (the wire keeps them where the prefix ends).
  const marks = (b: Record<string, unknown>): string[] => [
    ...(b["tools"] as { cache_control?: unknown }[]).map((t, i, all) => (t.cache_control !== undefined ? `tool ${i + 1}/${all.length}` : "")),
    ...(b["system"] as { cache_control?: unknown }[]).map((s, i) => (s.cache_control !== undefined ? `system ${i}` : "")),
  ].filter((x) => x !== "");
  assert.deepEqual(marks(bodies[3]!), ["tool 3/3", "system 0", "system 1"]);
});

test("system text is stable-first: the preamble, then the project, then the agent; volatile text goes in a user message, never a section", async () => {
  const world = rig("anthropic-messages");
  const adapter = await open(world);
  world.reply("one", "two");
  await (await adapter.root().submit(input("r1", volatileContext("it is a quiet day")))).result();
  await (await adapter.root().submit(input("r2", volatileContext("it is a busy day")))).result();
  const [a, b] = await Promise.all(world.seen.map(wireBody));
  const text = (a!["system"] as { text: string }[]).map((s) => s.text).join("\n\n");
  assert.ok(text.indexOf("NimbleNewt") < text.indexOf("Aster") && text.indexOf("Aster") < text.indexOf("pull requests"));
  assert.ok(!text.includes("quiet day"));
  assert.equal(head(b!), head(a!), "a different volatile message left the head alone");
  assert.equal(volatileContext("x"), "<context>\nx\n</context>");
});

test("the shared system text is sent as a block of its own on Anthropic, so a breakpoint can sit between what agents share and what only one has", async () => {
  const world = rig("anthropic-messages");
  const adapter = await open(world);
  world.reply("one");
  await (await adapter.root().submit(input("r1", "hello"))).result();
  const body = await wireBody(world.seen[0]!);
  const blocks = body["system"] as { text: string; cache_control?: unknown }[];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.text, sharedSystemText(LAYOUT), "the split is exactly the sections every agent has in common");
  assert.ok(blocks[1]!.text.includes("pull requests"));
  assert.ok(blocks[0]!.cache_control !== undefined && blocks[1]!.cache_control !== undefined);
  // Without an agent section there is nothing to split off.
  const solo = rig("anthropic-messages");
  const plain = await open(solo, { promptLayout: { preamble: LAYOUT.preamble, project: LAYOUT.project! } });
  solo.reply("one");
  await (await plain.root().submit(input("r1", "hello"))).result();
  assert.equal(((await wireBody(solo.seen[0]!))["system"] as unknown[]).length, 1);
});

test("a resume after a restart, an inquiry branch and a compaction each leave the head alone and only append or replace history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-prompt-"));
  dirs.push(dir);
  const world = rig("anthropic-messages");
  const reports: PrefixReport[] = [];
  const settings = { compaction: { keepRecentTokens: 1 } };
  const contextPolicy = { beforeCompact: async () => ({ summary: "SUMMARY OF EARLIER TURNS" }) };
  const tools = [tool("zeta"), tool("alpha")];
  const first = await open(world, { storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), tools, settings, contextPolicy, cache: { onRequest: (r) => reports.push(r) } });
  world.reply("one", "two");
  await (await first.root().submit(input("r1", "first"))).result();
  await (await first.root().submit(input("r2", "second"))).result();
  await first.close();
  // Restart: a new process on the same storage, tools passed in another order and the layout object rebuilt.
  const second = await open(world, { storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), tools: [tool("alpha"), tool("zeta")], settings, contextPolicy, promptLayout: { ...LAYOUT }, cache: { onRequest: (r) => reports.push(r) } });
  world.reply("three");
  await (await second.root().submit(input("r3", "third"))).result();
  // An inquiry branch of the resumed conversation.
  const branch = await second.root().branch({ requestId: requestId("inq-1") });
  world.reply("inquiry answer");
  await (await branch.conversation.submit(input("q1", "what are you doing?"))).result();
  // A compaction of the parent, then a turn.
  await second.root().compact();
  world.reply("four");
  await (await second.root().submit(input("r4", "fourth"))).result();
  const bodies = await Promise.all(world.seen.map(wireBody));
  assert.equal(bodies.length, 5);
  const [b1, b2, b3, inquiry, b4] = bodies as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  for (const [name, b] of [["restart", b3], ["inquiry", inquiry], ["after compaction", b4]] as const) assert.equal(head(b), head(b1), `${name}: tools and system changed`);
  assert.ok(startsWith(turns(b3), turns(b2)), "restart: the history is replayed as it was");
  assert.ok(startsWith(turns(inquiry), turns(b3)), "inquiry: the branch carries the parent's context as the same prefix");
  // Compaction replaces the older history by a summary: the head still matches; where the messages begin to differ is reported (the cost of compacting).
  assert.ok(JSON.stringify(b4["messages"]).includes("SUMMARY OF EARLIER TURNS"));
  assert.equal(startsWith(turns(b4), turns(b3)), false, "the compacted history is not an extension");
  const afterCompaction = reports.at(-1)!;
  assert.equal(afterCompaction.firstChanged! >= 1, true, "the head (segment 0) is still shared after a compaction");
  assert.ok(afterCompaction.sharedChars > 0 && afterCompaction.sharedChars < afterCompaction.chars);
});

test("agents of one project that share a cache key share their head; with Pi's own session ID they share nothing", async () => {
  const run = async (key: string | undefined) => {
    const world = rig("anthropic-messages");
    const reports: PrefixReport[] = [];
    const policy = key === undefined ? {} : { policy: () => ({ key, retention: "long" as const }) };
    const adapter = await open(world, { promptLayout: { ...LAYOUT, agent: undefined as never }, cache: { ...policy, onRequest: (r) => reports.push(r) }, tools: [tool("b"), tool("a")] });
    const taskA = await adapter.createTask({ requestId: requestId("ta") });
    const taskB = await adapter.createTask({ requestId: requestId("tb") });
    world.reply("a1", "b1");
    await (await taskA.conversation.submit(input("ra", "review the ledger"))).result();
    await (await taskB.conversation.submit(input("rb", "review the ledger"))).result();
    return { reports, seen: world.seen };
  };
  const shared = await run("nn-shared-key-for-project");
  assert.equal(shared.reports[1]!.source, "other-conversation");
  assert.ok(shared.reports[1]!.sharedSegments >= 2, "the second agent's head, and its first message, are the first agent's");
  assert.deepEqual(shared.seen.map((s) => [s.options?.["sessionId"], s.options?.["cacheRetention"]]), [["nn-shared-key-for-project", "long"], ["nn-shared-key-for-project", "long"]]);
  const alone = await run(undefined);
  assert.notEqual(alone.seen[0]!.options?.["sessionId"], alone.seen[1]!.options?.["sessionId"], "Pi gives each conversation its own session ID");
  assert.equal(alone.reports[1]!.source, "none", "without a shared key the tracker has nothing to compare against: the cache would not share either");
});

test("a cache policy's payload function is applied to the real provider body, after the split, and the provider's own onPayload still runs", async () => {
  const world = rig("openai-completions", "local", "m");
  const adapter = await open(world, { cache: { policy: () => ({ key: "nn-k", payload: (p) => ({ ...(p as object), cache_prompt: true, id_slot: 2 }) }) } });
  world.reply("one");
  await (await adapter.root().submit(input("r1", "hello"))).result();
  const body = await wireBody(world.seen[0]!);
  assert.equal(body["cache_prompt"], true);
  assert.equal(body["id_slot"], 2);
  const messages = body["messages"] as { role: string; content: unknown }[];
  assert.equal(messages[0]!.role === "system" || messages[0]!.role === "developer", true, "OpenAI-style APIs carry the head as the first message");
});

test("layout checks: dates, times, UUIDs, timestamps and generated IDs are refused in any section; tools need unique names", () => {
  for (const [text, what] of [["Today is 2026-10-22.", "a date"], ["Started at 10:31:07", "a time of day"], ["Session 0b1f6c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e", "a UUID"], ["now=1792740438003", "a timestamp"], ["Task task-dn7qu2vdmku3xv27zk25 is open", "a generated identifier"]] as const) {
    assert.throws(() => assertStableText("project", text), (e: unknown) => e instanceof UnstablePromptError && e.section === "project" && e.found === what, text);
  }
  for (const [text, what] of [
    [`built ${new Date(1792741784932).toISOString()}`, "a date"], ["seed_1792741784932", "a timestamp"], ["time 10:00", "a time of day"], ["on \uFF12\uFF10\uFF12\uFF16-\uFF11\uFF10-\uFF12\uFF13", "a date"],
    ["2026-10-\u200B23", "a date"], ["id 0b1f6c2e\u20113d4a\u20114b5c\u20118d9e\u20110f1a2b3c4d5e", "a UUID"], ["x1792741784932y", "a timestamp"], ["12\u200D:30", "a time of day"],
  ] as const) assert.throws(() => assertStableText("project", text), (e: unknown) => e instanceof UnstablePromptError && e.found === what, text);
  assert.doesNotThrow(() => assertStableText("project", "Version 3.2 of the API; sprint 14; ratio 3:1 of reviewers."));
  assert.deepEqual(sortedTools([tool("b"), tool("a"), tool("c")]).map((t) => t.name), ["a", "b", "c"]);
  assert.deepEqual(sortedTools([tool("b"), { ...tool("z"), shared: true }, tool("a"), { ...tool("m"), shared: true }]).map((t) => t.name), ["m", "z", "a", "b"], "shared tools first, each group by name");
  assert.throws(() => sortedTools([tool("a"), tool("a")]), /duplicate tool name/);
  assert.throws(() => sortedTools([tool("")]), /must not be empty/);
});

test("opening or changing a layout with an unstable section is refused before any request, and a layout change needs a layout and a reason", async () => {
  const world = rig("anthropic-messages");
  await assert.rejects(() => open(world, { promptLayout: { preamble: "Today it is 2026-10-22." } }), UnstablePromptError);
  await assert.rejects(() => open(world, { promptLayout: { preamble: "  " } }), /needs a preamble/);
  const adapter = await open(world);
  await assert.rejects(() => adapter.changePromptLayout({ preamble: "Generated at 10:00:00" }, "why"), UnstablePromptError);
  await assert.rejects(() => adapter.changePromptLayout(LAYOUT, " "), /needs a reason/);
  assert.equal(adapter.promptFingerprint(), (await adapter.changePromptLayout(LAYOUT, "same layout again")).from, "an unchanged layout keeps its fingerprint");
  const bare = await open(rig("anthropic-messages"), { promptLayout: undefined as never });
  assert.equal(bare.promptFingerprint(), undefined);
  await assert.rejects(() => bare.changePromptLayout(LAYOUT, "x"), /without a prompt layout/);
});

test("an observer that throws is reported and the request is sent unchanged; a compaction summary call carries no cache settings; the fingerprint covers which tools are shared", async () => {
  const world = rig("anthropic-messages");
  const reported: unknown[] = [];
  const adapter = await open(world, { onReport: (e) => reported.push(e), cache: { policy: () => ({ key: "nn-k", retention: "long" }), onRequest: () => { throw new Error("observer broke"); } } });
  world.reply("one");
  await (await adapter.root().submit(input("r1", "hello"))).result();
  assert.equal((reported[0] as Error).message, "observer broke");
  assert.equal(world.seen[0]!.options?.["sessionId"], "nn-k");
  // A summary request (Pi's compaction) goes through completeSimple: no retention, whatever the policy says.
  const summariser = await open(world, { settings: { compaction: { keepRecentTokens: 1 } }, cache: { policy: () => ({ key: "nn-k", retention: "long" }) } });
  world.reply("a", "b", "summary text", "d");
  await (await summariser.root().submit(input("s1", "first"))).result();
  await (await summariser.root().submit(input("s2", "second"))).result();
  await summariser.root().compact();
  const summary = world.seen.at(-1)!;
  assert.equal(summary.options?.["cacheRetention"], "none");
  const plain = tool("t");
  const withShared = await open(rig("anthropic-messages"), { tools: [plain] });
  const before = withShared.promptFingerprint();
  const other = await open(rig("anthropic-messages"), { tools: [{ ...plain, shared: true }] });
  assert.notEqual(other.promptFingerprint(), before);
});
