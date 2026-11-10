import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { START_SIZE_LIMITS, StartSizeService, risingRun, startSizeAlertText, type StartSizeSample } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-10T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

test("a rising run counts consecutive rises at the end, each by at least the owner's percent", () => {
  assert.equal(risingRun([10, 20, 30, 40], 1), 3);
  assert.equal(risingRun([10, 40, 30, 40], 1), 1);
  assert.equal(risingRun([10, 10, 10], 0), 0, "flat is not a rise");
  assert.equal(risingRun([40, 30, 20], 0), 0, "falling is not a rise");
  assert.equal(risingRun([1000, 1005, 1010], 1), 0, "half a percent a step is noise under a 1 percent threshold");
  assert.equal(risingRun([1000, 1005, 1010], 0), 2);
});

for (const backend of backends) {
  interface Ctx { storage: ControllerStorage; owner: Principal; host: Principal; ann: Principal; eve: Principal; t: string; projects: ProjectService; watch: StartSizeService }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const t = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
        const enroll = async (kind: "agent" | "host", nm: string, project: string) => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: [{ action: "attempt.work", project }] });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        await body({ storage: world.storage, owner, host: await enroll("host", "h1", a), ann: await enroll("agent", "ann", a), eve: await enroll("agent", "eve", b), t, projects, watch: StartSizeService.withEpoch(world.storage, projects.epoch, options) });
      } finally { await world.close(); }
    });
  /** One attempt's first call; hand-off `i` of the task. */
  const sample = (t: string, i: number, tokens: number, extra: { [K in keyof StartSizeSample]?: StartSizeSample[K] | undefined } = {}): StartSizeSample => Object.fromEntries(Object.entries({ taskId: t, attemptId: `att-${i}`, key: "r1", route: "local/qwen", worker: "local", tokens, window: 131_072, limitTokens: 32_768, admitted: true, parts: { task: 200, conversation: Math.max(0, tokens - 1200), handoff: 1000 }, refs: [`hof-${"a".repeat(20)}`], ...extra }).filter(([, v]) => v !== undefined)) as unknown as StartSizeSample;

  suite("a starting size that rises over the owner's number of hand-offs raises ONE alert with the trend and the contributors, and a new run after a break raises a new one", async ({ watch, host, t }) => {
    const sizes = [5000, 5000, 6000, 7000, 8000, 9000, 10_000, 6000, 7000, 8000, 9000];
    const opened: string[][] = [];
    for (let i = 0; i < sizes.length; i++) opened.push((await watch.record(host, sample(t, i, sizes[i]!))).opened.map((a) => `${a.kind}@${i}`));
    // Default: three rises in a row. 5000 -> 6000 -> 7000 -> 8000 is the third rise (hand-off 4); the run goes on to 10000 without another alert; it breaks at 6000; 7000, 8000, 9000 are three rises again.
    assert.deepEqual(opened.flat(), ["trend@4", "trend@10"]);
    const read = (await watch.read(host, { taskId: t }))!;
    assert.equal(read.raised, 2);
    const alert = read.alerts.trend!;
    assert.equal(alert.state, "open");
    assert.deepEqual(alert.tokens, [6000, 7000, 8000, 9000]);
    assert.equal(alert.openedAtHandoff, 10);
    // The contributor that grew is named first: the stored conversation, by 3000.
    assert.deepEqual(alert.contributors[0], { part: "conversation", tokens: 7800, grew: 3000 });
    assert.deepEqual(alert.refs, [`hof-${"a".repeat(20)}`]);
    assert.match(startSizeAlertText(alert), /rose over 3 hand-offs in a row \(6000 -> 7000 -> 8000 -> 9000 tokens, up to hand-off 10\); largest contributors: stored conversation 7800 \(\+3000\)/);
    assert.match(startSizeAlertText(alert), /Nothing was cut for it$/);
  });

  suite("a flat or falling starting size raises nothing", async ({ watch, host, t }) => {
    for (const [i, s] of [9000, 9000, 9000, 8000, 7000, 7000, 6000, 6050, 6000].entries()) assert.deepEqual((await watch.record(host, sample(t, i, s))).opened, []);
    const read = (await watch.read(host, { taskId: t }))!;
    assert.deepEqual(read.alerts, {});
    assert.equal(read.raised, 0);
  });

  suite("passing 80 percent of the startup limit warns once, before the refusal line; falling back clears it", async ({ watch, host, t }) => {
    // 26215 is 80.0 percent of 32768: warned while still admitted (the refusal is above 100 percent of this limit, which is 25 percent of the window).
    assert.deepEqual((await watch.record(host, sample(t, 0, 20_000))).opened, []);
    const warned = (await watch.record(host, sample(t, 1, 26_215))).opened;
    assert.deepEqual(warned.map((a) => [a.kind, a.share, a.limitTokens]), [["share", 80, 32_768]]);
    assert.match(startSizeAlertText(warned[0]!), /is 80 percent of the route's startup limit of 32768 tokens \(the first call is refused above it\)/);
    // Still above (and then refused): no second warning.
    assert.deepEqual((await watch.record(host, sample(t, 2, 27_000))).opened, []);
    // (Three rises in a row by now: that is the other alert, the trend; the share is not warned again.)
    assert.deepEqual((await watch.record(host, sample(t, 3, 40_000, { admitted: false }))).opened.map((a) => a.kind), ["trend"]);
    assert.equal((await watch.read(host, { taskId: t }))!.points[3]!.share, 122.1);
    // Back below the line: cleared; above again: a new warning.
    assert.deepEqual((await watch.record(host, sample(t, 4, 10_000))).opened, []);
    assert.equal((await watch.read(host, { taskId: t }))!.alerts.share!.state, "cleared");
    assert.deepEqual((await watch.record(host, sample(t, 5, 30_000))).opened.map((a) => a.kind), ["share"]);
  });

  suite("a route of unknown window is recorded with its size and no limit or share (unknown, not zero), local and remote alike", async ({ watch, host, t }) => {
    await watch.record(host, sample(t, 0, 4000, { window: undefined, limitTokens: undefined, admitted: false }));
    await watch.record(host, sample(t, 1, 5000, { worker: "remote", window: undefined, limitTokens: undefined, admitted: false }));
    const read = (await watch.read(host, { taskId: t }))!;
    assert.deepEqual(read.points.map((p) => [p.worker, p.tokens, p.window, p.limitTokens, p.share, p.handoff]), [["local", 4000, undefined, undefined, undefined, 0], ["remote", 5000, undefined, undefined, undefined, 1]]);
    assert.ok(!("share" in read.points[0]!), "no share is stored, not 0");
  });

  suite("a call of unknown window neither raises nor clears the share warning (unknown is not below the line)", async ({ watch, host, t }) => {
    assert.deepEqual((await watch.record(host, sample(t, 0, 30_000))).opened.map((a) => a.kind), ["share"]);
    assert.deepEqual((await watch.record(host, sample(t, 1, 29_000, { window: undefined, limitTokens: undefined, admitted: false }))).opened, []);
    assert.equal((await watch.read(host, { taskId: t }))!.alerts.share!.state, "open", "an unknown share does not clear the warning");
    assert.deepEqual((await watch.record(host, sample(t, 2, 31_000))).opened, [], "still above: not warned twice");
    await watch.record(host, sample(t, 3, 10_000));
    assert.equal((await watch.read(host, { taskId: t }))!.alerts.share!.state, "cleared");
  });

  suite("the thresholds are the owner's, validated, and used from the next call", async ({ watch, owner, host, ann, t }) => {
    await refuses("forbidden", () => watch.changeSettings(ann, { commandId: cid("s"), set: { risingHandoffs: 2 } }));
    await refuses("forbidden", () => watch.getSettings(ann));
    for (const bad of [{ risingHandoffs: 1 }, { risingHandoffs: 21 }, { warnPercent: 100 }, { warnPercent: 49 }, { minRisePercent: -1 }, { risingHandoffs: 2.5 }, { warnPercent: "80" }, { other: 3 }]) await refuses("invalid_command", () => watch.changeSettings(owner, { commandId: cid("s"), set: bad }));
    await refuses("invalid_command", () => watch.changeSettings(owner, { commandId: cid("s") }));
    await refuses("invalid_command", () => watch.changeSettings(owner, { commandId: cid("s"), set: { warnPercent: 70 }, unset: ["warnPercent"] }));
    assert.deepEqual((await watch.getSettings(owner)).effective, { risingHandoffs: 3, warnPercent: 80, minRisePercent: 1 });
    const { revision } = await watch.changeSettings(owner, { commandId: cid("s"), set: { risingHandoffs: 2, warnPercent: 60 } });
    await refuses("stale_revision", () => watch.changeSettings(owner, { commandId: cid("s"), set: { minRisePercent: 5 }, expectedRevision: revision - 1 }));
    assert.deepEqual((await watch.getSettings(owner)).effective, { risingHandoffs: 2, warnPercent: 60, minRisePercent: 1 });
    await watch.record(host, sample(t, 0, 1000));
    await watch.record(host, sample(t, 1, 2000));
    assert.deepEqual((await watch.record(host, sample(t, 2, 20_000))).opened.map((a) => a.kind).sort(), ["share", "trend"], "two rises and 61 percent");
    await watch.changeSettings(owner, { commandId: cid("s"), unset: ["risingHandoffs", "warnPercent"] });
    assert.deepEqual((await watch.getSettings(owner)).effective, { risingHandoffs: 3, warnPercent: 80, minRisePercent: 1 });
  });

  suite("a repeat of the same admission records nothing new; another round of the same attempt replaces its point and is not a hand-off", async ({ watch, host, t }) => {
    await watch.record(host, sample(t, 0, 1000));
    const again = await watch.record(host, sample(t, 0, 1000));
    assert.equal(again.replayed, true);
    await watch.record(host, sample(t, 0, 900, { key: "r2" }));
    const read = (await watch.read(host, { taskId: t }))!;
    assert.equal(read.attempts, 1);
    assert.deepEqual(read.points.map((p) => [p.attemptId, p.tokens, p.handoff]), [["att-0", 900, 0]]);
  });

  suite("the recorded figures are bounded: older points are rolled up, not kept without limit", async ({ watch, host, t }) => {
    const total = START_SIZE_LIMITS.points + 30;
    for (let i = 0; i < total; i++) await watch.record(host, sample(t, i, 1000 + (i % 7) * 10));
    const read = (await watch.read(host, { taskId: t }))!;
    assert.equal(read.points.length, START_SIZE_LIMITS.points);
    assert.equal(read.attempts, total);
    assert.equal(read.points[0]!.handoff, 30);
    assert.deepEqual({ count: read.rolled!.count, from: read.rolled!.fromHandoff, to: read.rolled!.toHandoff, min: read.rolled!.minTokens, max: read.rolled!.maxTokens }, { count: 30, from: 0, to: 29, min: 1000, max: 1060 });
    assert.equal(read.rolled!.sumTokens, Array.from({ length: 30 }, (_, i) => 1000 + (i % 7) * 10).reduce((x, y) => x + y, 0));
  });

  suite("watching changes no task content: the task keeps its revision and nothing but the watch's own record is written", async ({ watch, host, t, projects, storage }) => {
    const before = (await projects.getTask(t))!;
    for (let i = 0; i < 5; i++) await watch.record(host, sample(t, i, 1000 * (i + 1), { limitTokens: 4000 }));
    assert.equal((await watch.openAlerts(t)).length, 2, "both alerts are open");
    const afterTask = (await projects.getTask(t))!;
    assert.equal(afterTask.revision, before.revision);
    assert.deepEqual({ ...afterTask }, { ...before });
    const audit = await storage.listAudit({ afterSeq: 0, limit: 1000 });
    const written = new Set(audit.filter((e) => e.type.startsWith("context.start-size")).map((e) => e.subject?.kind));
    assert.deepEqual([...written], ["ctx-start-size"]);
  });

  suite("only the controller records; the owner and those who may work on the task read; anyone else reads nothing", async ({ watch, owner, host, ann, eve, t }) => {
    await refuses("forbidden", () => watch.record(ann, sample(t, 0, 1000)));
    await watch.record(host, sample(t, 0, 1000));
    assert.equal((await watch.read(owner, { taskId: t }))!.points.length, 1);
    assert.equal((await watch.read(ann, { taskId: t }))!.points.length, 1);
    assert.equal(await watch.read(eve, { taskId: t }), undefined);
    await refuses("invalid_command", () => watch.record(host, sample(t, 1, -5)));
    await refuses("invalid_command", () => watch.record(host, sample(t, 1, 5, { parts: { secret: 3 } as never })));
    await refuses("invalid_command", () => watch.record(host, sample(t, 1, 5, { worker: "elsewhere" as never })));
  });
}
