import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/types.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CheckRunService, CheckRunSettingsService, IncidentService, ResponsibilityChecks, ResponsibilityProbeService, ResponsibilityService, httpCheckProbe, nodeProbeRequest, probeResult, type ProbeAnswer, type ProbeRequest } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-11-12T10:00:00.000Z";
const iso = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));

/** A request the test answers by hand: each call waits until `answer` is called for it. */
function manualRequest(): { request: ProbeRequest; calls: { url: string; timeoutMs: number }[]; answer(a: ProbeAnswer): Promise<void> } {
  const calls: { url: string; timeoutMs: number }[] = [];
  const waiting: ((a: ProbeAnswer) => void)[] = [];
  return {
    calls,
    request: (url, timeoutMs) => { calls.push({ url, timeoutMs }); return new Promise((resolve) => waiting.push(resolve)); },
    answer: async (a) => { const next = waiting.shift(); assert.ok(next !== undefined, "a request is waiting"); next(a); await new Promise((r) => setImmediate(r)); },
  };
}

// Card P04, slice P04i: the owner's HTTP probe takes a due check with no agent and no model.
for (const backend of backends) {
  interface World {
    owner: Principal; ann: Principal; project: string; setNow(minutes: number): void;
    duties: ResponsibilityService; checks: ResponsibilityChecks; inc: IncidentService; probes: ResponsibilityProbeService;
    runner(request: ProbeRequest, maxInFlight?: number, extra?: { primary?: () => Promise<boolean>; signal?: AbortSignal }): CheckRunService;
    storage: ControllerStorage; epoch: number; takeOver(): Promise<void>;
    make(extra?: Record<string, unknown>): Promise<string>;
    taskCount(): Promise<number>;
    raw: { put(id: string, body: unknown): Promise<void> };
  }
  const suite = (name: string, body: (c: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = T0;
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const duties = ResponsibilityService.withEpoch(world.storage, epoch, options);
        const checks = ResponsibilityChecks.withEpoch(world.storage, epoch, duties, options);
        const inc = IncidentService.withEpoch(world.storage, epoch, duties, options);
        const settings = CheckRunSettingsService.withEpoch(world.storage, epoch, options);
        const probes = ResponsibilityProbeService.withEpoch(world.storage, epoch, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "responsibility.read", project }, { action: "responsibility.write", project }] as never });
        const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        await body({
          owner, ann, project, duties, checks, inc, probes,
          setNow: (m) => { now = iso(m); },
          runner: (request, maxInFlight, extra = {}) => CheckRunService.withEpoch(world.storage, epoch, { responsibilities: duties, checks, incidents: inc, settings, projects, assignments, probe: httpCheckProbe({ setting: (id) => probes.setting(id), request, now: () => Date.parse(now), ...(maxInFlight === undefined ? {} : { maxInFlight }), ...extra }) }, options),
          storage: world.storage, epoch,
          takeOver: async () => { await ProjectService.open(world.storage, { holder: "c2", ...options }); },
          make: async (extra = {}) => (await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the web up", objective: "Up", desiredCondition: "answers on /health", everyMinutes: 60, ownerId: ann.id, ...extra } as never)).id,
          taskCount: async () => (await world.storage.listAggregates("task", { limit: 500 })).length,
          raw: { put: async (id, b) => {
            const current = await world.storage.getAggregate({ kind: "responsibility-probe", id });
            await world.storage.applyOperation({ operationId: cid("raw"), epoch, actor: "owner:rob", correlationId: cid("raw"), at: now, changes: [current === undefined ? { type: "create", ref: { kind: "responsibility-probe", id }, body: b } : { type: "update", ref: { kind: "responsibility-probe", id }, expectedRevision: current.revision, body: b }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
          } },
        });
      } finally { await world.close(); }
    });

  suite("only the owner sets, reads and clears a probe; bad addresses, statuses and waits are refused and nothing is stored", async (c) => {
    const r = await c.make();
    assert.deepEqual(await c.probes.get(c.owner, r), { responsibilityId: r, revision: 0 });
    assert.equal(await code(c.probes.set(c.ann, { commandId: cid("s"), responsibilityId: r, url: "http://127.0.0.1:9/health" })), "forbidden", "an agent that may change the responsibility still cannot point the controller anywhere");
    assert.equal(await code(c.probes.get(c.ann, r)), "forbidden");
    for (const url of ["ftp://host/x", "http://user:pw@host/health", "http://host/health#x", "http://host/he alth", "file:///etc/passwd", "not an address", "", `http://host/${"a".repeat(500)}`, "http://host/health?token=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", "http://host/\u202ehtlaeh", "http://a.example\\@10.0.0.1/health", "http:/\\/host/health", "http:host/health", "http://host\u200b.example/health", "http://host/health\u0085", "http://host/\ud800", "http://host/health?api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", 42, undefined]) {
      assert.equal(await code(c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url } as never)), "invalid_command", String(url));
    }
    for (const extra of [{ expectStatus: [] }, { expectStatus: [99] }, { expectStatus: [600] }, { expectStatus: ["200"] }, { expectStatus: Array.from({ length: 11 }, (_, i) => 200 + i) }, { timeoutSeconds: 0 }, { timeoutSeconds: 31 }, { timeoutSeconds: 2.5 }, { other: 1 }, { expectedRevision: "0" }]) {
      assert.equal(await code(c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "http://127.0.0.1:9/health", ...extra } as never)), "invalid_command", JSON.stringify(extra));
    }
    assert.equal(await code(c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: "rsp-aaaaaaaaaaaaaaaaaaaa", url: "http://127.0.0.1:9/health" })), "not_found");
    assert.deepEqual(await c.probes.get(c.owner, r), { responsibilityId: r, revision: 0 }, "nothing was stored by a refused command");

    const id = cid("s");
    const set = await c.probes.set(c.owner, { commandId: id, responsibilityId: r, url: "http://web.internal:8080/health?full=1", expectStatus: [204, 200, 200], timeoutSeconds: 5 });
    assert.deepEqual(set, { revision: 1, shown: "http://web.internal:8080/health" }, "the answer shows the address without its query");
    assert.deepEqual(await c.probes.set(c.owner, { commandId: id, responsibilityId: r, url: "http://web.internal:8080/health?full=1", expectStatus: [204, 200, 200], timeoutSeconds: 5 }), set, "a repeat replays");
    const got = await c.probes.get(c.owner, r);
    assert.deepEqual([got.revision, got.probe?.url, got.probe?.expectStatus, got.probe?.timeoutSeconds, got.probe?.setBy], [1, "http://web.internal:8080/health?full=1", [200, 204], 5, c.owner.id]);
    assert.equal(await code(c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "https://web.example/health", expectedRevision: 0 })), "stale_revision");
    assert.equal((await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "https://web.example/health", expectedRevision: 1 })).revision, 2);
    const again = await c.probes.get(c.owner, r);
    assert.deepEqual([again.probe?.expectStatus, again.probe?.timeoutSeconds], [[], 10], "setting replaces the whole probe: the defaults come back");
    assert.equal(await code(c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: null, timeoutSeconds: 5 } as never)), "invalid_command");

    // Retired: setting is refused, clearing is allowed.
    const rev = (await c.duties.get(c.owner, r))!.revision;
    await c.duties.update(c.owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: rev, state: "retired" });
    assert.equal(await code(c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "https://web.example/other" })), "invalid_command");
    assert.equal((await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: null })).revision, 3);
    assert.equal((await c.probes.get(c.owner, r)).probe, undefined);
    assert.equal(await c.probes.setting(r), undefined);
    // A credential written with %-escapes in the path (the path is shown in history) is refused like one written plainly.
    const escaped = [..."ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("");
    // (On a live responsibility: the one above is retired, which is refused for its own reason.)
    const live = await c.make({ title: "Live" });
    assert.equal(await code(c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: live, url: `http://host/${escaped}/health` })), "invalid_command");
    assert.equal((await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: live, url: "http://host/a%20b/health" })).revision, 1, "ordinary escapes are fine");
    // An owner object limited to one task (none is issued today; refused all the same).
    const scoped = { ...c.owner, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project } };
    assert.equal(await code(c.probes.get(scoped, r)), "forbidden");
    assert.equal(await code(c.probes.set(scoped, { commandId: cid("s"), responsibilityId: r, url: null })), "forbidden");
  });

  suite("a due check with a probe is taken with no agent: asked once apart from the pass, the answer recorded on a later pass; a bad answer is a grouped incident", async (c) => {
    const r = await c.make();
    await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "http://web.internal/health?secret-free=1", timeoutSeconds: 3 });
    const m = manualRequest();
    const runner = c.runner(m.request);
    c.setNow(60); await c.checks.generate(c.owner, c.project);
    assert.deepEqual(await runner.run(c.owner, c.project), { observed: 0, tasks: 0, coalesced: 0, noAgent: 0, deferred: 1 }, "the pass does not wait for the answer");
    assert.deepEqual(m.calls, [{ url: "http://web.internal/health?secret-free=1", timeoutMs: 3000 }]);
    assert.deepEqual((await runner.run(c.owner, c.project)).deferred, 1, "still waiting: the check stays owed");
    assert.equal(m.calls.length, 1, "asked once, not once per pass");
    assert.equal((await c.inc.observed(c.owner, r))!.observed, "unknown", "no answer yet is never healthy");
    await m.answer({ status: 200, ms: 12 });
    assert.deepEqual(await runner.run(c.owner, c.project), { observed: 1, tasks: 0, coalesced: 0, noAgent: 0, deferred: 0 });
    assert.equal(await c.taskCount(), 0, "no agent was asked");
    assert.deepEqual(await c.checks.pending(c.owner, c.project), []);
    const history = (await c.duties.history(c.owner, r, { limit: 10 }))!.items;
    assert.deepEqual(history.map((h) => [h.kind, h.outcome, h.summary]), [["check", "ok", "HTTP check of the owner's health address answered 200 in 12 ms."]], "neither the address nor its query is written to history (agents read it)");
    assert.equal((await c.inc.observed(c.owner, r))!.observed, "ok");

    for (const [minutes, answer] of [[120, { status: 503, ms: 5 }], [180, { error: "ECONNREFUSED", ms: 1 }], [240, { error: "TIMEOUT", ms: 3000 }]] as const) {
      c.setNow(minutes); await c.checks.generate(c.owner, c.project);
      assert.equal((await runner.run(c.owner, c.project)).deferred, 1);
      await m.answer(answer);
      assert.equal((await runner.run(c.owner, c.project)).observed, 1);
    }
    const summaries = (await c.duties.history(c.owner, r, { limit: 10 }))!.items.slice(1).map((h) => [h.outcome, h.summary]);
    assert.deepEqual(summaries, [
      ["failed", "HTTP check of the owner's health address answered 503 in 5 ms (expected 200-299)."],
      ["failed", "HTTP check of the owner's health address: the connection was refused (ECONNREFUSED)."],
      ["failed", "HTTP check of the owner's health address: no answer within 3 s."],
    ]);
    const incidents = (await c.inc.list(c.owner, c.project, { open: true }))!;
    assert.deepEqual(incidents.map((i) => [i.signature, i.count, i.worst]), [["scheduled-check", 3, "failed"]], "repeated bad answers group into one incident");
    assert.equal(await c.taskCount(), 0);
    // Second review: what an agent that may read the responsibility reads (history, incidents, observed state, the checks with their notes) never names the address, its host or its query (the responsibility's own text may say /health: that is not the probe).
    const seen = JSON.stringify([await c.duties.history(c.ann, r, { limit: 50 }), await c.inc.list(c.ann, c.project, {}), await c.inc.observed(c.ann, r), await c.duties.status(c.ann, r), await c.checks.pending(c.ann, c.project), await c.storage.listAggregates("responsibility-check", { limit: 50 })]);
    assert.ok(seen.includes("the owner's health address"), seen.slice(0, 300));
    for (const part of ["web.internal", "secret-free", "http:"]) assert.ok(!seen.includes(part), `${part} is not shown to an agent: ${seen.slice(0, 2000)}`);
  });

  suite("without a probe the agent takes the check; a cleared probe hands checks back; a damaged probe is attention, never healthy; nobody answering is no obstacle for a probe", async (c) => {
    await c.make();
    // A responsibility nobody answers for: a probe still takes its check (the remote service needs no agent and no worker on it).
    const lone = await c.make({ ownerId: undefined, title: "Watch the status page" });
    await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: lone, url: "https://status.example/ping", expectStatus: [204] });
    const m = manualRequest();
    const runner = c.runner(m.request);
    c.setNow(60); await c.checks.generate(c.owner, c.project);
    assert.deepEqual(await runner.run(c.owner, c.project), { observed: 0, tasks: 1, coalesced: 0, noAgent: 0, deferred: 1 }, "no probe: a bounded task as before; with one: asked");
    assert.equal(m.calls.length, 1);
    await m.answer({ status: 204, ms: 3 });
    const pass = await runner.run(c.owner, c.project);
    assert.equal(pass.observed, 1); assert.equal(pass.noAgent, 0);
    assert.equal((await c.duties.history(c.owner, lone, { limit: 5 }))!.items[0]!.outcome, "ok", "204 was named as healthy");

    // The probe record damaged in storage: the check is attention (reported), not ok and not a silent agent task.
    await c.raw.put(lone, { responsibilityId: lone, projectId: c.project, url: "ftp://x", setBy: "owner:rob", setAt: T0 });
    assert.equal(await code(c.probes.get(c.owner, lone)), "unavailable");
    c.setNow(130); await c.checks.generate(c.owner, c.project);
    await runner.run(c.owner, c.project);
    const last = (await c.duties.history(c.owner, lone, { limit: 10 }))!.items.at(-1)!;
    assert.deepEqual([last.kind, last.outcome], ["check", "attention"]);
    assert.match(last.summary, /damaged/);

    // Cleared: the next due check goes to the agent again (here nobody answers, so it is recorded as not taken).
    await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: lone, url: null });
    c.setNow(200); await c.checks.generate(c.owner, c.project);
    const after = await c.runner(m.request).run(c.owner, c.project);
    assert.equal(after.noAgent >= 1, true, JSON.stringify(after));
    assert.equal(m.calls.length, 1, "a cleared probe asks nothing");
  });

  suite("at most the in-flight limit is asked at once (the rest wait, owed); an answer for an address the owner has since changed is not used", async (c) => {
    const a = await c.make({ title: "A" });
    const b = await c.make({ title: "B" });
    for (const r of [a, b]) await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: `http://${r === a ? "a" : "b"}.internal/health` });
    const m = manualRequest();
    const runner = c.runner(m.request, 1);
    c.setNow(60); await c.checks.generate(c.owner, c.project);
    assert.equal((await runner.run(c.owner, c.project)).deferred, 2);
    assert.equal(m.calls.length, 1, "one at a time");
    await m.answer({ status: 200, ms: 1 });
    const second = await runner.run(c.owner, c.project);
    assert.deepEqual([second.observed, second.deferred, m.calls.length], [1, 1, 2], "the first answer is taken and the second address asked");
    // The owner points the second one somewhere else while its request is out: the old answer is dropped and the new address asked. (Which one is asked first follows the check IDs.)
    const later = m.calls[1]!.url === "http://a.internal/health" ? a : b;
    const bProbe = await c.probes.get(c.owner, later);
    await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: later, url: "http://b2.internal/health", expectedRevision: bProbe.revision });
    await m.answer({ status: 500, ms: 1 });
    const third = await runner.run(c.owner, c.project);
    assert.deepEqual([third.observed, third.deferred, m.calls.at(-1)!.url], [0, 1, "http://b2.internal/health"]);
    await m.answer({ status: 200, ms: 1 });
    assert.equal((await runner.run(c.owner, c.project)).observed, 1);
    assert.equal((await c.inc.list(c.owner, c.project, { open: true }))!.length, 0, "the stale 500 was never recorded");

  });

  // First review (card P04i): one request per responsibility however many checks it owes; a changed healthy status is a changed probe; only the primary controller asks; closing starts nothing.
  suite("several owed checks of one responsibility share one request; an answer asked under other healthy statuses is not used", async (c) => {
    const r = await c.make();
    await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "http://web.internal/health" });
    const m = manualRequest();
    const runner = c.runner(m.request);
    c.setNow(60); await c.checks.generate(c.owner, c.project);
    await c.checks.recordEvent(c.owner, c.project, r, { kind: "event", source: "alerts", events: 1, firstSeq: 1, lastSeq: 1, kinds: ["alert"] }, iso(60));
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 2, "two checks are owed");
    assert.equal((await runner.run(c.owner, c.project)).deferred, 2);
    assert.equal(m.calls.length, 1, "one request for the responsibility, not one per owed check");
    // The owner now counts only 204 as healthy: the 200 asked for under the old setting is not this probe's answer.
    const now = await c.probes.get(c.owner, r);
    await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "http://web.internal/health", expectStatus: [204], expectedRevision: now.revision });
    await m.answer({ status: 200, ms: 1 });
    const second = await runner.run(c.owner, c.project);
    assert.deepEqual([second.observed, m.calls.length], [0, 2], "asked again under the new setting");
    await m.answer({ status: 200, ms: 1 });
    assert.equal((await runner.run(c.owner, c.project)).observed, 1);
    assert.deepEqual((await c.duties.history(c.owner, r, { limit: 5 }))!.items.filter((h) => h.kind === "check").map((h) => h.outcome), ["failed"], "200 is not healthy once only 204 is");
    assert.deepEqual(await c.checks.pending(c.owner, c.project), [], "one check entry finished both owed checks");
    assert.equal(m.calls.length, 2);
  });

  suite("a controller that is no longer the primary sends nothing; a closed probe starts nothing", async (c) => {
    const r = await c.make();
    await c.probes.set(c.owner, { commandId: cid("s"), responsibilityId: r, url: "http://web.internal/health" });
    c.setNow(60); await c.checks.generate(c.owner, c.project);
    const stop = new AbortController(); stop.abort();
    const closed = manualRequest();
    assert.equal((await c.runner(closed.request, undefined, { signal: stop.signal }).run(c.owner, c.project)).deferred, 1);
    assert.equal(closed.calls.length, 0, "closing: nothing is asked");
    const m = manualRequest();
    const primary = async (): Promise<boolean> => (await c.storage.currentEpoch()) === c.epoch;
    await c.takeOver();
    assert.equal((await c.runner(m.request, undefined, { primary }).run(c.owner, c.project)).deferred, 1);
    assert.equal(m.calls.length, 0, "another controller took the database: this one asks nothing");
  });
}

// Second review: the limit counts requests still out, not answers waited for. One whose probe was cleared (or changed) while it was out still holds its connection.
test("a request whose probe was cleared while it was out still counts against the limit; one responsibility never takes another's answer", async () => {
  const settings = new Map<string, { url: string; expectStatus: number[]; timeoutSeconds: number }>([["rsp-a", { url: "http://a.internal/x", expectStatus: [], timeoutSeconds: 5 }], ["rsp-b", { url: "http://b.internal/x", expectStatus: [], timeoutSeconds: 5 }]]);
  const m = manualRequest();
  const probe = httpCheckProbe({ setting: async (id) => settings.get(id), request: m.request, maxInFlight: 1, now: () => 0 });
  const ask = (id: string) => probe({ responsibility: { id } as never, check: { id: `chk-${id}`, body: {} } as never });
  assert.equal(await ask("rsp-a"), "later");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(m.calls.map((x) => x.url), ["http://a.internal/x"]);
  settings.delete("rsp-a");
  assert.equal(await ask("rsp-a"), undefined, "cleared: the agent takes it");
  settings.set("rsp-a", { url: "http://a2.internal/x", expectStatus: [], timeoutSeconds: 5 });
  assert.equal(await ask("rsp-a"), "later");
  assert.equal(await ask("rsp-b"), "later");
  await new Promise((r) => setImmediate(r));
  assert.equal(m.calls.length, 1, "the cleared request is still out: nothing more is asked at a limit of one");
  await m.answer({ status: 500, ms: 1 });
  assert.equal(await ask("rsp-b"), "later");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(m.calls.map((x) => x.url), ["http://a.internal/x", "http://b.internal/x"], "once it ended, the next is asked");
  assert.equal(await ask("rsp-a"), "later", "a's 500 (asked under the cleared probe) is not a's answer, and the limit holds");
  await m.answer({ status: 204, ms: 1 });
  assert.equal(((await ask("rsp-a")) as { outcome?: string } | undefined) , "later", "b's answer is not a's");
  await new Promise((r) => setImmediate(r));
  assert.equal(m.calls.at(-1)!.url, "http://a2.internal/x");
  assert.equal(((await ask("rsp-b")) as { outcome: string }).outcome, "ok");
});

// Second review: a request ended by the controller closing is not an answer from the address: nothing is recorded, and the check (still owed) is asked again.
test("an answer of ABORTED (the controller closing) is never taken as the check's result", async () => {
  const m = manualRequest();
  const probe = httpCheckProbe({ setting: async () => ({ url: "http://a.internal/x", expectStatus: [], timeoutSeconds: 5 }), request: m.request, now: () => 0 });
  const ask = () => probe({ responsibility: { id: "rsp-a" } as never, check: { id: "chk-a", body: {} } as never });
  assert.equal(await ask(), "later");
  await new Promise((r) => setImmediate(r));
  await m.answer({ error: "ABORTED", ms: 1 });
  assert.equal(await ask(), "later", "no result: asked again");
  await new Promise((r) => setImmediate(r));
  assert.equal(m.calls.length, 2);
});

// The real request, against a server on this machine only.
test("the real request: a status is read without the body, a redirect is not followed, silence times out, a closed port is refused; nothing throws", async () => {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(1_000_000)); return; }
    if (req.url === "/down") { res.writeHead(503); res.end(); return; }
    if (req.url === "/moved") { res.writeHead(302, { location: "/ok" }); res.end(); return; }
    // "/silent": never answers.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const ok = await nodeProbeRequest(`http://127.0.0.1:${port}/ok`, 5000);
    assert.equal("status" in ok && ok.status, 200);
    assert.equal("status" in (await nodeProbeRequest(`http://127.0.0.1:${port}/down`, 5000)) && (await nodeProbeRequest(`http://127.0.0.1:${port}/down`, 5000) as { status: number }).status, 503);
    const moved = await nodeProbeRequest(`http://127.0.0.1:${port}/moved`, 5000);
    assert.deepEqual("status" in moved && moved.status, 302);
    assert.equal(hits.filter((h) => h === "/ok").length, 1, "the redirect was not followed");
    const silent = await nodeProbeRequest(`http://127.0.0.1:${port}/silent`, 300);
    assert.equal("error" in silent && silent.error, "TIMEOUT");
    const closed = createServer(); await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port; await new Promise((r) => closed.close(r));
    const refused = await nodeProbeRequest(`http://127.0.0.1:${closedPort}/x`, 5000);
    assert.equal("error" in refused && refused.error, "ECONNREFUSED");
    // The scheme is read by the address parser, not by a prefix of the text: `HTTP://` is http, and `HTTPS://` is https (here a TLS greeting to a plain server, which fails as a TLS error, never as a request the client refused to make).
    const upper = await nodeProbeRequest(`HTTP://127.0.0.1:${port}/ok`, 5000);
    assert.equal("status" in upper && upper.status, 200, JSON.stringify(upper));
    const tls = await nodeProbeRequest(`HTTPS://127.0.0.1:${port}/ok`, 5000);
    assert.ok("error" in tls && tls.error !== "REQUEST_FAILED" && tls.error !== "TIMEOUT", JSON.stringify(tls));
    // Closing while a request is out ends it at once and closes the connection (the silent server sees it go).
    const stop = new AbortController();
    const arrived = new Promise<IncomingMessage>((resolve) => server.once("request", resolve));
    const out = nodeProbeRequest(`http://127.0.0.1:${port}/silent`, 30_000, stop.signal);
    const req = await arrived;
    const gone = new Promise<void>((resolve) => req.socket.once("close", () => resolve()));
    stop.abort();
    const aborted = await out;
    assert.equal("error" in aborted && aborted.error, "ABORTED");
    assert.ok(aborted.ms < 30_000);
    await gone;
    assert.equal((await nodeProbeRequest(`http://127.0.0.1:${port}/ok`, 5000, stop.signal) as { error?: string }).error, "ABORTED", "an ended signal asks nothing");
    const setting = { url: `http://127.0.0.1:${port}/ok?k=v`, expectStatus: [], timeoutSeconds: 5 };
    assert.deepEqual(probeResult(setting, { status: 302, ms: 1 }, true), { outcome: "failed", summary: `HTTP check of the owner's health address answered 302 in 1 ms (expected 200-299). A maintenance window was on.` });
    assert.equal(probeResult({ ...setting, expectStatus: [302] }, { status: 302, ms: 1 }, false).outcome, "ok");
    assert.equal(probeResult(setting, { error: "WEIRD_CODE", ms: 1 }, false).summary, `HTTP check of the owner's health address: the request failed (WEIRD_CODE).`);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
