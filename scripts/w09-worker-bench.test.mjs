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
import { radianceBase, radianceOnlyFetch, attemptSummary, openW09Installation, scrubbed } from "./pi-eval/lib/worker-embedder.mjs";
import { DESCRIPTION_MAX, SANDBOX_NODE, SHIPPED_VARIANT, WORKER_CAUSES, WORKER_VARIANTS, bridgeFilterFor, buildCheck, causesLine, classifyWorkerRun, doneChecks, fileToolsLine, offersFileTools, releaseBlocker, renderWorkerPrompt, runWorkerOne, workerTitle } from "./pi-eval/lib/worker-run.mjs";
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
  } finally { run.cleanup(); }
});

test("card W09b: a checkout command still running when the agent ends is stopped by the ending's settle through the real worker, not waited for, and is left uncertain (the call H12n counts as a killed write)", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  // The agent here ends without a submit, so the ending is a plain done (the product host answers a submit's view and staging since the H12n launcher slice, but none is asked here). That an uncertain call that is not read-only turns a submit into
  // release_failed is shown by start-work-end-settle (H12n), through the real dispatcher binding.
  const run = await runOne({
    variant: "D",
    agent: (i) => {
      if (i === 1) return callReply(CO, { action: "write", path: "src/b.mjs", text: "export const b = 2;\n" });
      if (i === 2) return callsReply([[CO, { action: "run", command: "sleep 120" }], ["nimblenewt__work-end", { result: "done", report: "Added src/b.mjs exporting b = 2." }]]);
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
  } finally { run.cleanup(); }
});

test("attemptSummary keeps the ending's parts and nothing of the conversation", () => {
  const s = attemptSummary({ state: "finished", outcome: { status: "succeeded", summary: "x".repeat(900) }, report: { result: "done", questioning: "supported", qa: [{ question: "q" }], text: "secret report body" }, verifications: [{ state: "failed", checks: [] }, { state: "passed", checks: [{ name: "the build", state: "passed", output: "long" }] }], nudgesUsed: 2, stoppedEarly: [{ readmitted: true }, { readmitted: false }], turnEnd: { endKind: "normal" }, notes: [{ text: "n" }] });
  assert.deepEqual(s, { state: "finished", status: "succeeded", summary: "x".repeat(500), reportResult: "done", questioning: "supported", questions: 1, questioningWhy: null, questioningCause: null, verifications: ["failed", "passed"], lastChecks: [{ name: "the build", state: "passed" }], nudges: 2, stoppedEarly: 2, readmitted: 1, endKind: "normal", replyCut: null, notes: 1 });
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
});
