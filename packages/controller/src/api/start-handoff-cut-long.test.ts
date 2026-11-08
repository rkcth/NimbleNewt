import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A record ID of the form a continuation accepts, distinct for each `n`. */
const ref = (prefix: string, n: number): string => { let s = ""; for (let v = n, i = 0; i < 20; i++) { s = B32[v % 32]! + s; v = Math.floor(v / 32); } return `${prefix}-${s}`; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MARKER = /^\[cut: (\d+) of (\d+) entries, archive (hnd-[a-z2-7]{20})\]/;

/**
 * Card C07j review, round 4: a realistic long hand-off through the running controller with the real sources (the task, its contract, the latest continuation a host captured, the sender's shared drafts and
 * responsibilities). Many decisions (a seeded early one and, last, the latest failure diagnosis), many artifacts, many pending effects, many drafts and responsibilities: every section over the limit is cut
 * with a marker; the next agent sees the newest decision, the newest failure, the newest draft and responsibility (by when they last changed, not by ID) and the newest pending effect; the owner's marked
 * early decision stays; and each archive reads back the section as the source gave it, through the state API and by chat's status view.
 */
test("a long hand-off through the running controller: the newest decision, failure, draft, responsibility and pending effect reach the next agent, the marked early decision stays, and every cut section reads back whole (card C07j)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-long-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Importer" }, "p1")).result.id as string;
    const description = Array.from({ length: 60 }, (_, i) => `requirement ${i}: the importer reads column ${i} and reports rejected rows with their line numbers`).join("\n");
    const task = (await call(boot.token, "task.create", { projectId: project, title: "build the CSV importer", description }, "t1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const b = (await c.services.agents.create(rob, { commandId: "ag-b", friendlyName: "B" })).id;
    for (const [who, action] of [[a, "desk.write"], [a, "desk.read"], [a, "responsibility.read"], [a, "attempt.work"], [b, "attempt.work"], [b, "desk.read"]] as const) await c.services.grants.grant(rob, { commandId: `g-${who}-${action}`, grantee: `agent:${who}`, action, project, source: "direct", basis: "test" });
    await c.services.contracts.setContract(rob, { commandId: "ct1", taskId: task, expectedVersion: 0, acceptanceCriteria: ["every fixture imports", "rejected rows are listed"] } as never);
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    assert.ok((await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: a } }, "as1")).ok);
    const asA = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, `agent:${a}`)).token);

    // The run's records: a seeded early decision and the latest failure diagnosis are desk records the next agent can look up by the IDs the package names.
    const early = (await c.services.desks.write(asA, { commandId: "early", projectId: project, taskId: task, kind: "decision", title: "encoding", body: "SEEDED-EARLY-DECISION: the importer reads UTF-8 only", visibility: "shared", status: "accepted" } as never)).id;
    // Drafts: the first written is revised last, so it is the newest by when it changed although its ID says nothing of age.
    const pad = (s: string) => `${s} ${"the fixtures show the header row is counted twice when the file ends without a newline; ".repeat(4)}`.slice(0, 290);
    const drafts: string[] = [];
    for (let i = 0; i < 20; i++) drafts.push((await c.services.desks.write(asA, { commandId: `dr${i}`, projectId: project, taskId: task, kind: "note", title: `draft ${i}`, body: pad(`DRAFT-${i}`), visibility: "shared", status: "draft" } as never)).id);
    const duties: { id: string; revision: number }[] = [];
    for (let i = 0; i < 25; i++) { const r = await c.services.responsibilities.create(rob, { commandId: `r${i}`, projectId: project, title: `duty ${i}`, objective: "keep the importer healthy", desiredCondition: pad(`DUTY-${i}`).slice(0, 190), ownerId: `agent:${a}` } as never) as { id: string; revision: number }; duties.push(r); }
    await sleep(15);
    await c.services.desks.revise(asA, { commandId: "dr0-rev", recordId: drafts[0]!, expectedRevision: 1, title: "draft 0, revised last", body: pad("NEWEST-DRAFT") } as never);
    await c.services.responsibilities.update(rob, { commandId: "r0-rev", responsibilityId: duties[0]!.id, expectedRevision: duties[0]!.revision, title: "duty 0, changed last" } as never);
    const failure = (await c.services.desks.write(asA, { commandId: "late", projectId: project, taskId: task, kind: "decision", title: "diagnosis", body: "LATEST-FAILURE: the retry failed on the lease; the cause is the stale cursor", visibility: "shared", status: "accepted" } as never)).id;

    // The continuation a host captured: 150 artifacts, 190 decisions (the early one first, the failure diagnosis last), 200 pending effects and a next step.
    await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "h1", grants: [] });
    const host = (await c.services.principals.issueCredential(rob, "host:h1")).token;
    const artifacts = Array.from({ length: 150 }, (_, i) => ref("art", i));
    const decisions = [early, ...Array.from({ length: 188 }, (_, i) => ref("dsk", 1000 + i)), failure];
    const effects = Array.from({ length: 200 }, (_, i) => ({ effectId: ref("eff", i), state: i === 199 ? "unknown" : "pending" }));
    const captured = await call(host, "continuation.capture", {
      taskId: task, identity: "conv-1", agent: `agent:${a}`, boundary: { kind: "turn-complete" }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
      continuation: { artifacts, decisions, pendingEffects: effects, budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: `look up ${failure} first, then rerun fixture 7` },
      manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
      nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
    }, "cap1");
    assert.equal(captured.result?.status, "complete", JSON.stringify(captured));

    // The owner marks the early decision by its ID; the marks apply to the package collected next.
    assert.ok((await call(boot.token, "handoff.marks.change", { taskId: task, add: [early] }, "m1")).ok);
    // Owner only: not the host that captured the run, not the sender, not an agent that may manage the task's assignment.
    await c.services.principals.enroll(rob, { commandId: "e-mgr", kind: "agent", name: "mgr", grants: [{ action: "assignment.manage", project }, { action: "task.read", project }] });
    const mgr = (await c.services.principals.issueCredential(rob, "agent:mgr")).token;
    const aToken = (await c.services.principals.issueCredential(rob, `agent:${a}`)).token;
    for (const [who, token] of [["host", host], ["sender", aToken], ["manager", mgr]] as const) {
      const r = await call(token, "handoff.marks.change", { taskId: task, remove: [early] }, `m-${who}`);
      assert.equal(r.error?.code, "forbidden", `${who}: ${JSON.stringify(r)}`);
    }
    assert.deepEqual((await call(mgr, "handoff.marks.get", { taskId: task })).result.item.marks, [early], "one who may control the task reads them");
    const prepared = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "A moves to the exporter" }, "h1");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const handoffId = prepared.result.item.id as string;
    const bToken = (await c.services.principals.issueCredential(rob, `agent:${b}`)).token;
    assert.equal((await call(bToken, "handoff.get", { handoffId })).error?.code, "not_found", "the recipient reads it once the task is its own, not before");
    assert.equal((await call(aToken, "handoff.get", { handoffId })).result?.item.package.sections.completedWork, prepared.result.item.package.sections.completedWork, "the sender reads it");
    assert.equal((await call(boot.token, "handoff.complete", { handoffId }, "h2")).result?.item.phase, "transferred");

    // What the next agent is given: the package as it reads it once the task is its own.
    const seen = await call(bToken, "handoff.get", { handoffId });
    assert.ok(seen.ok && seen.result.item !== undefined, JSON.stringify(seen).slice(0, 300));
    const pkg = seen.result.item.package;
    for (const [name, text] of Object.entries(pkg.sections as Record<string, string>)) assert.ok(text.length <= 4000, `${name} is ${text.length} characters`);
    const lastLine = (s: string) => s.split("\n").at(-1)!;
    assert.equal(lastLine(pkg.sections.completedWork), `Decision: ${failure}`, "the newest decision, the latest failure, is the last line the next agent sees");
    assert.ok(pkg.sections.completedWork.split("\n").includes(`Decision: ${early}`), "the owner's marked early decision is kept");
    assert.match(pkg.sections.nextAction, new RegExp(failure));
    assert.match(lastLine(pkg.sections.unfinishedWork), new RegExp(`^${effects[199]!.effectId} \\(unknown\\)$`), "the newest pending effect is in view");
    assert.match(pkg.sections.unfinishedWork.split("\n")[1]!, /^Effects pending at the last checkpoint/, "its heading too");
    assert.match(lastLine(pkg.sections.drafts), new RegExp(`^${drafts[0]} "draft 0, revised last": NEWEST-DRAFT`), "the draft changed last is the newest, whatever its ID");
    assert.match(lastLine(pkg.sections.responsibilities), new RegExp(`^${duties[0]!.id} "duty 0, changed last"`), "the responsibility changed last is the newest");
    assert.match(pkg.sections.responsibilities.split("\n")[1]!, /answers for these in the project/, "the line saying what the list is heads it");
    assert.match(pkg.sections.brief.split("\n")[1]!, /^build the CSV importer$/);

    // Every section over the limit is cut with a marker, listed in `cuts`, and its archive reads back the section as the source gave it.
    const cut = new Map<string, string>((pkg.cuts as { section: string; archiveId: string }[]).map((x) => [x.section, x.archiveId]));
    assert.deepEqual([...cut.keys()].sort(), ["brief", "completedWork", "drafts", "responsibilities", "unfinishedWork", "backgroundOperations"].sort());
    for (const [section, archiveId] of cut) {
      const m = MARKER.exec(pkg.sections[section]);
      assert.ok(m !== null && m[3] === archiveId, `${section} begins with the marker naming its archive`);
    }
    const whole = async (token: string, archiveId: string): Promise<string | undefined> => {
      const first = await call(token, "handoff.archive.read", { archiveId });
      if (!first.ok) return undefined;
      let text = first.result.item.text as string;
      for (let part = 1; part < first.result.item.parts; part++) text += (await call(token, "handoff.archive.read", { archiveId, part })).result.item.text;
      return text;
    };
    assert.equal(await whole(bToken, cut.get("completedWork")!), [...artifacts.map((x) => `Artifact: ${x}`), ...decisions.map((x) => `Decision: ${x}`)].join("\n"), "every artifact and every decision, in order");
    assert.equal((await whole(bToken, cut.get("unfinishedWork")!))!.split("\n").slice(1).join("\n"), effects.map((e) => `${e.effectId} (${e.state})`).join("\n"));
    assert.equal(await whole(bToken, cut.get("backgroundOperations")!), effects.map((e) => `${e.effectId}: ${e.state}`).join("\n"));
    assert.equal(await whole(bToken, cut.get("brief")!), `build the CSV importer\n${description}`);
    const draftArchive = (await whole(bToken, cut.get("drafts")!))!;
    const archivedDrafts = draftArchive.split("\n").map((l) => l.slice(0, 24));
    assert.deepEqual([...archivedDrafts].sort(), [...drafts].sort(), "every draft");
    assert.equal(archivedDrafts.at(-1), drafts[0], "the one changed last, last");
    const dutyArchive = (await whole(boot.token, cut.get("responsibilities")!))!;
    for (const r of duties) assert.ok(dutyArchive.includes(r.id), r.id);

    // A caller who may only control the task neither sees the sender's drafts nor reads their archive; the task's own sections it may read.
    const mgrSeen = (await call(mgr, "handoff.get", { handoffId })).result.item;
    assert.equal(mgrSeen.package.sections.drafts, undefined);
    assert.ok(!(mgrSeen.package.cuts as { section: string }[]).some((x) => x.section === "drafts" || x.section === "responsibilities"));
    assert.equal(await whole(mgr, cut.get("drafts")!), undefined);
    assert.equal(await whole(mgr, cut.get("completedWork")!), await whole(boot.token, cut.get("completedWork")!));

    // The owner reads what was cut by chat's status view, after the hand-off is over: the task's cuts are listed, and a section reads on, a chat answer at a time, to its end.
    const ask = async (token: string, request: Record<string, unknown>) => (await call(token, "status.ask", { request: { kind: "handoff_archive", ...request } })) as any;
    const listed = await ask(boot.token, { taskId: task });
    assert.ok(listed.ok, JSON.stringify(listed));
    const listing = listed.result.item.lines.map((l: { text: string }) => l.text).join("\n");
    assert.match(listing, /^6 sections of the latest hand-off of this task \(transferred\) were cut to fit; say which to read\./);
    for (const [section, archiveId] of cut) assert.match(listing, new RegExp(`The ${section} section: \\d+ of \\d+ entries left out or shortened; whole in archive ${archiveId}\\.`));
    const rows: string[] = [];
    let from: number | undefined = 1;
    for (let pages = 0; from !== undefined; pages++) {
      assert.ok(pages < 40, "the reading ends");
      const page = await ask(boot.token, { taskId: task, section: "completedWork", from });
      assert.ok(page.ok, JSON.stringify(page));
      const lines: string[] = page.result.item.lines.map((l: { text: string }) => l.text);
      assert.ok(lines.length <= 30, "an answer fits what a chat answer shows");
      assert.match(lines[0]!, /^The completedWork section of hand-off hnd-[a-z2-7]{20} as the source gave it \(credentials removed\): 340 entries/);
      rows.push(...lines.slice(1, -1));
      const more = /ask again with from (\d+) to read on\.$/.exec(lines.at(-1)!);
      from = more === null ? undefined : Number(more[1]);
    }
    assert.deepEqual(rows, [...artifacts.map((x) => `Artifact: ${x}`), ...decisions.map((x) => `Decision: ${x}`)].map((x, i) => `${i + 1}: ${x}`), "every entry, numbered, once");
    // By the archive ID a marker names, the same; the recipient may ask too, a stranger reads nothing.
    const byId = await ask(bToken, { archiveId: cut.get("drafts")!, from: 20 });
    assert.match(byId.result.item.lines[1].text, new RegExp(`^20: ${drafts[0]} "draft 0, revised last"`));
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
    assert.equal((await ask(zed, { taskId: task })).error?.code, "not_found");
    assert.equal((await ask(zed, { archiveId: cut.get("brief")! })).error?.code, "not_found");
    // Someone who controls the task is not told of the sender's own cuts.
    const mgrList = (await ask(mgr, { taskId: task })).result.item.lines.map((l: { text: string }) => l.text).join("\n");
    assert.match(mgrList, /^4 sections/);
    assert.doesNotMatch(mgrList, /drafts|responsibilities/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
