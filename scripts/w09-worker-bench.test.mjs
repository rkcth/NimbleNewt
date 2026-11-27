// Card W09, offline: the bench through NimbleNewt's real worker and controller (scripts/pi-eval/lib/worker-embedder.mjs, worker-run.mjs), with a scripted Radiance-shaped endpoint behind the run's one fetch.
// The unit tests cover the run's fetch (only POST <base>/chat/completions, one request at a time), the task text (no {{COMPLETION_RULES}}, within the controller's bound for every task of the set), the outcome rules (fail
// closed: no verified finish without a verified done, a supported report and passing acceptance tests), the variants' bridge filter, the build check, the release-blocker record and Pi's context window.
// The end-to-end tests run the product composition (the launcher with scripts/local-host.mjs: bubblewrap, the worker process running Pi, the model relay, the done check, the second agent) on a tiny repository: a verified
// finish with the kind's budget fields at the provider; variant A without the continuation against C with it; and a second agent whose replies cannot be read, which never gives a finish. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1, where it fails instead. No network: the endpoint is a function.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTaskset } from "./pi-eval/lib/taskset.mjs";
import { radianceBase, radianceOnlyFetch, attemptSummary, dailySpendOf, MEASURE_LIMITS, msStats, openW09Installation, OUTAGE_STATUSES, scrubbed, toolTimeOf, usageOf } from "./pi-eval/lib/worker-embedder.mjs";
import { DESCRIPTION_MAX, SANDBOX_NODE, SHIPPED_VARIANT, WORKER_CAUSES, WORKER_VARIANTS, bridgeFilterFor, buildCheck, callLog, callsLines, causesLine, classifyWorkerRun, doneChecks, fileToolsLine, offersFileTools, outagesLines, releaseBlocker, renderWorkerPrompt, runWorkerOne, tokensOfCalls, withOutageCause, workerTitle } from "./pi-eval/lib/worker-run.mjs";
import { aggregate, gatesFor } from "./pi-eval/lib/stats.mjs";
import { piContextWindow } from "./pi-eval/worker-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..");
const BASE = "http://127.0.0.1:8002/v1";
const tmp = (label) => realpathSync(mkdtempSync(join(tmpdir(), `nn-w09-${label}-`)));
const ok200 = (text) => new Response(text, { status: 200, headers: { "content-type": "application/json" } });

// ---- the run's one fetch -------------------------------------------------------------------------------------------------------------------------------------

test("the run's fetch sends only POST <base>/chat/completions to the Radiance address; any other method, path, query or host is refused before it leaves", async () => {
  const sent = [];
  const f = radianceOnlyFetch({ baseUrl: `${BASE}/`, fetch: async (url, init) => { sent.push([String(url), init.method, init.redirect]); return ok200("{}"); } });
  assert.equal((await f(`${BASE}/chat/completions`, { method: "POST", body: "{}" })).status, 200);
  for (const [url, method] of [[`${BASE}/chat/completions`, "GET"], [`${BASE}/models`, "POST"], [`${BASE}/chat/completions?x=1`, "POST"], ["https://api.openai.com/v1/chat/completions", "POST"], ["http://127.0.0.1:8003/v1/chat/completions", "POST"], [`${BASE}/messages`, "POST"]]) {
    await assert.rejects(f(url, { method, body: "{}" }), /sends only POST http:\/\/127\.0\.0\.1:8002\/v1\/chat\/completions/, `${method} ${url}`);
  }
  assert.deepEqual(sent, [[`${BASE}/chat/completions`, "POST", "manual"]], "nothing refused reached the transport, and a redirect is never followed");
  assert.throws(() => radianceBase("http://u:p@127.0.0.1:8002/v1"), /credentials/);
  assert.throws(() => radianceBase("file:///etc/passwd"), /http or https/);
  // The standby route's address can never be the one the fetch lets through.
  await assert.rejects(openW09Installation({ root: repository, dataDir: "/nonexistent-w09", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextTokens: 65536, fetch: async () => ok200("{}") }), /must not be the standby route's address/);
});

test("the run's fetch sends one request at a time: the next waits until the previous reply was read to its end, cancelled, aborted or failed; each call is told with its tools", async () => {
  const order = [];
  let n = 0;
  const told = [];
  const f = radianceOnlyFetch({ baseUrl: BASE, onCall: (c) => told.push(c), fetch: async () => { const i = ++n; order.push(`start ${i}`); if (i === 4) throw new Error("down"); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`r${i}`)); setTimeout(() => { order.push(`end ${i}`); try { c.close(); } catch { /* cancelled */ } }, 30); } }), { status: 200 }); } });
  const body = JSON.stringify({ stream: true, tools: [{ type: "function", function: { name: "nimblenewt__work-end" } }] });
  const a = f(`${BASE}/chat/completions`, { method: "POST", body });
  const b = f(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(await (await a).text(), "r1");
  assert.equal(await (await b).text(), "r2");
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"], "the second request waited for the first reply's end");
  // A cancelled reply frees the next request.
  const c = await f(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  await c.body.cancel();
  await assert.rejects(f(`${BASE}/chat/completions`, { method: "POST", body: "{}" }), /down/);
  const ac = new AbortController();
  const e = f(`${BASE}/chat/completions`, { method: "POST", body: "{}", signal: ac.signal });
  ac.abort();
  await assert.rejects(e, /abort/i, "aborted while waiting its turn: nothing is sent");
  const ac2 = new AbortController();
  const e2 = await f(`${BASE}/chat/completions`, { method: "POST", body: "{}", signal: ac2.signal });
  ac2.abort();
  void e2;
  assert.equal((await (await f(`${BASE}/chat/completions`, { method: "POST", body: "{}" })).text()).length, 2, "after a cancel, a failure and an abort the next request still goes");
  assert.equal(told[0].streamed, true);
  assert.deepEqual(told[0].tools, ["nimblenewt__work-end"]);
  assert.equal(told[1].streamed, false);
});

test("a request aborted while it waits behind one in flight is refused at once, is never sent or counted as sent, and the request after it still waits for the one in flight", async () => {
  const order = [];
  const told = [];
  let n = 0;
  let finishFirst;
  const f = radianceOnlyFetch({ baseUrl: BASE, onCall: (c) => told.push(c), fetch: async () => { const i = ++n; order.push(`start ${i}`); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`r${i}`)); if (i === 1) finishFirst = () => { order.push("end 1"); c.close(); }; else c.close(); } }), { status: 200 }); } });
  const first = await f(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  const ac = new AbortController();
  const waiting = f(`${BASE}/chat/completions`, { method: "POST", body: "{}", signal: ac.signal });
  const third = f(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await assert.rejects(waiting, /abort/i, "refused while the first reply is still open");
  assert.deepEqual(order, ["start 1"], "nothing else was sent while the first is out");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["start 1"], "the third still waits for the first");
  const reading = first.text();
  finishFirst();
  assert.equal(await reading, "r1");
  assert.equal(await (await third).text(), "r2");
  assert.deepEqual(order, ["start 1", "end 1", "start 2"]);
  assert.deepEqual(told.map((c) => [c.sent, c.status]), [[false, "aborted"], [true, 200], [true, 200]]);
});

// ---- the task text ---------------------------------------------------------------------------------------------------------------------------------------------

test("every task of the set fits the controller's task description in every worker variant, names the sandbox's checkout and Node.js, and never carries the completion rules (the worker sends them as the system prompt)", async () => {
  const set = loadTaskset(join(here, "pi-eval", "taskset.json"));
  for (const [v, spec] of Object.entries(WORKER_VARIANTS)) {
    const template = readFileSync(spec.prompt, "utf8");
    for (const task of set.tasks) {
      const text = renderWorkerPrompt(template, { task, taskText: readFileSync(task.promptPath, "utf8") });
      assert.ok(text.length <= DESCRIPTION_MAX, `${v} ${task.id}: ${text.length}`);
      assert.ok(!text.includes("{{") && !text.includes("COMPLETION_RULES"), `${v} ${task.id}`);
      assert.ok(text.includes("file:///work/scripts/offline-guard.mjs") && text.includes(SANDBOX_NODE), `${v} ${task.id}`);
      assert.ok(workerTitle(task).length <= 200);
    }
    if (v !== "A") assert.match(template, /nimblenewt__work-end/);
  }
  assert.throws(() => renderWorkerPrompt("{{TASK}}\n\n{{COMPLETION_RULES}}", { task: { id: "x" }, taskText: "t" }), /must not carry \{\{COMPLETION_RULES\}\}/);
  assert.throws(() => renderWorkerPrompt("{{TASK}}", { task: { id: "x" }, taskText: "y".repeat(DESCRIPTION_MAX + 1) }), /over the controller's 8000-character task description/);
});

test("the done's check is the task's own build with the sandbox's Node.js; a task without a build has no check", () => {
  assert.deepEqual(buildCheck({ setup: { argv: ["node", "node_modules/typescript/bin/tsc", "--build", "--force"] } }), [{ name: "the build", run: [SANDBOX_NODE, "node_modules/typescript/bin/tsc", "--build", "--force"], timeoutSeconds: 1800 }]);
  assert.deepEqual(buildCheck({ setup: null }), []);
});

test("variants A and B refuse only turn.continue at the host's bridge; C and D leave the bridge alone; D is the shipped variant and C's configuration", () => {
  for (const v of ["A", "B"]) {
    const f = bridgeFilterFor(WORKER_VARIANTS[v]);
    assert.equal(f({}, { op: "turn.continue", callId: "c" })?.ok, false);
    for (const op of ["work.end", "work.note", "work.answer", "task.get"]) assert.equal(f({}, { op, callId: "c" }), undefined, `${v} ${op}`);
  }
  for (const v of ["C", "D"]) assert.equal(bridgeFilterFor(WORKER_VARIANTS[v]), undefined);
  assert.equal(SHIPPED_VARIANT, "D");
  assert.equal(WORKER_VARIANTS.D.sameAs, "C");
});

// ---- the outcome rules -----------------------------------------------------------------------------------------------------------------------------------------

const att = (x = {}) => ({ state: "finished", status: "succeeded", summary: "", reportResult: "done", questioning: "supported", questions: 0, verifications: ["passed"], lastChecks: [], nudges: 0, stoppedEarly: 0, readmitted: 0, endKind: "normal", notes: 0, ...x });
const pass = { passed: true, built: true, interfaceMismatch: false };
const fail = { passed: false, built: true, interfaceMismatch: false };

test("a verified finish needs a verified done, a supported report and passing acceptance tests on a changed checkout; anything less never counts (fail closed)", () => {
  const o = (attempt, hidden = pass, changed = true, timedOut = false) => classifyWorkerRun({ attempt, hidden, changed, timedOut }).outcome;
  assert.equal(o(att()), "verified-finish");
  for (const q of ["not-run", "unsupported", "not-asked", null]) assert.equal(o(att({ questioning: q })), "unclassified", `questioning ${q}`);
  for (const v of [["failed"], ["unknown"], []]) assert.equal(o(att({ verifications: v })), "unclassified", `verifications ${v}`);
  assert.equal(o(att(), fail), "wrong", "a recorded done whose work fails is a false done");
  assert.equal(o(att({ questioning: "not-run" }), fail), "wrong", "also without a questioning");
  assert.equal(o(att(), { ...fail, interfaceMismatch: true }), "interface-mismatch");
  assert.equal(o(att(), pass, false), "error", "tests passing on an unchanged checkout is a broken task");
  assert.equal(o(att(), pass, true, true), "timeout");
  assert.equal(o(null), "error");
  assert.equal(o(att({ state: "running" })), "error");
  // Honest non-finishes are named, never a finish, never a false done.
  assert.equal(o(att({ status: "stopped-early", reportResult: null, readmitted: 2 }), pass), "stopped-early", "passing work without a done is not a finish");
  assert.equal(o(att({ status: "succeeded", reportResult: "partial" })), "stopped-early");
  assert.equal(o(att({ status: "failed", reportResult: "blocked" })), "stopped-early");
  assert.equal(o(att({ status: "failed", reportResult: "done", questioning: "unsupported" }), pass), "stopped-early", "a done refused until the go-ons ran out");
  assert.equal(o(att({ status: "stopped-early", reportResult: null, endKind: "length" }), fail), "length");
  assert.equal(o(att({ status: "stopped-early", reportResult: null, endKind: "empty-visible-text" }), fail), "empty");
  assert.equal(o(att({ status: "failed", reportResult: null })), "error");
});

test("W09 fixes: every run ends with a named cause; an unclassified run says why the second agent did not run, a reply cut says how far its limit was raised; the outcomes (and so the gates) are unchanged", () => {
  const c = (attempt, hidden = pass, changed = true, timedOut = false) => classifyWorkerRun({ attempt, hidden, changed, timedOut });
  const cases = [
    [c(att()), "verified-finish", "verified"],
    [c(att(), pass, true, true), "timeout", "wall-limit"],
    [c(null), "error", "no-attempt"],
    [c(att({ state: "running" })), "error", "not-finished"],
    [c(att(), fail), "wrong", "false-done"],
    [c(att(), { ...fail, interfaceMismatch: true }), "interface-mismatch", "interface-mismatch"],
    [c(att(), pass, false), "error", "uncalibrated"],
    [c(att({ verifications: ["failed"] })), "unclassified", "check-not-passed"],
    [c(att({ questioning: "not-run", questioningCause: "reply-cut", questioningWhy: "the second agent could not be asked: ... (reply-cut: the reply was cut at the 32768-token reply limit ...)" })), "unclassified", "second-agent-reply-cut"],
    [c(att({ questioning: "not-run", questioningCause: null })), "unclassified", "second-agent-not-run"],
    [c(att({ questioning: null })), "unclassified", "second-agent-none"],
    [c(att({ status: "stopped-early", reportResult: null, endKind: "length" }), fail), "length", "reply-cut-not-raised"],
    [c(att({ status: "stopped-early", reportResult: null, endKind: "length", replyCut: { cuts: 3, limit: 16384, ceiling: 25000 } }), fail), "length", "reply-cut-below-ceiling"],
    [c(att({ status: "stopped-early", reportResult: null, endKind: "length", replyCut: { cuts: 5, limit: 25000, ceiling: 25000 } }), fail), "length", "reply-cut-at-ceiling"],
    [c(att({ status: "stopped-early", reportResult: null, endKind: "empty-visible-text" }), fail), "empty", "empty-reply"],
    [c(att({ status: "stopped-early", reportResult: null, readmitted: 2 })), "stopped-early", "early-stops-used-up"],
    [c(att({ status: "succeeded", reportResult: "partial" })), "stopped-early", "ended-partial"],
    [c(att({ status: "failed", reportResult: "blocked" })), "stopped-early", "ended-blocked"],
    [c(att({ status: "failed", reportResult: "abandoned" })), "stopped-early", "ended-abandoned"],
    [c(att({ status: "failed", reportResult: "done", questioning: "unsupported" })), "stopped-early", "done-refused"],
    [c(att({ status: "failed", reportResult: null })), "error", "ended-otherwise"],
  ];
  for (const [r, outcome, cause] of cases) {
    assert.deepEqual([r.outcome, r.cause], [outcome, cause], r.reason);
    assert.ok(WORKER_CAUSES.includes(cause) || cause.startsWith("second-agent-"), cause);
  }
  const notRun = c(att({ questioning: "not-run", questioningCause: "timeout", questioningWhy: "the second agent could not be asked: (timeout: route r/m did not answer within 540000 ms)" }));
  assert.match(notRun.reason, /questioning not-run, cause timeout; why: the second agent could not be asked: \(timeout: route r\/m did not answer within 540000 ms\)/);
  assert.match(c(att({ status: "stopped-early", reportResult: null, endKind: "length", replyCut: { cuts: 3, limit: 16384, ceiling: 25000 } }), fail).reason, /3 reply\(ies\) cut with no visible text; the reply limit was 16384 tokens of a ceiling of 25000/);
  assert.equal(causesLine([{ cause: "verified" }, { cause: "false-done" }, { cause: "verified" }, {}]), "causes: verified 2, false-done 1");
  assert.equal(causesLine([{}]), null);
  // Second review: the second agent's part of a cause is a plain lower-case name, bounded, whatever the record holds.
  for (const odd of ["Reply Cut/../x", "a".repeat(200), "x\ny"]) {
    const r = c(att({ questioning: "not-run", questioningCause: odd }));
    assert.match(r.cause, /^second-agent-[a-z0-9-]{1,40}$/, r.cause);
    assert.equal(r.outcome, "unclassified");
  }
});

test("W09 fixes: the done's check runs the task's declared package tests after the build; the task set refuses a declared test that names a held-out or acceptance test, a pattern, or a path outside", () => {
  const task = { setup: { argv: ["node", "node_modules/typescript/bin/tsc", "--build"] }, doneTests: ["packages/controller/dist/chat/model-interpreter.test.js"] };
  assert.deepEqual(doneChecks(task), [...buildCheck(task), { name: "the task's package tests", run: [SANDBOX_NODE, "--test", "packages/controller/dist/chat/model-interpreter.test.js"], timeoutSeconds: 1800 }]);
  assert.deepEqual(doneChecks({ setup: task.setup }), buildCheck(task), "no declared tests: the build only");
  // The task set as shipped declares them for every task since card W09's second slice (scripts/pi-eval/done-tests-at-base.mjs shows each passing at the task's base and solution), and loads.
  const set = loadTaskset(join(here, "pi-eval", "taskset.json"));
  assert.ok(set.tasks.every((t) => Array.isArray(t.doneTests) && t.doneTests.length > 0));
  const dir = tmp("doneTests");
  try {
    const raw = JSON.parse(readFileSync(join(here, "pi-eval", "taskset.json"), "utf8"));
    const ql = raw.tasks.find((t) => t.id === "quote-lines");
    for (const sub of ["tasks", "acceptance"]) cpSync(join(here, "pi-eval", sub), join(dir, sub), { recursive: true });
    const write = (doneTests) => { const f = join(dir, "taskset.json"); writeFileSync(f, JSON.stringify({ ...raw, tasks: [{ ...ql, doneTests }] })); return f; };
    assert.equal(loadTaskset(write(["packages/controller/dist/chat/model-interpreter.test.js"])).tasks[0].doneTests.length, 1);
    for (const bad of [
      ["packages/controller/dist/chat/commands-preview.test.js"], // a held-out test, built
      ["packages/controller/src/chat/chat.test.ts"], // a held-out test, source
      ["packages/controller/dist/chat/w01-acceptance-quote-lines.test.js"], // the bench's acceptance test
      ["packages/controller/dist/chat/*.test.js"], ["../outside.test.js"], ["/abs/x.test.js"], [""], [3], "x",
      Array.from({ length: 51 }, (_, i) => `packages/controller/dist/chat/model-interpreter-${i}.test.js`), // more than 50 (second review)
    ]) assert.throws(() => loadTaskset(write(bad)), /doneTests/, JSON.stringify(bad));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offered tools: the other bridge tools are no file tools; Pi's own, the catalogue's and the bridge's checkout tool (card W09b) are", () => {
  assert.equal(offersFileTools(["nimblenewt__work-end", "nimblenewt__work-note", "nimblenewt__tool-invoke"]), false);
  for (const t of ["read", "bash", "edit", "a_x__write-file", "shell", "nimblenewt__work-checkout"]) assert.equal(offersFileTools(["nimblenewt__work-end", t]), true, t);
  assert.match(fileToolsLine([{ worker: { agentTools: ["nimblenewt__work-end"], fileTools: false } }]), /offered no tool that reads or changes files/);
  assert.equal(fileToolsLine([{ worker: { agentTools: ["bash"], fileTools: true } }]), null);
});

// ---- the release blocker ---------------------------------------------------------------------------------------------------------------------------------------

test("a shipped variant whose W01 gates do not hold writes a release blocker with its results attached; gates that hold write none", async () => {
  const dir = tmp("blocker");
  try {
    const rec = (i, size, outcome, variant = "D") => ({ runId: `r${size}${i}${variant}`, taskId: `t-${size}`, size, variant, outcome, reason: "x", wallMs: 1, artifacts: `/a/${i}`, worker: { attemptId: `att-${i}`, questioning: "supported", verifications: ["passed"] } });
    const failing = [rec(1, "S", "verified-finish"), rec(2, "S", "wrong")];
    // A run of another variant in the same batch is neither counted nor attached.
    const b = await releaseBlocker({ records: [...failing, rec(3, "S", "wrong", "C")], resultsDir: dir, batchId: "w09-batch-x", benchCommit: "abc", route: { provider: "radiance", model: "m", kind: "radiance" }, now: () => "2026-11-26T00:00:00Z" });
    assert.equal(b.pass, false);
    const j = JSON.parse(readFileSync(b.json, "utf8"));
    assert.equal(j.kind, "release-blocker");
    assert.equal(j.card, "W09");
    assert.equal(j.benchCommit, "abc");
    assert.deepEqual(j.route, { provider: "radiance", model: "m", kind: "radiance" });
    assert.deepEqual(j.results.map((x) => x.runId), ["rS1D", "rS2D"], "the results are attached");
    assert.ok(j.failures.some((f) => /S: verified finish 50\.0% < 90\.0%/.test(f)) && j.failures.some((f) => /M: not measured/.test(f)) && j.failures.some((f) => /false done 50\.0%/.test(f)), j.failures.join("; "));
    assert.match(readFileSync(b.md, "utf8"), /^# Release blocker \(card W09\)/);
    // Another variant's runs do not count for the shipped one.
    const others = [...failing.map((r) => ({ ...r, variant: "A" }))];
    assert.equal((await releaseBlocker({ records: others, resultsDir: dir, batchId: "w09-batch-y", benchCommit: "abc", route: {} })).pass, false, "none of D: not measured");
    const good = [];
    for (const [size, n] of [["S", 10], ["M", 7], ["L", 4]]) for (let i = 0; i < n; i++) good.push(rec(i, size, "verified-finish"));
    for (let i = 0; i < 20; i++) good.push(rec(100 + i, "S", "verified-finish"));
    const ok = await releaseBlocker({ records: good, resultsDir: dir, batchId: "w09-batch-z", benchCommit: "abc", route: {} });
    assert.equal(ok.pass, true);
    assert.ok(!existsSync(join(dir, "release-blockers", "w09-w09-batch-z.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the route's context window is read from Pi's own configuration without reading the key, and is absent when not stated", () => {
  const home = tmp("home");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { radiance: { apiKey: "sk-not-read", models: [{ id: "m1", contextWindow: 131072 }, { id: "m2" }] } } }));
    assert.equal(piContextWindow("m1", home), 131072);
    assert.equal(piContextWindow("m2", home), undefined);
    assert.equal(piContextWindow("m1", join(home, "none")), undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- end to end through the real worker ---------------------------------------------------------------------------------------------------------------------

const required = process.env.NIMBLENEWT_REQUIRE_SANDBOX === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const sh = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const sse = (delta, finish, usage) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "qwen-test", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const stream = (chunks) => new Response(`${sse({ role: "assistant", content: "" }, null)}${chunks}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const textReply = (t) => stream(`${sse({ content: t }, null)}${sse({}, "stop", usage)}`);
const callReply = (name, args) => stream(`${sse({ tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null)}${sse({}, "tool_calls", usage)}`);
const judged = (content) => ok200(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 30, completion_tokens: 5 } }));

async function sandboxUsable() {
  const { SandboxLauncher } = await import(pathToFileURL(join(repository, "packages", "worker", "dist", "index.js")).href);
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  return { usable, why };
}

/** A tiny repository (base, and a solution commit with the shipped test), the bench's acceptance test, installed dependencies (ignored), and the task as loadTaskset makes it. */
function fixture(parent, { prompt = "Add src/b.mjs exporting the constant b = 2.\n" } = {}) {
  const repo = join(parent, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "src", "a.mjs"), "export const a = 1;\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "base");
  const base = sh(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "w01-hidden.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { b } from "./src/b.mjs"; test("shipped", () => assert.equal(b, 2));\n');
  writeFileSync(join(repo, "src", "b.mjs"), "export const b = 2;\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "solution");
  const solution = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", base);
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const acc = join(parent, "acc");
  mkdirSync(acc);
  writeFileSync(join(acc, "b.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { b } from "./src/b.mjs"; test("b is two", () => assert.equal(b, 2));\n');
  writeFileSync(join(parent, "tiny.md"), prompt);
  const task = {
    id: "tiny", title: "Add b", size: "S", base, solution, promptPath: join(parent, "tiny.md"), hiddenFiles: ["w01-hidden.test.mjs"], testFiles: ["w01-hidden.test.mjs"],
    acceptance: { files: [{ dest: "w01-acceptance-b.test.mjs", src: join(acc, "b.test.mjs") }], support: [], testFiles: ["w01-acceptance-b.test.mjs"], testNamePatterns: [] },
    timeoutMinutes: 4, copy: ["node_modules"], setup: { argv: ["node", "-e", "require('node:fs').accessSync('src/b.mjs')"] }, test: { cwd: ".", argv: ["node", "--test", "{{TEST_FILES}}"], env: {} },
  };
  return { repo, task };
}

/** The agent's checkout, wherever the run's installation put it. */
function findCheckout(workRoot) {
  for (const d of readdirSync(workRoot)) {
    const work = join(workRoot, d, "data.host", "work");
    if (!existsSync(work)) continue;
    for (const p of readdirSync(work)) for (const t of readdirSync(join(work, p))) { const c = join(work, p, t, "checkout"); if (existsSync(c)) return c; }
  }
  return undefined;
}

/**
 * The scripted Radiance server: `agent(i, body, checkout)` answers the i-th streamed (agent) call, `second(j, body)` the j-th non-streamed (second agent) call. Records every body.
 */
function radianceScript({ workRoot, agent, second }) {
  const bodies = { agent: [], second: [] };
  const fetch = async (url, init) => {
    assert.equal(String(url), `${BASE}/chat/completions`);
    const body = JSON.parse(String(init.body));
    if (body.stream === true) { bodies.agent.push(body); return agent(bodies.agent.length, body, findCheckout(workRoot)); }
    bodies.second.push(body);
    return second(bodies.second.length, body);
  };
  return { fetch, bodies };
}

async function runOne({ variant, agent, second, maxTokens = 4096, reasoningTokens = 1024, budget = true, prompt }) {
  const parent = tmp(`e2e-${variant}`);
  const { repo, task } = fixture(parent, prompt === undefined ? {} : { prompt });
  const workRoot = join(parent, "work");
  const resultsDir = join(parent, "results");
  mkdirSync(workRoot); mkdirSync(resultsDir);
  const script = radianceScript({ workRoot, agent, second });
  const ctx = {
    set: { agent: { provider: "radiance", model: "qwen-test" } }, repo, depsFrom: repo, workRoot, resultsDir, root: repository, batchId: `w09-test-${variant}`, benchCommit: "test-commit", keep: false, pollMs: 200,
    radiance: { baseUrl: BASE, model: "qwen-test", contextTokens: 65_536, ...(budget ? { maxTokens, reasoningTokens } : {}) }, fetch: script.fetch,
    start: { facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }) },
  };
  try {
    const record = await runWorkerOne(ctx, task, variant, 1);
    return { record, bodies: script.bodies, parent, resultsDir, cleanup: () => { try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* none */ } rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } catch (error) { rmSync(parent, { recursive: true, force: true }); throw error; }
}

/** The agent's work as its write tool would make it, then its done with a report. */
const doTheWork = (checkout) => { writeFileSync(join(checkout, "src", "b.mjs"), "export const b = 2;\n"); return callReply("nimblenewt__work-end", { result: "done", report: "Added src/b.mjs exporting b = 2; the build passes." }); };
const systemOf = (body) => body.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const allText = (body) => JSON.stringify(body.messages);

test("end to end on the real worker (variant D): admission, a verified work.end, a report the second agent found supported, the acceptance tests passing, the Radiance kind's budget fields at the provider, and a release blocker for the sizes not measured (card W09)", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  let depsSeen = false;
  const run = await runOne({
    variant: "D",
    agent: (i, _body, checkout) => { if (i === 1) { depsSeen = existsSync(join(checkout, "node_modules", "dep", "index.js")); return doTheWork(checkout); } return textReply("Ended: src/b.mjs is added."); },
    second: () => judged(JSON.stringify({ verdict: "supported" })),
  });
  try {
    const r = run.record;
    t.diagnostic(`${r.outcome}: ${r.reason} ${JSON.stringify(r.worker)}`);
    assert.equal(r.outcome, "verified-finish", `${r.reason} ${JSON.stringify(r.worker)}`);
    assert.equal(depsSeen, true, "the installed dependencies were in the checkout before the agent's first call");
    assert.equal(r.worker.status, "succeeded");
    assert.equal(r.worker.reportResult, "done");
    assert.equal(r.worker.questioning, "supported");
    assert.deepEqual(r.worker.verifications, ["passed"]);
    assert.deepEqual(r.worker.lastChecks, [{ name: "the build", state: "passed" }]);
    assert.equal(r.hidden.passed, true);
    assert.equal(r.shipped.passed, true);
    assert.equal(r.changed, true);
    // The record: commit, route, model, size, variant, the worker's fixed parts.
    assert.equal(r.card, "W09");
    assert.equal(r.benchCommit, "test-commit");
    assert.deepEqual([r.route.provider, r.route.model, r.route.kind, r.route.via], ["radiance", "qwen-test", "radiance", "controller model relay"]);
    assert.deepEqual([r.size, r.variant, r.workerVariant.nudges, r.workerVariant.readmits], ["S", "D", true, true]);
    assert.ok(r.worker.requests.agent >= 2 && r.worker.requests.second === 1, JSON.stringify(r.worker.requests));
    // W09 bench measurement: each call's time and the provider's own counts per role (the scripted replies state 10 in and 3 out for the agent's, 30 and 5 for the second agent's), and the day's spend record under the
    // daily cap, read before the installation was closed and removed: the second agent's one call.
    const na = r.worker.requests.agent;
    assert.deepEqual([r.calls.agent.sent, r.calls.second.sent, r.calls.agent.ms.length], [na, 1, na]);
    assert.ok(Number.isFinite(r.calls.agent.medianMs) && r.calls.agent.p95Ms >= r.calls.agent.medianMs && Number.isFinite(r.calls.second.medianMs), JSON.stringify(r.calls));
    assert.deepEqual(r.calls.agent.tokens, { input: 10 * na, output: 3 * na, cacheRead: 0, reasoning: 0 });
    assert.deepEqual(r.calls.second.tokens, { input: 30, output: 5, cacheRead: 0, reasoning: 0 });
    assert.deepEqual(r.tokens, { input: 10 * na + 30, output: 3 * na + 5, cacheRead: 0, reasoning: 0 });
    assert.equal(r.tokensUnknown, undefined);
    assert.deepEqual([r.dailySpend.tokens, r.dailySpend.calls, r.dailySpend.maxTokensPerDay], [35, 1, null], JSON.stringify(r.dailySpend));
    assert.match(r.dailySpend.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual([r.calls.agent.outages, r.calls.second.outages, r.calls.lastCall.outage], [0, 0, false]);
    assert.deepEqual(r.worker.toolTime, {}, "no tool call of the attempt");
    // The relay named the Radiance kind's fields: the provider got the route's reply limit and reasoning cap.
    for (const b of run.bodies.agent) { assert.equal(b.max_tokens, 4096); assert.equal(b.thinking_token_budget, 1024); assert.equal(b.model, "qwen-test"); }
    // The completion rules are the system prompt, once; the task text does not carry them again.
    const { COMPLETION_RULES } = await import(pathToFileURL(join(repository, "packages", "pi-adapter", "dist", "prompt-layout.js")).href);
    const first = run.bodies.agent[0];
    assert.equal(systemOf(first).split(COMPLETION_RULES.slice(0, 200)).length - 1, 1, "the rules are in the system prompt once");
    assert.equal(allText(first).split(JSON.stringify(COMPLETION_RULES.slice(0, 200)).slice(1, -1)).length - 1, 1, "and nowhere else in the request");
    assert.ok(allText(first).includes("Add src/b.mjs exporting the constant b = 2.") && !allText(first).includes("{{"), "the task text reached the agent");
    // The second agent: its own, non-streamed call on the same route, never the agent's conversation.
    assert.equal(run.bodies.second[0].model, "qwen-test");
    // No tool call of the agent reaches the second agent. Since the W09 fixes it is shown the task's description, which is the worker's task text and so names the bridge's tools; outside that quotation nothing does.
    const user = run.bodies.second[0].messages.find((m) => m.role === "user").content;
    assert.ok(!allText(run.bodies.second[0]).includes("tool_calls") && !allText(run.bodies.second[0]).includes("call_"), "no tool call of the agent reaches the second agent");
    assert.ok(!user.replace(/Task description \(what the agent was asked to do\): "(?:[^"\\]|\\.)*"/, "").includes("nimblenewt__"), "tool names appear only in the quoted task description");
    // What the agent could call: the bridge's tools, the checkout tool among them (card W09b), and nothing else; the record says so truthfully.
    assert.equal(r.worker.fileTools, true, JSON.stringify(r.worker.agentTools));
    assert.ok(r.worker.agentTools.includes("nimblenewt__work-checkout") && r.worker.agentTools.every((n) => n.startsWith("nimblenewt__")), JSON.stringify(r.worker.agentTools));
    assert.ok(existsSync(join(r.artifacts, "prompt.md")) && existsSync(join(r.artifacts, "hidden-tests.log")));
    // One size measured is not the gate: the release blocker is written with this run attached.
    const b = await releaseBlocker({ records: [r], resultsDir: run.resultsDir, batchId: r.batchId, benchCommit: r.benchCommit, route: r.route });
    assert.equal(b.pass, false);
    const j = JSON.parse(readFileSync(b.json, "utf8"));
    assert.deepEqual(j.results.map((x) => [x.runId, x.outcome, x.questioning]), [[r.runId, "verified-finish", "supported"]]);
    assert.deepEqual(j.failures, ["M: not measured", "L: not measured"]);
    assert.equal(j.fileTools, undefined, "the blocker no longer says the agent had no file tool");
  } finally { run.cleanup(); }
});

test("variant A runs without the continuation (turn.continue refused at the host: no nudge, W03's readmit goes on) while C nudges the same yielded turn (card W09)", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const { CONTINUATION_MARK } = await import(pathToFileURL(join(repository, "packages", "pi-adapter", "dist", "continuation.js")).href);
  const script = { agent: (i, _b, checkout) => (i === 1 ? textReply("I will look at the source next.") : i === 2 ? doTheWork(checkout) : textReply("Ended.")), second: () => judged(JSON.stringify({ verdict: "supported" })) };
  const a = await runOne({ variant: "A", ...script });
  try {
    assert.equal(a.record.outcome, "verified-finish", `${a.record.reason} ${JSON.stringify(a.record.worker)}`);
    assert.equal(a.record.nudges, 0);
    assert.equal(a.record.workerVariant.nudges, false);
    assert.ok(a.record.worker.readmitted >= 1, `W03 readmitted the stopped turn: ${JSON.stringify(a.record.worker)}`);
    assert.ok(a.bodies.agent.every((b) => !allText(b).includes(CONTINUATION_MARK)), "no nudge reached the model");
  } finally { a.cleanup(); }
  const c = await runOne({ variant: "C", ...script });
  try {
    assert.equal(c.record.outcome, "verified-finish", `${c.record.reason} ${JSON.stringify(c.record.worker)}`);
    assert.equal(c.record.nudges, 1);
    assert.equal(c.record.worker.readmitted, 0);
    assert.ok(allText(c.bodies.agent[1]).includes(CONTINUATION_MARK), "the nudge was the model's next input");
  } finally { c.cleanup(); }
});

test("a second agent whose replies cannot be read never lets a done through: the work passes its tests but the run is not a verified finish (fail closed, card W09)", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const run = await runOne({
    variant: "D",
    agent: (i, _b, checkout) => (i === 1 ? doTheWork(checkout) : callReply("nimblenewt__work-end", { result: "done", report: `Added src/b.mjs exporting b = 2 (try ${i}).` })),
    second: () => judged("I think it is probably fine, but I am not sure."),
  });
  try {
    const r = run.record;
    t.diagnostic(`${r.outcome}: ${r.reason} ${JSON.stringify(r.worker)}`);
    assert.notEqual(r.outcome, "verified-finish", JSON.stringify(r.worker));
    assert.equal(r.hidden?.passed, true, "the work itself passes its tests");
    assert.notEqual(r.worker?.questioning, "supported");
    // The controller refused the done each time and, its go-ons used up, ended the attempt blocked (report_unsupported): an honest non-finish, never a false done.
    assert.deepEqual([r.outcome, r.worker.reportResult, r.worker.questioning], ["stopped-early", "blocked", "unsupported"]);
    assert.match(r.worker.summary, /report_unsupported/);
    assert.ok(r.worker.requests.second >= 1);
    assert.equal(classifyWorkerRun({ attempt: { ...r.worker, state: r.worker.state }, hidden: r.hidden, changed: true }).outcome, r.outcome);
  } finally { run.cleanup(); }
});

// ---- W09 fixes: the second agent's limits, a cut worker reply, the description the second agent sees, and a questioning that did not run -------------------

/** A reply the server cut at its reply limit with only reasoning in it (no visible text). */
const cutStream = () => stream(`${sse({ reasoning_content: "Let me think about whether b should be a number or a string, and about the build..." }, null)}${sse({}, "length", usage)}`);
/** The second agent's reply cut before any text. */
const judgedCut = () => ok200(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "thinking..." }, finish_reason: "length" }], usage: { prompt_tokens: 30, completion_tokens: 8192 } }));
const EDGE = "Edge case named by the task: b must be the number 2, not the string \"2\".";

test("W09 fixes, end to end on the real worker: a worker reply cut with no visible text is retried at a larger limit; the second agent's cut reply is asked again at the reasoning kind's ceiling; the second agent sees the task's description with its edge case and no held-out test; the run is a verified finish with its cause", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const run = await runOne({
    variant: "D", budget: false, prompt: `Add src/b.mjs exporting the constant b = 2.\n\n${EDGE}\n`,
    agent: (i, _b, checkout) => (i === 1 ? cutStream() : i === 2 ? doTheWork(checkout) : textReply("Ended: src/b.mjs is added.")),
    second: (j) => (j === 1 ? judgedCut() : judged(JSON.stringify({ verdict: "supported" }))),
  });
  try {
    const r = run.record;
    t.diagnostic(`${r.outcome}: ${r.reason} ${JSON.stringify(r.worker)}`);
    assert.deepEqual([r.outcome, r.cause], ["verified-finish", "verified"], `${r.reason} ${JSON.stringify(r.worker)}`);
    // Item 3: no route budget, so the worker's limit is the product default; the cut reply raised the next call's limit to the host's ceiling (an eighth of the 65,536 window), and the record says so.
    const limits = run.bodies.agent.map((b) => b.max_completion_tokens ?? b.max_tokens);
    assert.deepEqual(limits.slice(0, 2), [4096, 8192], JSON.stringify(limits));
    assert.ok(limits.slice(1).every((l) => l === 8192), JSON.stringify(limits));
    assert.deepEqual(r.worker.replyCut, { cuts: 1, limit: 8192, ceiling: 8192 });
    // Item 2: the second agent's first reply was cut before any text at the reasoning kind's default; it was asked once more at the ceiling, and that verdict was taken.
    assert.deepEqual(run.bodies.second.map((b) => b.max_tokens), [8192, 32_768]);
    assert.equal(r.worker.questioning, "supported");
    assert.equal(r.worker.requests.second, 2);
    // Item 4: the second agent was shown the task's description, with the edge case it names, and nothing of the held-out or acceptance tests.
    const asked = JSON.stringify(run.bodies.second[0].messages);
    assert.ok(asked.includes("Task description (what the agent was asked to do)"), asked.slice(0, 400));
    assert.ok(asked.includes("Edge case named by the task: b must be the number 2"), "the edge case reached the second agent");
    for (const heldOut of ["w01-hidden", "w01-acceptance", "b is two", "shipped", "assert.equal(b, 2)"]) assert.ok(!asked.includes(heldOut), `the second agent never sees ${heldOut}`);
    assert.match(run.bodies.second[0].messages[0].content, /every edge case the task description or the contract names/);
  } finally { run.cleanup(); }
});

test("W09 fixes, end to end on the real worker: a second agent whose every reply is cut before any text does not run; its reason and cause are in the run record and the run is unclassified with the cause named (fail closed)", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const run = await runOne({ variant: "D", maxTokens: 16_384, reasoningTokens: 4096, agent: (i, _b, checkout) => (i === 1 ? doTheWork(checkout) : textReply("Ended.")), second: () => judgedCut() });
  try {
    const r = run.record;
    t.diagnostic(`${r.outcome}: ${r.reason} ${JSON.stringify(r.worker)}`);
    assert.equal(r.hidden?.passed, true, "the work itself passes its tests");
    assert.deepEqual([r.outcome, r.cause, r.worker.questioning, r.worker.questioningCause], ["unclassified", "second-agent-reply-cut", "not-run", "reply-cut"], `${r.reason} ${JSON.stringify(r.worker)}`);
    assert.match(r.worker.questioningWhy, /^the second agent could not be asked: no route answered the second agent's questions \(reply-cut: the reply was cut at the 16384-token reply limit before it held any text \(the route's ceiling\)\)/);
    assert.match(r.reason, /cause reply-cut; why: the second agent could not be asked/);
    // The route's declared budget is the second agent's: its reply limit (also the ceiling, so it was asked once) and its reasoning cap in the Radiance kind's field.
    assert.deepEqual(run.bodies.second.map((b) => [b.max_tokens, b.thinking_token_budget]), [[16_384, 4096]]);
    // The release blocker carries the cause and the reason.
    const b = await releaseBlocker({ records: [r], resultsDir: run.resultsDir, batchId: r.batchId, benchCommit: r.benchCommit, route: r.route });
    const j = JSON.parse(readFileSync(b.json, "utf8"));
    assert.deepEqual([j.results[0].cause, j.results[0].questioningCause], ["second-agent-reply-cut", "reply-cut"]);
    assert.match(j.results[0].questioningWhy, /reply-cut/);
    assert.match(readFileSync(b.md, "utf8"), /causes: second-agent-reply-cut 1/);
  } finally { run.cleanup(); }
});

// ---- card W09b: the agent's own file and command tool, through the real worker --------------------------------------------------------------------------------

/** Several tool calls in one reply (Pi runs them at once). */
const callsReply = (calls) => stream(`${sse({ tool_calls: calls.map(([name, args], index) => ({ index, id: `call_${index}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }, null)}${sse({}, "tool_calls", usage)}`);
/** The answers of the tool calls the model is shown in this request (the newest last). */
const toolAnswers = (body) => body.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
const CO = "nimblenewt__work-checkout";

test("card W09b: the agent reads, writes, edits, builds and tests in its own checkout with the checkout tool, through the real worker and its sandbox, and reaches a verified finish; a path outside the checkout is refused", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const seen = [];
  const steps = [
    [CO, { action: "read", path: "src/a.mjs" }],
    [CO, { action: "write", path: "src/b.mjs", text: "export const b = 1;\n" }],
    [CO, { action: "edit", path: "src/b.mjs", old: "b = 1", text: "b = 2" }],
    [CO, { action: "run", command: "node -e \"require('node:fs').accessSync('src/b.mjs')\" && node --input-type=module -e \"import { b } from './src/b.mjs'; if (b !== 2) process.exit(1); console.log('b is', b)\"" }],
    [CO, { action: "read", path: "../../../data" }],
    [CO, { action: "run", command: "node -e \"process.getBuiltinModule('net').connect(443,'192.0.2.1').on('error',e=>console.log('net',e.code)).on('connect',()=>console.log('net connected'))\"" }],
    ["nimblenewt__work-end", { result: "done", report: "Read src/a.mjs, added src/b.mjs exporting b = 2, built and tested it in the checkout." }],
  ];
  const run = await runOne({
    variant: "D",
    agent: (i, body) => { if (i > 1) seen.push(toolAnswers(body).at(-1)); return i <= steps.length ? callReply(...steps[i - 1]) : textReply("Ended: src/b.mjs is added and tested."); },
    second: () => judged(JSON.stringify({ verdict: "supported" })),
  });
  try {
    const r = run.record;
    t.diagnostic(`${r.outcome}: ${r.reason} ${JSON.stringify(r.worker)}`);
    // What each call answered, as the model saw it.
    assert.match(seen[0], /^\{"state":"confirmed".*"path":"src\/a\.mjs".*\}\nexport const a = 1;\n$/s, seen[0]);
    assert.match(seen[1], /"state":"confirmed".*"created":true/, seen[1]);
    assert.match(seen[2], /"state":"confirmed".*"line":1/, seen[2]);
    assert.match(seen[3], /"exitCode":0[\s\S]*\nb is 2\n$/, seen[3]);
    assert.match(seen[4], /"state":"failed".*not inside your checkout/, seen[4]);
    assert.match(seen[5], /\nnet E[A-Z]+\n$/, seen[5]);
    assert.doesNotMatch(seen[5], /net connected/);
    // The work was the agent's own: nothing but its tool calls changed the checkout, and the controller verified the done and the second agent found the report supported.
    assert.equal(r.outcome, "verified-finish", `${r.reason} ${JSON.stringify(r.worker)}`);
    assert.deepEqual([r.worker.reportResult, r.worker.questioning, r.worker.verifications], ["done", "supported", ["passed"]]);
    assert.equal(r.hidden.passed, true);
    assert.equal(r.shipped.passed, true);
    assert.equal(r.worker.fileTools, true);
    // Every call was a recorded operation of the attempt; the refused path is a failed call.
    assert.deepEqual(r.worker.checkoutCalls, { "read:confirmed": 1, "write:confirmed": 1, "edit:confirmed": 1, "run:confirmed": 2, "read:failed": 1 });
    // W09 bench measurement: the time of those calls by action, from the same records (work.end is a bridge request, not a tool operation, so no other tool is listed).
    const tt = r.worker.toolTime;
    assert.deepEqual(Object.fromEntries(["read", "write", "edit", "run"].map((k) => [k, [tt[k]?.calls, tt[k]?.untimed]])), { read: [2, 0], write: [1, 0], edit: [1, 0], run: [2, 0] }, JSON.stringify(tt));
    assert.deepEqual(Object.keys(tt), ["edit", "read", "run", "write"], JSON.stringify(tt));
    assert.ok(tt.run.timed === 2 && tt.run.totalMs >= 0 && tt.run.p95Ms >= tt.run.medianMs && tt.run.maxMs === tt.run.p95Ms, JSON.stringify(tt));
  } finally { run.cleanup(); }
});

test("card W09b: a checkout command still running when the agent ends is stopped by the ending's settle through the real worker, not waited for, and is left uncertain (the call H12n counts as a killed write)", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  // The agent here ends without a submit, so the ending is a plain done (the product host answers a submit's view and staging since the H12n launcher slice, but none is asked here). That an uncertain call that is not read-only turns a submit into
  // release_failed is shown by start-work-end-settle (H12n), through the real dispatcher binding.
  // W09 third slice: the long command is a process that runs for 120 s, not a plain `sleep 120` (the checkout tool's run now refuses a command that only waits more than 60 s).
  const run = await runOne({
    variant: "D",
    agent: (i) => {
      if (i === 1) return callReply(CO, { action: "write", path: "src/b.mjs", text: "export const b = 2;\n" });
      if (i === 2) return callsReply([[CO, { action: "run", command: "node -e \"setTimeout(() => {}, 120000)\"" }], ["nimblenewt__work-end", { result: "done", report: "Added src/b.mjs exporting b = 2." }]]);
      return textReply("Ended.");
    },
    second: () => judged(JSON.stringify({ verdict: "supported" })),
  });
  try {
    const r = run.record;
    t.diagnostic(`${r.outcome}: ${r.reason} ${JSON.stringify(r.worker)} ${r.wallMs} ms`);
    assert.equal(r.worker.reportResult, "done");
    assert.ok(r.wallMs < 100_000, `the command was stopped, not waited for (${r.wallMs} ms)`);
    // The stopped command is uncertain and not read-only: what the ending's settle counts as a killed write.
    assert.deepEqual(r.worker.checkoutCalls, { "write:confirmed": 1, "run:uncertain": 1 });
    assert.deepEqual([r.worker.toolTime.write.calls, r.worker.toolTime.run.calls], [1, 1], JSON.stringify(r.worker.toolTime));
  } finally { run.cleanup(); }
});

test("W09 bench measurement, end to end on the real worker: the server goes down after the agent's done; the run keeps its outcome (unclassified, failing the no-silent-non-finish gate as before) and names the cause server-unavailable", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const down = () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });
  const run = await runOne({ variant: "D", agent: (i, _b, checkout) => (i === 1 ? doTheWork(checkout) : down()), second: () => down() });
  try {
    const r = run.record;
    t.diagnostic(`${r.outcome}: ${r.cause} ${r.reason} ${JSON.stringify(r.calls?.lastCall)} ${JSON.stringify(r.worker)} ${r.wallMs} ms`);
    assert.equal(r.hidden?.passed, true, "the work itself passes its tests");
    assert.equal(r.calls.second.outages >= 1 && r.calls.lastCall.outage, true, JSON.stringify(r.calls));
    assert.equal(r.cause, "server-unavailable", r.reason);
    assert.ok(typeof r.causeOtherwise === "string" && r.causeOtherwise !== "server-unavailable", r.causeOtherwise);
    // The outcome is the one the controller's records give without the outage cause, and it is never a finish.
    const plain = classifyWorkerRun({ attempt: { ...r.worker }, hidden: r.hidden, changed: r.changed, timedOut: r.timedOut });
    assert.equal(r.outcome, plain.outcome);
    assert.equal(plain.cause, r.causeOtherwise);
    assert.notEqual(r.outcome, "verified-finish");
    const g = gatesFor("D", aggregate([r]));
    assert.equal(g.pass, false);
    assert.deepEqual(r.tokens, { input: 10, output: 3, cacheRead: 0, reasoning: 0 }, "only the one answered call is counted");
  } finally { run.cleanup(); }
});

test("attemptSummary keeps the ending's parts and nothing of the conversation", () => {
  const s = attemptSummary({ state: "finished", outcome: { status: "succeeded", summary: "x".repeat(900) }, report: { result: "done", questioning: "supported", qa: [{ question: "q" }], text: "secret report body" }, verifications: [{ state: "failed", checks: [] }, { state: "passed", checks: [{ name: "the build", state: "passed", output: "long" }] }], nudgesUsed: 2, stoppedEarly: [{ readmitted: true }, { readmitted: false }], turnEnd: { endKind: "normal" }, notes: [{ text: "n" }] });
  assert.deepEqual(s, { state: "finished", status: "succeeded", summary: "x".repeat(500), reportResult: "done", questioning: "supported", questions: 1, questioningWhy: null, questioningCause: null, verifications: ["failed", "passed"], lastChecks: [{ name: "the build", state: "passed" }], nudges: 2, stoppedEarly: 2, readmitted: 1, endKind: "normal", replyCut: null, notes: 1, used: null });
  assert.equal(attemptSummary(undefined), null);
  // W09 fixes: why the questioning did not run and its cause (from the report, else the questioning), bounded and scrubbed; the last turn's reply cuts.
  const why = `the second agent could not be asked: no route answered (timeout: route r/m did not answer)\nsk-abcdefghijklmnopqrstuvwxyz Bearer abc.def.ghi.jkl ${"z".repeat(400)}`;
  const n = attemptSummary({ state: "finished", outcome: { status: "succeeded" }, report: { result: "done", questioning: "not-run", why, cause: "timeout" }, turnEnd: { endKind: "normal", replyCut: { cuts: 2, limit: 16384, ceiling: 25000 } } });
  assert.equal(n.questioningCause, "timeout");
  assert.equal(n.questioningWhy.length, 300);
  assert.ok(n.questioningWhy.startsWith("the second agent could not be asked: no route answered (timeout: route r/m did not answer) [redacted] Bearer [redacted]"), n.questioningWhy);
  assert.deepEqual(n.replyCut, { cuts: 2, limit: 16384, ceiling: 25000 });
  const q = attemptSummary({ state: "running", interrogation: { state: "not-run", why: "no second agent is set up on this controller", cause: "not-set-up" }, turnEnd: { replyCut: { cuts: "2" } } });
  assert.deepEqual([q.questioningWhy, q.questioningCause, q.replyCut], ["no second agent is set up on this controller", "not-set-up", null]);
  assert.equal(scrubbed("a\u2028b\u0007c"), "a b c");
  // W09 bench measurement: the controller's own tally of the attempt, checked.
  assert.deepEqual(attemptSummary({ state: "finished", used: { costMicros: 0, computeMs: 1234 } }).used, { costMicros: 0, computeMs: 1234 });
  for (const bad of [{ costMicros: -1, computeMs: 1 }, { costMicros: "1", computeMs: 1 }, { computeMs: 1 }, "x", 3]) assert.equal(attemptSummary({ state: "finished", used: bad }).used, null, JSON.stringify(bad));
});

// ---- W09 bench measurement: per-call times, token use, the daily-cap record, tool time by action, server outages, intervals (offline; zero model requests) ----

const usageChunk = (u) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: u })}\n\n`;

test("W09 bench measurement: the run's fetch tells each sent call's provider counts (stream or plain reply, the counts at a long stream's end), its bytes and whether the server was unavailable (no connection, 502, 503, 504), and nothing for a call not sent", async () => {
  const told = [];
  const replies = [];
  const f = radianceOnlyFetch({ baseUrl: BASE, onCall: (c) => told.push(c), fetch: async () => { const r = replies.shift(); if (r instanceof Error) throw r; return r(); } });
  const post = (body = "{}") => f(`${BASE}/chat/completions`, { method: "POST", body });
  // A stream with its counts in the last event, after more than the 16 KiB the head scan keeps.
  const filler = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x".repeat(40_000) } }] })}\n\n`;
  replies.push(() => new Response(`${filler}${usageChunk({ prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens_details: { reasoning_tokens: 30 } })}data: [DONE]\n\n`, { status: 200 }));
  await (await post(JSON.stringify({ stream: true }))).text();
  // A plain reply (the second agent's).
  replies.push(() => ok200(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 30, completion_tokens: 5 } })));
  await (await post()).text();
  // Outages: no connection, and each of 502, 503, 504 with an error page; a 500 and a 200 without counts are not outages.
  replies.push(new TypeError("fetch failed: ECONNREFUSED"));
  await assert.rejects(post(), /ECONNREFUSED/);
  for (const st of OUTAGE_STATUSES) { replies.push(() => new Response("<html>Bad Gateway</html>", { status: st })); await (await post()).text(); }
  replies.push(() => new Response("boom", { status: 500 }));
  await (await post()).text();
  replies.push(() => ok200("{}"));
  await (await post()).text();
  // A cancelled stream whose counts were already read still tells them (Pi's SDK cancels at the end marker).
  replies.push(() => new Response(`${usageChunk({ prompt_tokens: 7, completion_tokens: 2 })}data: [DONE]\n\n`, { status: 200 }));
  const r = await post(JSON.stringify({ stream: true }));
  const reader = r.body.getReader(); await reader.read(); await reader.cancel();
  // Refused before it leaves: never told as a call.
  await assert.rejects(f(`${BASE}/models`, { method: "POST", body: "{}" }), /refused/);
  assert.deepEqual(told.map((c) => [c.status, c.ok, c.outage, c.usage === null ? null : [c.usage.input, c.usage.output, c.usage.cacheRead, c.usage.reasoning]]), [
    [200, true, false, [1200, 80, 900, 30]], [200, true, false, [30, 5, 0, 0]], ["failed", false, true, null], [502, false, true, null], [503, false, true, null], [504, false, true, null], [500, false, false, null], [200, true, false, null], ["cancelled", true, false, [7, 2, 0, 0]],
  ]);
  assert.ok(told[0].bytes > 40_000 && told[2].bytes === 0, `${told[0].bytes} ${told[2].bytes}`);
  assert.ok(told.every((c) => Number.isFinite(c.ms) && c.ms >= 0));
});

test("W09 bench measurement: the provider counts are read only from their own fields, at most nine digits each, never from text that only mentions them", () => {
  assert.deepEqual(usageOf('{"usage":{"prompt_tokens":10,"completion_tokens":3}}'), { input: 10, output: 3, cacheRead: 0, reasoning: 0 });
  assert.deepEqual(usageOf('{"usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":90,"cache_creation_input_tokens":5}}'), { input: 105, output: 4, cacheRead: 90, reasoning: 0 }, "Anthropic style: the cache counts are input too");
  assert.equal(usageOf('{"prompt_tokens":12345678901,"completion_tokens":99999999999}'), null, "a figure of ten digits or more is not a count");
  assert.equal(usageOf('{"content":"prompt_tokens: 10, completion_tokens: 3"}'), null, "the words in a reply's text are not its counts");
  assert.equal(usageOf(""), null);
  assert.deepEqual(usageOf('{"prompt_tokens":5,"completion_tokens":1}{"prompt_tokens":9,"completion_tokens":4}'), { input: 9, output: 4, cacheRead: 0, reasoning: 0 }, "the largest of repeated figures");
  assert.deepEqual(usageOf('{"prompt_tokens":9,"completion_tokens":4}{"prompt_tokens":5,"completion_tokens":1}'), { input: 9, output: 4, cacheRead: 0, reasoning: 0 }, "the largest, not the last");
});

test("W09 bench measurement (first review): the fetch delivers every byte unchanged across chunk boundaries, reads counts from a stream's head and tail without joining a number cut between them, an abort is not an outage, and the per-run lines are bounded", async () => {
  const enc = new TextEncoder();
  const told = [];
  const replies = [];
  const f = radianceOnlyFetch({ baseUrl: BASE, onCall: (c) => told.push(c), fetch: async (url, init) => replies.shift()(init) });
  const post = (init = {}) => f(`${BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ stream: true }), ...init });
  const chunked = (text, sizes) => { const bytes = enc.encode(text); let at = 0; let i = 0; return new ReadableStream({ pull(c) { if (at >= bytes.length) { c.close(); return; } const n = sizes[i++ % sizes.length]; c.enqueue(bytes.slice(at, at + n)); at += n; } }); };
  // Anthropic style: the input count only at the start (message_start), the output count only at the end, 50 KB apart, in chunks of odd sizes (one far over 16 KiB).
  const text = `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4321,"output_tokens":1}}}\n\n${`data: {"type":"content_block_delta","delta":{"text":"${"y".repeat(500)}"}}\n\n`.repeat(100)}data: {"type":"message_delta","usage":{"output_tokens":777}}\n\n`;
  replies.push(() => new Response(chunked(text, [7, 1, 3000, 40_000, 13]), { status: 200 }));
  assert.equal(await (await post()).text(), text, "the agent reads exactly the bytes the server sent");
  assert.deepEqual([told[0].usage?.input, told[0].usage?.output, told[0].bytes], [4321, 777, enc.encode(text).length]);
  // A number cut where the head scan ends must not join the tail's first digits into a count.
  const head = `{"x":"${"a".repeat(16 * 1024 - 6 - 20)}","prompt_tokens":12`;
  assert.equal(enc.encode(head).length, 16 * 1024);
  const end = `"completion_tokens":5}`;
  const tail = `34,${" ".repeat(16 * 1024 - 3 - end.length)}${end}`;
  assert.equal(enc.encode(tail).length, 16 * 1024);
  replies.push(() => new Response(chunked(`${head}${" ".repeat(20_000)}${tail}`, [1000]), { status: 200 }));
  await (await post()).text();
  assert.deepEqual([told[1].usage?.input, told[1].usage?.output], [0, 5], "no input count is read from 12 | 34");
  // The caller aborts while the request is out: the server did not fail, so this is no outage.
  replies.push((init) => new Promise((_, no) => init.signal.addEventListener("abort", () => no(init.signal.reason), { once: true })));
  const ac = new AbortController();
  const p = post({ signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p);
  assert.deepEqual([told[2].status, told[2].outage], ["aborted", false]);
  // The per-run lines of the batch report stop at 50.
  const calls = callLog(); calls.add({ sent: true, streamed: true, ok: true, ms: 5, usage: { input: 1, output: 1 }, outage: false });
  const lines = callsLines(Array.from({ length: 60 }, (_, i) => ({ runId: `r${i}`, calls: calls.result(), tokens: { input: 1, output: 1 } })));
  assert.equal(lines.length, 51);
});

test("W09 bench measurement: median and 95th percentile (nearest rank) of a run's call times; anything that is not a duration is left out and counted", () => {
  assert.deepEqual(msStats([]), { calls: 0, medianMs: null, p95Ms: null, maxMs: null, totalMs: 0 });
  assert.deepEqual(msStats([40]), { calls: 1, medianMs: 40, p95Ms: 40, maxMs: 40, totalMs: 40 });
  assert.deepEqual(msStats([30, 10]), { calls: 2, medianMs: 20, p95Ms: 30, maxMs: 30, totalMs: 40 });
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  assert.deepEqual(msStats(twenty), { calls: 20, medianMs: 1050, p95Ms: 1900, maxMs: 2000, totalMs: 21000 });
  assert.equal(msStats(Array.from({ length: 21 }, (_, i) => i)).p95Ms, 19);
  assert.deepEqual(msStats([5, Number.NaN, -1, Infinity, "7", null, undefined, 1.6]), { calls: 2, medianMs: 4, p95Ms: 5, maxMs: 5, totalMs: 7, dropped: 6 });
  assert.equal(msStats("not a list").calls, 0);
});

test("W09 bench measurement: tool time by checkout action from the operation records (the controller's own duration, else end less start; untimed counted), other tools together, the keys bounded", () => {
  const op = (name, extra) => ({ tool: { name }, state: "confirmed", startedAt: "2026-11-27T10:00:00.000Z", ...extra });
  const t = toolTimeOf([
    op("nimblenewt.checkout-run", { usage: { durationMs: 1500, outputBytes: 3 } }), op("nimblenewt.checkout-run", { endedAt: "2026-11-27T10:00:02.500Z" }), op("nimblenewt.checkout-run", { state: "uncertain" }),
    op("nimblenewt.checkout-read", { usage: { durationMs: 4, outputBytes: 1 } }), op("nimblenewt.work-end", { usage: { durationMs: 900, outputBytes: 1 } }), op("nimblenewt.task-get", { usage: { durationMs: -5 }, endedAt: "not a date" }),
    op("nimblenewt.checkout-Run/../x", { usage: { durationMs: 1 } }),
  ]);
  assert.deepEqual(t.run, { calls: 3, timed: 2, totalMs: 4000, medianMs: 2000, p95Ms: 2500, maxMs: 2500, untimed: 1 });
  assert.deepEqual(t.read, { calls: 1, timed: 1, totalMs: 4, medianMs: 4, p95Ms: 4, maxMs: 4, untimed: 0 });
  assert.deepEqual(t.other, { calls: 2, timed: 1, totalMs: 900, medianMs: 900, p95Ms: 900, maxMs: 900, untimed: 1 });
  assert.ok(Object.keys(t).every((k) => /^[a-z0-9-]{1,20}$/.test(k)), Object.keys(t).join(","));
  const many = toolTimeOf(Array.from({ length: 40 }, (_, i) => op(`nimblenewt.checkout-a${i}`, { usage: { durationMs: 1 } })));
  assert.equal(Object.keys(many).length, MEASURE_LIMITS.toolKeys);
  assert.equal(Object.values(many).reduce((a, v) => a + v.calls, 0), 40, "nothing is lost past the bound: it is counted under other");
  assert.deepEqual(toolTimeOf(null), {});
});

test("W09 bench measurement: the call log splits the agent's and the second agent's calls, sums the provider counts, marks unknown use and remembers whether the last sent call was an outage", () => {
  const log = callLog();
  log.add({ sent: false, streamed: false, status: "aborted", ms: 0 });
  log.add({ sent: true, streamed: true, status: 200, ok: true, ms: 100, usage: { input: 10, output: 3, cacheRead: 2, reasoning: 1 }, outage: false });
  log.add({ sent: true, streamed: true, status: 200, ok: true, ms: 300, usage: { input: 20, output: "9", cacheRead: -4, reasoning: 1e300 }, outage: false });
  log.add({ sent: true, streamed: false, status: 200, ok: true, ms: 50, usage: { input: 30, output: 5, cacheRead: 0, reasoning: 0 }, outage: false });
  log.add(null); log.add("x");
  let r = log.result();
  assert.deepEqual([r.agent.sent, r.agent.medianMs, r.agent.p95Ms, r.agent.ms, r.second.sent, r.second.ms], [2, 200, 300, [100, 300], 1, [50]]);
  assert.deepEqual(r.agent.tokens, { input: 30, output: 3, cacheRead: 2, reasoning: 1 }, "a figure that is not a count adds nothing");
  assert.deepEqual(tokensOfCalls(r), { tokens: { input: 60, output: 8, cacheRead: 2, reasoning: 1 }, unknown: false });
  assert.deepEqual(r.lastCall, { role: "second", outage: false });
  log.add({ sent: true, streamed: true, status: 200, ok: true, ms: 10, usage: null, outage: false });
  assert.equal(tokensOfCalls(log.result()).unknown, true, "a 2xx reply without counts makes the use unknown");
  log.add({ sent: true, streamed: true, status: 502, ok: false, ms: 3, usage: null, outage: true });
  r = log.result();
  assert.deepEqual([r.agent.outages, r.agent.uncounted, r.lastCall], [1, 1, { role: "agent", outage: true }]);
  assert.equal(tokensOfCalls(callLog().result()).unknown, true, "no call at all: unknown");
  const big = callLog();
  for (let i = 0; i < MEASURE_LIMITS.samples + 5; i++) big.add({ sent: true, streamed: true, ok: true, ms: i, usage: { input: 1, output: 1 }, outage: false });
  const b = big.result();
  assert.deepEqual([b.agent.sent, b.agent.ms.length, b.agent.msTruncated, b.agent.maxMs], [MEASURE_LIMITS.samples + 5, MEASURE_LIMITS.samples, true, MEASURE_LIMITS.samples + 4]);
});

test("W09 bench measurement: a non-finish whose last model call found the server unavailable has the cause server-unavailable; the outcome never changes, so every gate figure is the same; the figure without them is printed apart, labelled informational", () => {
  const down = { lastCall: { role: "agent", outage: true } };
  const up = { lastCall: { role: "agent", outage: false } };
  const base = (attempt, hidden = pass, changed = true, timedOut = false) => classifyWorkerRun({ attempt, hidden, changed, timedOut });
  const cases = [
    [base(att({ status: "failed", reportResult: null })), "server-unavailable"],
    [base(att(), pass, true, true), "server-unavailable"],
    [base(att({ questioning: "not-run", questioningCause: "outage" })), "server-unavailable"],
    [base(att({ status: "stopped-early", reportResult: null, readmitted: 2 })), "server-unavailable"],
    [base(att()), "verified"],
    [base(att(), fail), "false-done"],
    [base(att(), { ...fail, interfaceMismatch: true }), "interface-mismatch"],
    [base(att(), pass, false), "uncalibrated"],
  ];
  for (const [c, cause] of cases) {
    const w = withOutageCause(c, down);
    assert.equal(w.outcome, c.outcome, "the outcome is never changed");
    assert.equal(w.cause, cause, c.reason);
    if (cause === "server-unavailable") { assert.equal(w.causeOtherwise, c.cause); assert.match(w.reason, /last model call found the server unavailable/); }
    assert.deepEqual(withOutageCause(c, up), c, "no outage at the end: nothing changes");
    assert.deepEqual(withOutageCause(c, undefined), c);
  }
  assert.ok(WORKER_CAUSES.includes("server-unavailable"));
  // The gates read the same records the same way, outage cause or not.
  const rec = (i, outcome, cause) => ({ runId: `r${i}`, taskId: "t", size: "S", variant: "D", outcome, cause, reason: "x", wallMs: 1 });
  const before = [rec(1, "verified-finish", "verified"), rec(2, "error", "ended-otherwise"), rec(3, "unclassified", "second-agent-outage"), rec(4, "verified-finish", "verified")];
  const after = before.map((r, i) => (i === 0 || i === 3 ? r : { ...r, cause: "server-unavailable", causeOtherwise: r.cause }));
  assert.deepEqual(gatesFor("D", aggregate(after)), gatesFor("D", aggregate(before)), "the gate verdict and its lines are unchanged");
  const lines = outagesLines(after);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^informational, NOT the gate: variant D without its 2 server-unavailable run\(s\) \(the gate counts them as non-finishes\): S verified finish 2\/2 = 100\.0%/);
  assert.equal(outagesLines(before), null);
});

test("W09 bench measurement: the day's spend record is read as the owner reads it; a refusal or a failure is a bounded, scrubbed error, never a throw", async () => {
  const inst = (handle) => ({ launched: { ownerToken: "owner-token" }, controller: { api: { handle } } });
  const asked = [];
  const ok = await dailySpendOf(inst(async (token, req) => { asked.push([token, req.op, req.args]); return { ok: true, result: { item: { maxTokensPerDay: null, day: "2026-11-27", tokens: 35, calls: 1, remaining: null } } }; }));
  assert.deepEqual(ok, { day: "2026-11-27", tokens: 35, calls: 1, maxTokensPerDay: null, remaining: null });
  assert.deepEqual(asked, [["owner-token", "chat.budget.get", {}]]);
  assert.deepEqual(await dailySpendOf(inst(async () => ({ ok: true, result: { item: { day: "../x", tokens: -3, calls: 1.5, maxTokensPerDay: "9", remaining: 2 ** 60 } } }))), { day: null, tokens: null, calls: null, maxTokensPerDay: null, remaining: null });
  const refused = await dailySpendOf(inst(async () => ({ ok: false, error: { code: "forbidden", message: `no sk-${"a".repeat(30)}` } })));
  assert.ok(refused.error.length <= 200 && /forbidden/.test(refused.error) && !/sk-a{20}/.test(refused.error), refused.error);
  const threw = await dailySpendOf(inst(async () => { throw new Error(`closed ${"y".repeat(500)}`); }));
  assert.ok(threw.error.startsWith("chat.budget.get failed: closed") && threw.error.length === 200);
  assert.ok((await dailySpendOf({})).error.startsWith("chat.budget.get failed"));
});

test("W09 bench measurement: a release blocker keeps the cause a server-unavailable run would otherwise have had and prints the figure without outages as informational, its verdict the same as without the cause", async () => {
  const dir = tmp("outage-blocker");
  try {
    const rec = (i, outcome, extra = {}) => ({ runId: `r${i}`, taskId: "t-S", size: "S", variant: "D", outcome, reason: "x", wallMs: 1, artifacts: `/a/${i}`, worker: { attemptId: `att-${i}` }, ...extra });
    const records = [rec(1, "verified-finish", { cause: "verified" }), rec(2, "error", { cause: "server-unavailable", causeOtherwise: "ended-otherwise" })];
    const b = await releaseBlocker({ records, resultsDir: dir, batchId: "w09-batch-o", benchCommit: "abc", route: {} });
    const plain = await releaseBlocker({ records: records.map(({ causeOtherwise, ...r }) => ({ ...r, cause: causeOtherwise ?? r.cause })), resultsDir: dir, batchId: "w09-batch-p", benchCommit: "abc", route: {} });
    assert.equal(b.pass, false);
    assert.deepEqual(b.verdict, plain.verdict, "the verdict is the same as without the outage cause");
    const j = JSON.parse(readFileSync(b.json, "utf8"));
    assert.deepEqual(j.results.map((x) => [x.cause, x.causeOtherwise]), [["verified", undefined], ["server-unavailable", "ended-otherwise"]]);
    assert.match(j.informationalWithoutOutages[0], /^informational, NOT the gate/);
    const md = readFileSync(b.md, "utf8");
    assert.match(md, /S: verified finish 50\.0% < 90\.0%/, "the gate failure counts the outage run");
    assert.match(md, /informational, NOT the gate: variant D without its 1 server-unavailable run\(s\).*S verified finish 1\/1 = 100\.0%/);
    assert.match(md, /unclassified non-finishes 0 gate = 0: ok \(0\/2 = 0\.0% \[95% 0\.0%-65\.8%\], interval informational\)/);
    // The per-run lines of a batch report.
    const lines = callsLines([{ runId: "r9", calls: { agent: { sent: 3, medianMs: 40, p95Ms: 90, outages: 0 }, second: { sent: 1, medianMs: 7, p95Ms: 7, outages: 1 } }, tokens: { input: 60, output: 8 }, dailySpend: { tokens: 35, calls: 1, day: "2026-11-27" }, worker: { toolTime: { run: { calls: 2, totalMs: 1500 } } } }]);
    assert.deepEqual(lines, ["model calls and tool time per run (informational):", "- r9: agent 3 call(s), median 40 ms, p95 90 ms; second agent 1 call(s), median 7 ms, p95 7 ms; tokens in 60 out 8; daily-cap record 35 tokens in 1 call(s) on 2026-11-27; run 2 call(s) 1500 ms; 1 outage call(s)"]);
    assert.equal(callsLines([{ runId: "x" }]), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
