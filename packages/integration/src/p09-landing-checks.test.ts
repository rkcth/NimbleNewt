import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AdmissionService, HostService, LocalWorker, startController, type WorkerHost } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces, SandboxLauncher } from "@nimblenewt/worker";

// Card P09, end to end through startController with the local worker over a real git repository and the real sandbox: an agent submits its work (work.end), a second agent approves it, the release commits it, and the
// integrator's landing is gated on the project's required checks (the strict profile's tests and review). The contract's test command runs in bubblewrap on a copy of the integrated tree; while it fails nothing is landed, the
// results are on the request bound to that tree and the author gets them in its inbox. Once it passes (the owner's contract change), the landing lands exactly that tree and the review is the one given for that patch.
// The approval queues the submission in the landing queue (card P10): the refused landing leaves it there and the landing that lands takes it out. When the project also requires `qa`, the controller's gate reads the
// submission's QA gate (third slice): refused without independent evidence, landed once the owner recorded a pass. It also requires `docs` (fourth slice): refused for a document never verified, landed once it is retired.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
const until = async (ok: () => boolean | Promise<boolean>, why: string): Promise<void> => { const end = Date.now() + 60_000; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 25)); } };

test("a landing is made only when the project's required checks pass on the integrated tree: the test command runs in the sandbox, a failure goes back to the author with the results, the review counts for its patch (card P09)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  if (!(launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot))) {
    await launcher.stop().catch(() => undefined);
    if (process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1" && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason ?? "?"}`);
    t.skip("bubblewrap or a node install it can mount is unusable"); return;
  }
  const dir = mkdtempSync(join(tmpdir(), "nn-p09-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const copies = join(dir, "copies");
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: () => shared, busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), checks: { launcher, readOnly: [{ host: nodeRoot, guest: "/opt/node" }], base: copies } });
  const finishes: (() => void)[] = [];
  const started = new Map<string, Promise<void>>();
  const starters = new Map<string, () => void>();
  const credentials = new Map<string, string>();
  let local: LocalWorker | undefined;
  let landingCheckCalls = 0;
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined,
        build: () => {
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
            workspace: { run: (call) => ws.port.run(call as never) as never, landingChecks: async (call) => { landingCheckCalls++; return ws.port.landingChecks!(call); } },
            submitView: (scope) => ws.submitView(scope),
            stage: (scope) => ws.stageWork(scope),
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: { open: async (order) => {
              credentials.set(order.attemptId, order.credential);
              starters.get(order.attemptId)?.();
              let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.push(finish);
              return { run: async () => { await over; return { status: "completed", text: "done" }; }, checkpoint: async () => ({}), tell: async () => undefined, close: async () => undefined };
            } },
          });
          return local as WorkerHost;
        },
      },
    },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const self = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 2, memoryMb: 2048 } });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), self);
    const agent = ((await s.agents.create(owner, { commandId: "mk-1", friendlyName: "Ann", roles: ["author"] })) as { id: string }).id;
    const reviewer = ((await s.agents.create(owner, { commandId: "mk-2", friendlyName: "Rev", roles: ["reviewer"] })) as { id: string }).id;
    for (const who of [agent, reviewer]) for (const g of workGrants(project, ["read-file"])) await s.grants.grant(owner, { commandId: `g-${who}-${g.action}`, grantee: `agent:${who}`, action: g.action, project, source: "direct", basis: "test" } as never);
    const rev = (await s.principals.issueCredential(owner, `agent:${reviewer}`)).token;
    // The project's required checks are the profile's (strict: tests and review), read through the policy service.
    const policy = await api(c, boot.token, "integration.get", { project });
    assert.deepEqual(policy.result?.item?.requiredChecks, ["tests", "review"], JSON.stringify(policy));

    const task = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Dig" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
    const a = (await s.assignments.getAssignment(task))!;
    const attempt = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    started.set(attempt, new Promise<void>((ok) => { starters.set(attempt, ok); }));
    const where = await ws.ensure({ taskId: task, projectId: project });
    assert.deepEqual([...(await c.dispatch.dispatcher.tick()).started], [attempt]);
    await started.get(attempt);
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 2;\n");
    const ended = await api(c, credentials.get(attempt)!, "work.end", { attemptId: attempt, submit: true, result: "done", report: "did the work; found nothing; left nothing; could not do nothing" }, "we-1");
    assert.equal(ended.ok, true, JSON.stringify(ended));
    await until(async () => { await c.dispatch!.dispatcher.tick(); return (await s.workEnd.get(attempt))?.state === "done"; }, "the ending was not completed");
    const submissionId = (await s.workEnd.get(attempt))!.submissionId!;
    const sub = (await api(c, boot.token, "submission.get", { submissionId })).result.item;
    // The landing branch is named before the review, so the controller queues the approved submission in the landing queue by itself (card P10): a landing lands only the queue's head, and the gate judges that submission.
    assert.equal((await api(c, boot.token, "project.branches.change", { project, landing: "main" }, "branch-main")).ok, true);
    assert.equal((await api(c, rev, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: submissionId, verdict: "approve" }, "rv-1")).ok, true);
    const queuedNow = async () => ((await api(c, boot.token, "landing.queue.list", { projectId: project })).result?.items ?? []).map((e: { submissionId: string }) => e.submissionId);
    assert.deepEqual(await queuedNow(), [submissionId], "the approval queued the submission");
    const released = await api(c, boot.token, "workspace.request", { operation: "release", taskId: task, reason: "commit the reviewed work", submissionId }, "rel-1");
    assert.equal(released.result?.state, "done", JSON.stringify(released));

    // The contract's test command, set by the owner: it fails while src/a.ts holds the agent's change.
    const check = (want: string) => [{ name: "unit", run: ["/opt/node/bin/node", "-e", `const s = require('node:fs').readFileSync('src/a.ts', 'utf8'); console.log('checked ' + s.trim()); process.exit(s.includes(${JSON.stringify(want)}) ? 0 : 1);`], timeoutSeconds: 60 }];
    assert.equal((await api(c, boot.token, "contract.set", { taskId: task, expectedVersion: 0, checks: check("a = 1") }, "ct-1")).ok, true);
    await s.principals.enroll(owner, { commandId: "enroll-integrator", kind: "agent", name: "integrator", grants: [] });
    const taken = await api(c, boot.token, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 3_600_000, holder: "integrator" }, "lease-main");
    assert.equal(taken.ok, true, JSON.stringify(taken));
    const lease = { leaseId: taken.result.item.leaseId as string, fence: taken.result.item.fence as number };
    const land = (commandId: string) => api(c, boot.token, "workspace.request", { operation: "landing", taskId: task, reason: "reviewed and released", submissionId, ...lease }, commandId);
    const head = sh(shared, "rev-parse", "HEAD");

    // The test command fails on the integrated tree: nothing is landed; the results, bound to that tree, are on the record and in the author's inbox.
    const refused = await land("land-1");
    assert.equal(refused.ok, true, JSON.stringify(refused));
    assert.equal(refused.result.state, "refused", refused.result.summary);
    assert.match(refused.result.summary, /the required checks did not all pass on the integrated tree .*\(tests failed;/);
    const checks = refused.result.checks;
    assert.deepEqual([checks.passed, checks.tree, checks.patchId, checks.submissionId], [false, sub.tree, sub.patchId, submissionId]);
    assert.deepEqual(checks.results.map((r: { check: string; result: string; boundTo: string }) => [r.check, r.result, r.boundTo]), [["tests", "fail", sub.tree], ["review", "pass", sub.tree]]);
    assert.deepEqual([checks.results[0].runs[0].state, checks.results[0].runs[0].exitCode], ["failed", 1]);
    assert.match(checks.results[0].runs[0].note, /checked export const a = 2;/, "the command read the integrated tree");
    assert.equal(sh(shared, "rev-parse", "HEAD"), head);
    assert.equal(sh(shared, "status", "--porcelain=v1"), "", "nothing was written to the shared workspace");
    assert.equal(readFileSync(join(shared, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(refused.result.toldAuthor, `agent:${agent}`);
    const notes = (await c.storage.listAggregates("agent-message", { limit: 100 })).map((m) => m.body as { to?: string; sender?: string; text?: string; taskId?: string }).filter((m) => m.to === `agent:${agent}` && m.taskId === task);
    assert.equal(notes.length, 1, JSON.stringify(notes));
    assert.match(notes[0]!.text!, /was not landed: the required checks did not all pass/);
    assert.match(notes[0]!.text!, /- unit: exit 1: checked export const a = 2;/);
    assert.deepEqual(await readdir(copies), [], "the check's copy of the tree is gone");
    assert.deepEqual(await queuedNow(), [submissionId], "a landing the checks refused leaves the submission in the queue");

    // The owner's contract now expects the change: the same tree passes, and exactly it is landed.
    assert.equal((await api(c, boot.token, "contract.set", { taskId: task, expectedVersion: 1, checks: check("a = 2") }, "ct-2")).ok, true);
    // The project now also requires QA (third slice): the controller's landing gate reads the submission's QA gate. With no independent evidence the landing is refused with the gate's reason.
    const withQa = await api(c, boot.token, "integration.set", { project, requiredChecks: ["tests", "review", "qa"] }, "req-qa");
    assert.equal(withQa.ok, true, JSON.stringify(withQa));
    const noQa = await land("land-qa");
    assert.equal(noQa.result?.state, "refused", JSON.stringify(noQa));
    const byCheck = (r: { checks: { results: { check: string; result: string; summary: string }[] } }) => Object.fromEntries(r.checks.results.map((x) => [x.check, x]));
    assert.deepEqual(Object.values(byCheck(noQa.result)).map((x) => [x.check, x.result]).sort(), [["qa", "not_run"], ["review", "pass"], ["tests", "pass"]]);
    assert.match(byCheck(noQa.result)["qa"]!.summary, /did not pass: no_evidence/, "the QA gate was read (not 'not collected')");
    assert.equal(readFileSync(join(shared, "src", "a.ts"), "utf8"), "export const a = 1;\n", "nothing was landed");
    // The owner's independent QA evidence on the submission, against the contract in force (version 2).
    const qa = await api(c, boot.token, "qa.evidence.record", { submissionId, criteriaRevision: 2, environment: "linux test", observedAt: "2026-11-18T10:00:00.000Z", checks: [{ name: "unit", result: "passed" }] }, "qa-1");
    assert.deepEqual([qa.ok, qa.result?.source], [true, "independent"], JSON.stringify(qa));
    // The project now also requires `docs` (fourth slice): a document that describes the task and was never verified against its tested code refuses the landing, named to the author; once the owner retires it (it is no
    // longer kept) the landing is made. The controller's landing gate reads the documents (read only: the refused landing flags nothing).
    assert.equal((await api(c, boot.token, "integration.set", { project, requiredChecks: ["tests", "review", "qa", "docs"] }, "req-docs")).ok, true);
    const doc = await api(c, boot.token, "doc.obligation.record", { projectId: project, title: "User guide", location: "docs/guide.md", audience: "user", owner: `agent:${agent}`, applicableVersion: "1.0", implementationRefs: [task] }, "doc-1");
    assert.equal(doc.ok, true, JSON.stringify(doc));
    const noDocs = await land("land-docs");
    assert.equal(noDocs.result?.state, "refused", JSON.stringify(noDocs));
    assert.deepEqual([byCheck(noDocs.result)["docs"]!.result, byCheck(noDocs.result)["qa"]!.result], ["fail", "pass"]);
    assert.match(byCheck(noDocs.result)["docs"]!.summary, /User guide \(it was never verified/, "the document gate was read (not 'not collected')");
    assert.equal(readFileSync(join(shared, "src", "a.ts"), "utf8"), "export const a = 1;\n", "nothing was landed");
    const retired = await api(c, boot.token, "doc.obligation.retire", { obligationId: doc.result.id, expectedRevision: doc.result.revision }, "doc-ret");
    assert.equal(retired.ok, true, JSON.stringify(retired));
    const landed = await land("land-2");
    assert.equal(landed.result.state, "done", JSON.stringify(landed.result));
    assert.equal(landed.result.detail.landed, true, landed.result.summary);
    assert.deepEqual([landed.result.checks.passed, landed.result.checks.tree, landed.result.checks.contractVersion], [true, sub.tree, 2]);
    assert.match(byCheck(landed.result)["review"]!.summary, /approved by agent:.* for this tree/);
    assert.deepEqual([byCheck(landed.result)["qa"]!.result, byCheck(landed.result)["qa"]!.summary], ["pass", "independent QA evidence passed for this tree"]);
    assert.equal(readFileSync(join(shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(byCheck(landed.result)["docs"]!.result, "pass");
    assert.equal(landingCheckCalls, 4, "the checks ran again for the second landing: an earlier result is never reused");
    assert.deepEqual([landed.result.queued?.submissionId, await queuedNow()], [submissionId, []], "the landing took exactly its submission out of the queue");
    for (const f of finishes) f();
    await c.dispatch.dispatcher.idle();
  } finally { for (const f of finishes) f(); await c.close(); await launcher.stop().catch(() => undefined); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
