import assert from "node:assert/strict";
import { test } from "node:test";
import { rig, sandbox } from "./w03-rig-support.js";

// Card W10, end to end: the composed controller with the real local worker (bubblewrap, the worker process running Pi), the real checkout layout, a scripted model for the agent and a scripted second agent on its own client.
// The agent keeps a running note through the bridge, tries to end without a report and is refused with its note, ends with a report and is questioned, answers through the bridge, and ends again: the second agent finds the
// report supported and the attempt succeeds with the report, the questions and the answers on it. The second agent is a separate client: it is never sent the agent's conversation, and the agent's model never sees its prompt.
test("an agent's note, a refused end without a report, the second agent's question and the agent's answer, all in one turn through the real worker; the supported report is recorded with the questions and answers (card W10)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const judged: { route: string; system: string; user: string }[] = [];
  const replies = [JSON.stringify({ verdict: "questions", questions: ["Which file holds the fix?"] }), JSON.stringify({ verdict: "supported" })];
  const judge = {
    complete: async (): Promise<string> => { throw new Error("the routed client asks for the detailed reply"); },
    completeDetailed: async (route: string, request: { system: string; user: string }) => { judged.push({ route, ...request }); return { text: replies[Math.min(judged.length - 1, replies.length - 1)]!, usage: { inputTokens: 30, outputTokens: 5 } }; },
  };
  const x = await rig(launcher, [
    { call: { name: "nimblenewt__work-note", args: { kind: "did", text: "fixed the parser's date branch" } } },
    { call: { name: "nimblenewt__work-end", args: { result: "done" } } },
    { call: { name: "nimblenewt__work-end", args: { result: "done", report: "Fixed the parser." } } },
    { call: { name: "nimblenewt__work-answer", args: { answers: ["src/a.ts"] } } },
    { call: { name: "nimblenewt__work-end", args: { result: "done", report: "Fixed the parser in src/a.ts." } } },
    { text: "Ended: the parser is fixed." },
  ], { start: { reportInterrogation: { model: judge, routes: ["judge/local"] } } });
  try {
    await x.run();
    const d = await x.get();
    assert.equal(d.state, "finished", JSON.stringify(d.outcome));
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    // One turn: the note, the refused end (with the note shown), the question, the answer, the end, and the reply after it.
    assert.equal(x.answer.seen.length, 6);
    assert.match(x.answer.seen[2]!, /refused \(invalid_command\): work\.end needs a report: every ending \(done, partial, blocked or abandoned\) carries a report/);
    assert.match(x.answer.seen[2]!, /- did: \\"fixed the parser's date branch\\"/, "the agent is shown its own note in the refusal");
    assert.match(x.answer.seen[3]!, /work\.end done was not accepted: before a done is recorded, a second agent questions your report/);
    assert.match(x.answer.seen[3]!, /1\. \\"Which file holds the fix\?\\"/);
    assert.match(x.answer.seen[4]!, /\\"round\\":1/, "the answer was taken");
    // The second agent: its own client and route, two questions in all, shown the contract's task, the report, the note and the answer; never the agent's conversation.
    assert.deepEqual(judged.map((j) => j.route), ["judge/local", "judge/local"]);
    assert.match(judged[0]!.user, /TASK title="Fix the parser"/);
    assert.match(judged[0]!.user, /REPORT "Fixed the parser\."/);
    assert.match(judged[0]!.user, /- did: "fixed the parser's date branch"/);
    assert.match(judged[1]!.user, /A1 "src\/a\.ts"/);
    for (const j of judged) assert.ok(!j.user.includes("nimblenewt__") && !j.user.includes("call_"), "no tool call or conversation of the agent reaches the second agent");
    for (const seen of x.answer.seen) assert.ok(!seen.includes("You question another agent"), "the agent's model never sees the second agent's prompt");
    const report = (d as unknown as { report?: { questioning: string; text: string; qa: { question: string; answer?: string }[] } }).report;
    assert.equal(report?.questioning, "supported");
    assert.equal(report?.text, "Fixed the parser in src/a.ts.");
    assert.deepEqual(report?.qa, [{ question: "Which file holds the fix?", answer: "src/a.ts" }]);
    assert.deepEqual((d as unknown as { notes?: { kind: string; text: string }[] }).notes?.map((n) => [n.kind, n.text]), [["did", "fixed the parser's date branch"]]);
  } finally { await x.close(); }
});
