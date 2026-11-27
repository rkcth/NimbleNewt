import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import { STOPPED_EARLY_KIND, type DispatchBody } from "./model.js";
import type { InterrogationInput, InterrogatorAnswer, ReportInterrogatorPort, ReportVerdict } from "./report.js";
import type { WorkerTurnResult } from "./ports.js";
import { promptOf } from "../work-end/interrogator.js";

after(stopServer);

// Card W09 third slice: for a task whose contract has clauses, the second agent's supported is taken only once every clause is shown tested in the report or was asked about in an answered question. The W09 bench's false
// dones were all a supported (once after no question) over a report that did not show a clause tested. The second agent here is scripted and always says supported, the way the same model did on the bench.

class Always implements ReportInterrogatorPort {
  readonly inputs: InterrogationInput[] = [];
  constructor(private readonly answer: { verdict: "supported" } | { verdict: "questions"; questions: string[] } = { verdict: "supported" }) {}
  async ask(input: InterrogationInput): Promise<InterrogatorAnswer> { this.inputs.push(input); return { ...this.answer, route: "local/judge" } as InterrogatorAnswer; }
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

const countOf = async (w: DispatchWorld, taskId: string): Promise<number> => ((await w.storage.getAggregate({ kind: STOPPED_EARLY_KIND, id: taskId }))?.body as { readmits?: number } | undefined)?.readmits ?? 0;
const body = async (w: DispatchWorld, attemptId: string): Promise<DispatchBody> => (await w.dispatcher.get(w.owner, attemptId))! as unknown as DispatchBody;
const questionsOf = (v: ReportVerdict): string[] => [...((v as { message: string }).message.matchAll(/^\d\. "(C\d+) /gm))].map((m) => m[1]!);

async function world(store: Parameters<typeof buildWorld>[0], criteria: readonly string[] | undefined, judge: ReportInterrogatorPort): Promise<{ w: DispatchWorld; taskId: string }> {
  const w = await buildWorld(store);
  const ann = await w.agent("ann", workGrants(w.project, []));
  const { taskId } = await w.task("quote lines", ann);
  await w.contracts.setContract(w.owner, { commandId: "c1", taskId, expectedVersion: 0, expectedResult: "lines are quoted", ...(criteria === undefined ? {} : { acceptanceCriteria: criteria }) } as never);
  w.dispatcher = w.restart({ interrogator: judge });
  w.worker.progress = async () => ({ plan: { done: ["quote"], open: [] }, diffStat: "1 file changed" });
  return { w, taskId };
}

const CRITERIA = ["a long name is cut between whole characters", "an empty input gives an empty list"];

for (const backend of backends) {
  test(`${backend.name}: with clauses, a supported after no question is held back: the controller asks one question per clause the report does not show tested, and the answered round lets the next supported through; nothing is counted (W09 third slice)`, async () => {
    const store = await backend.open();
    const opened: { close(): Promise<void> }[] = [];
    try {
      const judge = new Always();
      const { w, taskId } = await world(store.storage, CRITERIA, judge);
      const P = w.dispatcherPrincipal;
      const v: ReportVerdict[] = [];
      const attemptId = await turn(w, async (id) => {
        v.push(await w.dispatcher.interrogateDone(P, id, { key: "k1", report: "Quoted the lines; my tests pass.", verified: "passed" }));
        await w.dispatcher.answerQuestions(P, id, { key: "a1", answers: ['src/quote.test.ts "cuts between whole characters" ok 3', 'src/quote.test.ts "empty input" ok 4'] });
        v.push(await w.dispatcher.interrogateDone(P, id, { key: "k2", report: "Quoted the lines; my tests pass.", verified: "passed" }));
      });
      assert.equal(v[0]!.state, "asking");
      assert.deepEqual(questionsOf(v[0]!), ["C1", "C2"]);
      assert.match((v[0] as { message: string }).message, /1\. "C1 \\"a long name is cut between whole characters\\": your report does not show this clause tested\. Name its test/);
      assert.deepEqual(v[1], { state: "supported" });
      assert.equal(judge.inputs.length, 2);
      const d = await body(w, attemptId);
      assert.equal(d.report?.questioning, "supported");
      assert.deepEqual(d.report?.qa?.map((x) => x.question.slice(0, 3)), ["C1 ", "C2 "]);
      assert.equal(d.interrogation?.rounds[0]?.route, "local/judge", "the round is recorded with the second agent's route");
      assert.equal(await countOf(w, taskId), 0, "questions are not a go-on");
      // What the second agent was shown: the clauses numbered, and which are not shown tested; after the answered round, none.
      const first = promptOf(judge.inputs[0]!), second = promptOf(judge.inputs[1]!);
      assert.match(first, /Acceptance criteria: C1 "a long name is cut between whole characters", C2 "an empty input gives an empty list"/);
      assert.match(first, /Clauses not shown tested \(a report line naming C<n>, a test name in double quotes and a passing result\) and not asked about: C1, C2\. Ask about each before you answer supported/);
      assert.match(second, /Clauses: each of C1 to C2 is shown tested .* or was asked about\./);
    } finally { for (const o of opened) await o.close(); await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: with clauses, a report that shows each clause tested is taken at once; a report that shows one is asked about the other only; without clauses the old behaviour holds (W09 third slice)`, async () => {
    const store = await backend.open();
    const opened: { close(): Promise<void> }[] = [];
    try {
      const judge = new Always();
      const { w } = await world(store.storage, CRITERIA, judge);
      const P = w.dispatcherPrincipal;
      const v: ReportVerdict[] = [];
      await turn(w, async (id) => {
        v.push(await w.dispatcher.interrogateDone(P, id, { key: "k1", report: 'Quoted the lines.\nC1: src/quote.test.ts "cuts between whole characters" ok 3\nC2: src/quote.test.ts "empty input" not ok 4', verified: "passed" }));
        await w.dispatcher.answerQuestions(P, id, { key: "a1", answers: ["fixed it: ok 4 now"] });
        v.push(await w.dispatcher.interrogateDone(P, id, { key: "k2", report: 'Quoted the lines.\nC1: src/quote.test.ts "cuts between whole characters" ok 3\nC2: src/quote.test.ts "empty input" ok 4', verified: "passed" }));
      });
      assert.equal(v[0]!.state, "asking");
      assert.deepEqual(questionsOf(v[0]!), ["C2"], "a failing run does not show the clause tested");
      assert.deepEqual(v[1], { state: "supported" });

      const plain = new Always();
      const extra = await backend.open();
      opened.push(extra);
      const other = await world(extra.storage, undefined, plain);
      const u: ReportVerdict[] = [];
      await turn(other.w, async (id) => { u.push(await other.w.dispatcher.interrogateDone(other.w.dispatcherPrincipal, id, { key: "k1", report: "Quoted the lines.", verified: "passed" })); });
      assert.deepEqual(u, [{ state: "supported" }], "a task without clauses: the second agent's supported is taken as before");
      assert.ok(!promptOf(plain.inputs[0]!).includes("Clauses"), "nor is anything said of clauses");
      assert.match(promptOf(plain.inputs[0]!), /Acceptance criteria: \(none\)/);
    } finally { for (const o of opened) await o.close(); await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: with more clauses than the rounds can ask, the last round's supported is unsupported, names the clauses left and counts as a go-on; the second agent's own questions keep their place (W09 third slice)`, async () => {
    const store = await backend.open();
    const opened: { close(): Promise<void> }[] = [];
    try {
      const seven = Array.from({ length: 7 }, (_, i) => `rule ${i + 1} holds for every offset`);
      const judge = new Always();
      const { w, taskId } = await world(store.storage, seven, judge);
      const P = w.dispatcherPrincipal;
      const v: ReportVerdict[] = [];
      const attemptId = await turn(w, async (id) => {
        v.push(await w.dispatcher.interrogateDone(P, id, { key: "k1", report: "All done.", verified: "passed" }));
        await w.dispatcher.answerQuestions(P, id, { key: "a1", answers: ["x", "y", "z"] });
        v.push(await w.dispatcher.interrogateDone(P, id, { key: "k2", report: "All done.", verified: "passed" }));
        await w.dispatcher.answerQuestions(P, id, { key: "a2", answers: ["x", "y", "z"] });
        v.push(await w.dispatcher.interrogateDone(P, id, { key: "k3", report: "All done.", verified: "passed" }));
      });
      assert.deepEqual(questionsOf(v[0]!), ["C1", "C2", "C3"]);
      assert.deepEqual(questionsOf(v[1]!), ["C4", "C5", "C6"]);
      assert.equal(v[2]!.state, "unsupported");
      assert.match((v[2] as { message: string }).message, /the report does not show C7 of the task contract tested, and no question about it was answered/);
      assert.equal(await countOf(w, taskId), 1, "an unsupported report is a go-on, as before");
      const d = await body(w, attemptId);
      assert.equal(d.interrogation?.state, "unsupported");
      // The two rounds asked, and the verdict's own instruction recorded as the closing round (as for any unsupported with questions).
      assert.equal(d.interrogation?.rounds.length, 3);
      assert.match(d.interrogation?.rounds[2]?.questions[0] ?? "", /^For each of C7, add a line to your report naming the clause/);

      // The second agent's own question comes first, and a clause it asks about is not asked again.
      const asker = new Always({ verdict: "questions", questions: ["Which test shows rule 2 holds for every offset?"] });
      const extra = await backend.open();
      opened.push(extra);
      const second = await world(extra.storage, CRITERIA.concat(["rule 2 holds for every offset"]), asker);
      const u: ReportVerdict[] = [];
      await turn(second.w, async (id) => { u.push(await second.w.dispatcher.interrogateDone(second.w.dispatcherPrincipal, id, { key: "k1", report: "Done.", verified: "passed" })); });
      const message = (u[0] as { message: string }).message;
      assert.match(message, /1\. "Which test shows rule 2 holds for every offset\?"\n2\. "C1 /);
      assert.match(message, /\n3\. "C2 /);
      assert.ok(!/"C3 /.test(message), "C3 is asked by the second agent's own question");
    } finally { for (const o of opened) await o.close(); await store.close(); }
  });
}
