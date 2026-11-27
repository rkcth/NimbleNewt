// Card W09, second slice: the done check per contract clause, on the bench. Offline and model-free: the task set's declared done tests and its opt-in, the CONTRACT bullets read as the contract's criteria, and, end to end
// through the product composition (the launcher with scripts/local-host.mjs: bubblewrap, the worker process running Pi, the relay, the done check, the second agent) with a scripted Radiance-shaped endpoint behind the run's
// one fetch, a done refused for having no test of its own, then for a PLAN.md that leaves a clause unmapped, then taken. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1, where it fails instead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLAUSE_LIMITS, contractClauses } from "./pi-eval/lib/contract-clauses.mjs";
import { loadTaskset } from "./pi-eval/lib/taskset.mjs";
import { SANDBOX_NODE, buildCheck, doneChecks, runWorkerOne } from "./pi-eval/lib/worker-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..");
const BASE = "http://127.0.0.1:8002/v1";
const tmp = (label) => realpathSync(mkdtempSync(join(tmpdir(), `nn-w09c-${label}-`)));

test("the CONTRACT bullets of a task text, in order: indented lines join their bullet, the section ends at the next plain line, each is cut to the contract's bound at a whole character", () => {
  const text = ["PROBLEM: x", "- not a clause", "", "CONTRACT (binding):", "- first clause", "  continued here", "- second", "", "- third after a blank", "Notes after.", "- not a clause either"].join("\n");
  assert.deepEqual(contractClauses(text), ["first clause continued here", "second", "third after a blank"]);
  assert.deepEqual(contractClauses("no section\n- a\n"), []);
  assert.deepEqual(contractClauses("CONTRACT\r\n- a\r\n- b\r\n"), ["a", "b"]);
  // Every length across the bound, with a pair at the cut: never longer, never half a character, "..." when cut.
  for (let n = CLAUSE_LIMITS.criterion - 6; n <= CLAUSE_LIMITS.criterion + 6; n++) {
    const [c] = contractClauses(`CONTRACT\n- ${"a".repeat(n - 4)}\u{1F600}\u{1F600}\n`);
    assert.ok(c.length <= CLAUSE_LIMITS.criterion, `${n}: ${c.length}`);
    assert.ok(!/[\uD800-\uDBFF](?:\.\.\.)?$/.test(c), `${n}: no half pair`);
    if (n > CLAUSE_LIMITS.criterion) assert.ok(c.endsWith("..."), `${n}`);
  }
  assert.equal(contractClauses(`CONTRACT\n${"- x\n".repeat(80)}`).length, CLAUSE_LIMITS.criteria);
});

test("the shipped task set opts in: every task declares done tests (none held out) and the clause check, and its CONTRACT gives between 1 and 50 clauses", () => {
  const set = loadTaskset(join(here, "pi-eval", "taskset.json"));
  for (const t of set.tasks) {
    assert.ok(Array.isArray(t.doneTests) && t.doneTests.length >= 1 && t.doneTests.every((f) => f.startsWith("packages/controller/dist/") && f.endsWith(".test.js")), `${t.id}: ${JSON.stringify(t.doneTests)}`);
    assert.equal(t.clauseTests, true, t.id);
    const clauses = contractClauses(readFileSync(t.promptPath, "utf8"));
    assert.ok(clauses.length >= 1 && clauses.length <= CLAUSE_LIMITS.criteria && clauses.every((c) => c.length <= CLAUSE_LIMITS.criterion), `${t.id}: ${clauses.length}`);
    const checks = doneChecks(t);
    assert.deepEqual(checks.map((c) => c.name), ["the build", "the task's package tests", "the tests your change adds or changes"], t.id);
    assert.deepEqual(checks[2], { name: "the tests your change adds or changes", run: [SANDBOX_NODE, "--test"], timeoutSeconds: 1800, changedTests: true });
  }
});

test("a task that does not opt in, or has no build, gets no clause check; the task set refuses a clauseTests that is not true or false", () => {
  const setup = { argv: ["node", "node_modules/typescript/bin/tsc", "--build"] };
  assert.deepEqual(doneChecks({ setup }), buildCheck({ setup }));
  assert.deepEqual(doneChecks({ setup: null, clauseTests: true }), []);
  assert.equal(doneChecks({ setup, clauseTests: true }).at(-1).changedTests, true);
  const dir = tmp("set");
  try {
    const raw = JSON.parse(readFileSync(join(here, "pi-eval", "taskset.json"), "utf8"));
    for (const sub of ["tasks", "acceptance"]) execFileSync("cp", ["-r", join(here, "pi-eval", sub), join(dir, sub)]);
    const write = (o) => { const f = join(dir, "taskset.json"); writeFileSync(f, JSON.stringify(o)); return f; };
    assert.throws(() => loadTaskset(write({ ...raw, defaults: { ...raw.defaults, clauseTests: "yes" } })), /defaults\.clauseTests must be true or false/);
    assert.throws(() => loadTaskset(write({ ...raw, tasks: [{ ...raw.tasks[0], clauseTests: 1 }] })), /clauseTests must be true or false/);
    assert.equal(loadTaskset(write({ ...raw, tasks: [{ ...raw.tasks[0], clauseTests: false }] })).tasks[0].clauseTests, false, "a task's own value wins over the default");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- end to end through the real worker ---------------------------------------------------------------------------------------------------------------------

const required = process.env.NIMBLENEWT_REQUIRE_SANDBOX === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const sh = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const ok200 = (text) => new Response(text, { status: 200, headers: { "content-type": "application/json" } });
const sse = (delta, finish, usage) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "qwen-test", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const stream = (chunks) => new Response(`${sse({ role: "assistant", content: "" }, null)}${chunks}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const textReply = (t) => stream(`${sse({ content: t }, null)}${sse({}, "stop", usage)}`);
const callReply = (name, args) => stream(`${sse({ tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null)}${sse({}, "tool_calls", usage)}`);
const judged = (content) => ok200(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 30, completion_tokens: 5 } }));
const allText = (body) => JSON.stringify(body.messages);

async function sandboxUsable() {
  const { SandboxLauncher } = await import(pathToFileURL(join(repository, "packages", "worker", "dist", "index.js")).href);
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  return { usable, why };
}

const PROMPT = "Add src/b.mjs exporting the constant b = 2.\n\nCONTRACT (binding):\n- `b` is exported from src/b.mjs and equals 2.\n- Whatever the input, `b` is a number.\n";

/** A tiny repository (base, and a solution commit with the shipped test), the bench's acceptance test, installed dependencies (ignored), and the task as loadTaskset makes it, opted in to the clause check. */
function fixture(parent) {
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
  writeFileSync(join(parent, "tiny.md"), PROMPT);
  const task = {
    id: "tiny", title: "Add b", size: "S", base, solution, promptPath: join(parent, "tiny.md"), hiddenFiles: ["w01-hidden.test.mjs"], testFiles: ["w01-hidden.test.mjs"],
    acceptance: { files: [{ dest: "w01-acceptance-b.test.mjs", src: join(acc, "b.test.mjs") }], support: [], testFiles: ["w01-acceptance-b.test.mjs"], testNamePatterns: [] },
    timeoutMinutes: 4, copy: ["node_modules"], setup: { argv: ["node", "-e", "require('node:fs').accessSync('src/b.mjs')"] }, test: { cwd: ".", argv: ["node", "--test", "{{TEST_FILES}}"], env: {} }, clauseTests: true,
  };
  return { repo, task };
}

function findCheckout(workRoot) {
  for (const d of readdirSync(workRoot)) {
    const work = join(workRoot, d, "data.host", "work");
    if (!existsSync(work)) continue;
    for (const p of readdirSync(work)) for (const t of readdirSync(join(work, p))) { const c = join(work, p, t, "checkout"); if (existsSync(c)) return c; }
  }
  return undefined;
}

const TESTS = 'import { test } from "node:test"; import assert from "node:assert/strict"; import { b } from "./b.mjs";\ntest("b equals two", () => assert.equal(b, 2));\ntest("b is a number", () => assert.equal(typeof b, "number"));\n';

test("end to end on the real worker: a done with no test of its own is refused, then one whose PLAN.md leaves a clause unmapped, each with its reason as the work.end answer; the done that maps both clauses to passing tests is taken and verified (W09 second slice)", async (t) => {
  const s = await sandboxUsable();
  if (!s.usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${s.why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const parent = tmp("e2e");
  try {
    const { repo, task } = fixture(parent);
    const workRoot = join(parent, "work");
    const resultsDir = join(parent, "results");
    mkdirSync(workRoot); mkdirSync(resultsDir);
    const bodies = [];
    const end = () => callReply("nimblenewt__work-end", { result: "done", report: "Added src/b.mjs exporting b = 2, with its tests; the build passes." });
    const agent = (i, checkout) => {
      if (i === 1) { writeFileSync(join(checkout, "src", "b.mjs"), "export const b = 2;\n"); writeFileSync(join(checkout, "PLAN.md"), "- [x] add b\n"); return end(); }
      if (i === 2) { writeFileSync(join(checkout, "src", "b.test.mjs"), TESTS); writeFileSync(join(checkout, "PLAN.md"), '- [x] C1: src/b.test.mjs "b equals two"\n- [ ] C2: later\n'); return end(); }
      if (i === 3) { writeFileSync(join(checkout, "PLAN.md"), '- [x] C1: src/b.test.mjs "b equals two"\n- [x] C2: src/b.test.mjs "b is a number"\n'); return end(); }
      return textReply("Ended: src/b.mjs and its tests are added.");
    };
    const fetch = async (url, init) => {
      assert.equal(String(url), `${BASE}/chat/completions`);
      const body = JSON.parse(String(init.body));
      if (body.stream !== true) return judged(JSON.stringify({ verdict: "supported" }));
      bodies.push(body);
      return agent(bodies.length, findCheckout(workRoot));
    };
    const ctx = {
      set: { agent: { provider: "radiance", model: "qwen-test" } }, repo, depsFrom: repo, workRoot, resultsDir, root: repository, batchId: "w09-clause-test", benchCommit: "test-commit", keep: false, pollMs: 200,
      radiance: { baseUrl: BASE, model: "qwen-test", contextTokens: 65_536, maxTokens: 4096, reasoningTokens: 1024 }, fetch,
      start: { facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }) },
    };
    const r = await runWorkerOne(ctx, task, "D", 1);
    t.diagnostic(`${r.outcome}: ${r.reason} ${JSON.stringify(r.worker)}`);
    // The start told the agent the clauses and the form; each refusal came back as the answer of its work.end, in the same conversation.
    const first = allText(bodies[0]);
    assert.ok(first.includes("The contract has 2 clause(s), in this order: C1 ") && first.includes("Whatever the input, `b` is a number."), first.slice(0, 3000));
    assert.ok(allText(bodies[1]).includes("runs the test files your change adds or changes, and it adds or changes none"), "the first refusal: no test of its own");
    assert.ok(allText(bodies[2]).includes("PLAN.md does not map 1 of the contract's 2 clause(s) to a test of your change: C2"), "the second refusal: C2 not mapped");
    assert.equal(r.outcome, "verified-finish", `${r.reason} ${JSON.stringify(r.worker)}`);
    assert.deepEqual(r.worker.verifications, ["failed", "failed", "passed"], "two refused dones, neither a finish, then the verified one");
    assert.deepEqual(r.worker.lastChecks, [{ name: "the build", state: "passed" }, { name: "the tests your change adds or changes", state: "passed" }]);
    assert.equal(r.hidden.passed, true);
  } finally { try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* none */ } rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
