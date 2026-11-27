import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatchBody } from "./model.js";
import type { InterrogationInput, InterrogatorAnswer, ReportInterrogatorPort, ReportVerdict } from "./report.js";
import type { WorkerTurnResult } from "./ports.js";
import { replyCutOf } from "./ports.js";

after(stopServer);

// W09 fixes, on each of the four storage backends: a questioning that did not run records why and its named cause on the report and on the questioning; the second agent is given the task's description; and the worker's
// reply cuts (replies cut at the reply limit with no visible text, the limit it raised to) go on the attempt's turn ending.

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
class Scripted implements ReportInterrogatorPort {
  readonly inputs: InterrogationInput[] = [];
  constructor(private readonly answer: { verdict: "supported" } | Error) {}
  async ask(input: InterrogationInput): Promise<InterrogatorAnswer> { this.inputs.push(input); if (this.answer instanceof Error) throw this.answer; return { ...this.answer, route: "radiance/judge" } as InterrogatorAnswer; }
}

async function turn(w: DispatchWorld, inTurn: (attemptId: string) => Promise<void>, end: Partial<WorkerTurnResult> = {}): Promise<string> {
  let id = "";
  let failed: unknown;
  w.worker.script = async ({ order }) => { id = order.attemptId; try { await inTurn(order.attemptId); } catch (error) { failed = error; } return { status: "completed", text: "turn over", endKind: "normal", ...end }; };
  await w.heartbeatHost();
  await w.dispatcher.tick();
  await w.dispatcher.idle();
  if (failed !== undefined) throw failed;
  assert.notEqual(id, "", "the turn ran");
  return id;
}
const body = async (w: DispatchWorld, attemptId: string): Promise<DispatchBody> => (await w.dispatcher.get(w.owner, attemptId))! as unknown as DispatchBody;

for (const backend of backends) {
  test(`${backend.name}: a questioning that did not run records why, redacted and bounded, and its named cause, on the report and on the questioning (W09 fixes)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const P = w.dispatcherPrincipal;
      const cases: [Error | undefined, string, RegExp][] = [
        [undefined, "not-set-up", /^no second agent is set up on this controller$/],
        [new DomainError("unavailable", `no route answered the second agent's questions (reply-cut: the reply was cut at the 32768-token reply limit before it held any text (the route's ceiling)) ${SECRET}`), "reply-cut", /^the second agent could not be asked: no route answered the second agent's questions \(reply-cut: the reply was cut .*\[redacted\]/],
        [new DomainError("unavailable", "no route answered the second agent's questions (timeout: route radiance/judge did not answer within 540000 ms)"), "timeout", /did not answer within 540000 ms/],
        [new DomainError("unavailable", "no reviewer route is set, so no second agent questioned the report"), "no-route", /no reviewer route is set/],
        [new Error(`x${"y".repeat(5000)}`), "error", /^the second agent could not be asked: xy+$/],
      ];
      for (const [i, [error, cause, why]] of cases.entries()) {
        await w.task(`case ${i}`, ann);
        if (error !== undefined) w.dispatcher = w.restart({ interrogator: new Scripted(error) });
        let v: ReportVerdict | undefined;
        const id = await turn(w, async (a) => { v = await w.dispatcher.interrogateDone(P, a, { key: "k1", report: "Done.", verified: "passed" }); });
        assert.deepEqual(v, { state: "not-run" }, cause);
        const d = await body(w, id);
        assert.equal(d.report?.questioning, "not-run", cause);
        assert.match(d.report?.why ?? "", why, cause);
        assert.ok((d.report?.why ?? "").length <= 300 && !(d.report?.why ?? "").includes(SECRET), "bounded and redacted");
        assert.deepEqual([d.report?.cause, d.interrogation?.cause, d.interrogation?.why], [cause, cause, d.report?.why], cause);
      }
      // A questioning that ran names no cause.
      await w.task("asked", ann);
      w.dispatcher = w.restart({ interrogator: new Scripted({ verdict: "supported" }) });
      const id = await turn(w, async (a) => { await w.dispatcher.interrogateDone(P, a, { key: "k1", report: "Done.", verified: "passed" }); });
      const d = await body(w, id);
      assert.deepEqual([d.report?.questioning, d.report?.cause, d.interrogation?.cause, d.report?.why], ["supported", undefined, undefined, undefined]);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: the second agent is given the task's description as the agent was, with the edge cases it names (W09 fixes)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const description = "Quote every label. CONTRACT: a long name is cut between whole characters and whole escapes, at its own bound and at the line's.";
      await w.task("quote lines", ann, { description });
      const judge = new Scripted({ verdict: "supported" });
      w.dispatcher = w.restart({ interrogator: judge });
      await turn(w, async (a) => { await w.dispatcher.interrogateDone(w.dispatcherPrincipal, a, { key: "k1", report: "Done.", verified: "passed" }); });
      assert.equal(judge.inputs.length, 1);
      assert.equal(judge.inputs[0]!.task.description, description);
      assert.equal(judge.inputs[0]!.task.title, "quote lines");
      // A task with no description gives none (not an empty text).
      await w.task("bare", ann);
      await turn(w, async (a) => { await w.dispatcher.interrogateDone(w.dispatcherPrincipal, a, { key: "k1", report: "Done.", verified: "passed" }); });
      assert.equal(judge.inputs[1]!.task.description, undefined);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: the worker's reply cuts go on the attempt's turn ending; a malformed record is left out, never guessed (W09 fixes)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      await w.task("cut", ann);
      const cut = { cuts: 3, limit: 16_384, ceiling: 25_000 };
      const first = await turn(w, async () => undefined, { endKind: "normal", visibleChars: 12, replyCut: cut });
      assert.deepEqual((await body(w, first)).turnEnd?.replyCut, cut);
      assert.equal((await body(w, first)).turnEnd?.endKind, "normal");
      for (const bad of [{ cuts: 1, limit: 30_000, ceiling: 25_000 }, { cuts: -1, limit: 1, ceiling: 2 }, { cuts: 1, limit: 0, ceiling: 2 }, { cuts: 1, limit: 2, ceiling: 2, extra: 1 }, { cuts: 1.5, limit: 2, ceiling: 2 }, { cuts: 1001, limit: 2, ceiling: 2 }, "3"]) {
        assert.equal(replyCutOf(bad), undefined, JSON.stringify(bad));
        await w.task(`bad ${JSON.stringify(bad)}`.slice(0, 80), ann);
        const id = await turn(w, async () => undefined, { endKind: "normal", replyCut: bad as never });
        assert.equal((await body(w, id)).turnEnd?.replyCut, undefined, JSON.stringify(bad));
      }
      await w.task("none", ann);
      const none = await turn(w, async () => undefined);
      assert.equal((await body(w, none)).turnEnd?.replyCut, undefined);
    } finally { await store.close(); }
  });
}
