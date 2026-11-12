import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AdmissionService, HostService, LocalWorker, ModelInterpreter, startController, type WorkerHost } from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces } from "@nimblenewt/worker";

// Card H12s, end to end through startController on SQLite and embedded PostgreSQL: the host builder hands the controller's `landingPolicy` to the production workspace port (LocalWorkspaces), and the owner sets the
// landing policy in free-form chat (through the real ModelInterpreter and a stand-in model that knows only what the system prompt tells it). A landing follows the owner's branch, permit and protected paths from the
// next landing on, a setting that cannot be read refuses the landing, only the owner may write the installation layer, and a stale revision is refused.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
let pgServer: Promise<harness.TestServer> | undefined;
const pg = (): Promise<harness.TestServer> => (pgServer ??= harness.startTestServer());
after(async () => { if (pgServer !== undefined) await (await pgServer).stop(); });

type Meaning = { readonly set: string; readonly value: unknown } | { readonly agree: true } | { readonly status: string };

/**
 * A stand-in for the model behind the real ModelInterpreter. For a setting it finds the landing template the system prompt describes (so the test fails when that paragraph is removed or no longer names the key),
 * fills in the key, the value and the owner's own words; for an agreement it uses the one open proposal the user prompt lists; for a question it asks the status kind the prompt lists. Which of these the owner
 * meant is the test's own table, standing in for the model's reading of free wording.
 */
function standIn(meaning: Record<string, Meaning>) {
  return { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    const meant = meaning[owner];
    if (meant === undefined) return JSON.stringify([{ kind: "none", reason: "not in the table" }]);
    if ("agree" in meant) {
      const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):/g)];
      return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: `${open.length} open proposals` }]);
    }
    if ("status" in meant) {
      if (!r.system.includes(`${meant.status}() - `)) return JSON.stringify([{ kind: "none", reason: "the prompt lists no such status kind" }]);
      return JSON.stringify([{ kind: "status", request: { kind: meant.status }, evidence: owner, basis: "owner" }]);
    }
    const template = /\{"kind":"policy_edit","change":\{"type":"setting","layer":"installation","key":<(workspace\.landing\.[^>]*)>,"value":<the value>\},"evidence":<their words, copied exactly>,"basis":"owner"\}/.exec(r.system);
    if (template === null || !template[1]!.split("|").includes(meant.set)) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
    return `[${template[0].replace(`<${template[1]}>`, JSON.stringify(meant.set)).replace("<the value>", JSON.stringify(meant.value)).replace("<their words, copied exactly>", JSON.stringify(owner))}]`;
  } };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(`the owner's chat-set landing policy reaches the product host builder: a landing follows the branch, the permit and the protected paths from the next landing on, and an unreadable setting refuses it (${backend}, card H12s)`, { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "nn-h12s-"));
    const shared = join(dir, "shared");
    await mkdir(join(shared, "src"), { recursive: true }); await mkdir(join(shared, "docs"), { recursive: true });
    sh(dir, "init", "-q", "-b", "main", shared);
    await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, "docs", "guide.md"), "# Guide\n");
    sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
    sh(shared, "checkout", "-q", "-b", "integration");
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    let local: LocalWorker | undefined;
    let ws: LocalWorkspaces | undefined;
    const finishes: (() => void)[] = [];
    const turns: Promise<void>[] = [];
    const meaning: Record<string, Meaning> = {};
    const storage = backend === "postgres" ? { kind: "postgres", url: (await pg()).url(), schema: `h12s_${process.pid}_${Math.random().toString(36).slice(2, 7)}` } : { kind: "sqlite", path: join(dir, "c.sqlite") };
    const c = await startController({
      storage, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [harness.PI],
      chat: { interpreter: new ModelInterpreter(standIn(meaning), () => ["test/model"]) },
      dispatch: {
        manual: true,
        route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
        local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined,
          // The product way to build the host: the workspace port takes the controller's landing policy, nothing else names a branch.
          build: (services: { readonly landingPolicy: NonNullable<ConstructorParameters<typeof LocalWorkspaces>[0]["landing"]> }) => {
            ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: () => shared, busy: () => local?.busyAttempts() ?? [], landing: services.landingPolicy });
            local = new LocalWorker({
              hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
              workspace: ws.port,
              sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
              runtimes: { open: async () => {
                let started!: () => void; turns.push(new Promise<void>((ok) => { started = ok; }));
                let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.push(finish);
                return { run: async () => { started(); await over; return { status: "completed", text: "done", endKind: "normal" }; }, checkpoint: async () => ({}), tell: async () => undefined, close: async () => undefined };
              } },
            });
            return local as WorkerHost;
          },
        },
      },
    } as never);
    try {
      assert.ok(c.dispatch !== undefined, c.dispatchProblem);
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const owner = await c.services.principals.authenticate(boot.token);
      const projectId = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
      await c.services.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
      const self = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 1, memoryMb: 1024 } });
      await local!.register(HostService.withEpoch(c.storage, c.epoch, c.services.assignments), self);
      let n = 0;
      /** A running attempt of a new task whose checkout holds one commit with `files`. */
      const running = async (files: Record<string, string>) => {
        n++;
        const agent = `agt-${String.fromCharCode(96 + n).repeat(20)}`;
        await c.services.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: agent, grants: harness.workGrants(projectId, ["read-file"]) });
        const task = (await c.services.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId, title: `Dig ${n}` })).id;
        await c.services.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
        await c.services.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
        const a = (await c.services.assignments.getAssignment(task))!;
        const attempt = (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: a.owner!, harness: "pi" })).id;
        const made = await ws!.ensure({ taskId: task, projectId });
        const g = ["--git-dir", made.gitDir, "--work-tree", made.checkout];
        for (const [path, text] of Object.entries(files)) await writeFile(join(made.checkout, path), text);
        sh(made.checkout, ...g, "add", "-A"); sh(made.checkout, ...g, "commit", "-q", "-m", "agent work");
        assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [attempt]);
        await turns[n - 1];
        return task;
      };
      let k = 0;
      // A landing is made under the project's integrator lease on the branch the owner's policy names (card P10): the integrator holds one for that branch, taken afresh when the owner moves the branch. Nothing is held while no branch is set.
      // The holder is a real, active agent (the owner can name only one of those).
      const integrator = "integrator";
      await c.services.principals.enroll(await c.services.principals.authenticate(boot.token), { commandId: "enroll-integrator", kind: "agent", name: integrator, grants: [] });
      let leased = 0;
      const leaseNow = async (task: string): Promise<{ leaseId?: string; fence?: number }> => {
        const key = "workspace.landing.branch";
        const branch = (await c.services.configuration.installationValues([key]))[key];
        if (typeof branch !== "string") return {};
        const items = (await api(c, boot.token, "integrator.lease.list", { projectId })).result.items as { leaseId: string; fence: number; branch: string; live: boolean; holder: string }[];
        let l = items.find((x) => x.branch === branch && x.live && x.holder === integrator);
        if (l === undefined) {
          if (items.some((x) => x.branch === branch && x.live)) await api(c, boot.token, "integrator.lease.release", { projectId, branch }, `unlease-${leased++}`);
          const taken = await api(c, boot.token, "integrator.lease.acquire", { taskId: task, branch, ttlMs: 3_600_000, holder: integrator }, `lease-${leased++}`);
          assert.equal(taken.ok, true, JSON.stringify(taken));
          l = taken.result.item;
        }
        return { leaseId: l!.leaseId, fence: l!.fence };
      };
      const land = async (task: string, lease?: { leaseId?: string; fence?: number }) => api(c, boot.token, "workspace.request", { operation: "landing", taskId: task, reason: "reviewed and ready", ...(lease ?? (await leaseNow(task))) }, `land-${k++}`);
      const sharedState = (): string => [sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1")].join("|");
      let m = 0;
      const say = async (text: string, meant: Meaning) => { meaning[text] = meant; return c.chat!.submit(boot.token, { messageId: `m${m++}`, text }) as unknown as Promise<{ outcomes: any[]; reply: string[] }>; };
      /** The owner says it in their own words, is shown the change first, and agrees. */
      const setInChat = async (wording: string, key: string, value: unknown) => {
        const shown = await say(wording, { set: key, value });
        assert.equal(shown.outcomes.length, 1, JSON.stringify(shown));
        assert.equal(shown.outcomes[0].status, "proposed", `a setting is shown first: ${JSON.stringify(shown)}`);
        assert.notEqual(JSON.stringify((await c.services.configuration.installationValues([key]))[key]), JSON.stringify(value), "nothing applies before the owner agrees");
        const done = await say(`Yes, apply that (${m}).`, { agree: true });
        assert.equal(done.outcomes.length, 1, JSON.stringify(done));
        assert.equal(done.outcomes[0].status, "applied", JSON.stringify(done));
      };
      const lookAtLanding = async (): Promise<string> => {
        const r = await say(`How is landing set up right now? (${m})`, { status: "landing" });
        return r.reply.join("\n");
      };

      // ---- nothing set: no branch is guessed, even though the shared tree is on one -------------------------------------------------------------
      const A = await running({ "src/a.ts": "export const a = 2; // the agent's work\n" });
      const before = sharedState();
      const unset = await land(A);
      assert.equal(unset.ok, false, JSON.stringify(unset));
      assert.equal(unset.error?.code, "invalid_command", "the controller refuses before the host is asked: with no landing branch there is no lease to show");
      assert.match(unset.error!.message, /integrator lease/);
      assert.equal(sharedState(), before);
      assert.match(await lookAtLanding(), /Landing branch: none set, so nothing lands until you name one/);

      // ---- the owner names the branch in chat; the permit is still required by default -------------------------------------------------------------
      await setInChat("Land finished work on the integration branch please.", "workspace.landing.branch", "integration");
      const permitless = await land(A);
      assert.equal(permitless.result.state, "refused", JSON.stringify(permitless));
      assert.match(permitless.result.summary, /do not carry the commit permit/, "the branch now counts; the permit is the next check");
      assert.equal(sharedState(), before);

      // Only the owner may turn the permit off: a config.write holder can neither write the installation layer nor turn it off for the task, and a stale revision is refused.
      const writerName = `agt-${"w".repeat(20)}`;
      await c.services.principals.enroll(owner, { commandId: "e-writer", kind: "agent", name: writerName, grants: [{ action: "config.write", project: "*" }] as never });
      const writer = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, `agent:${writerName}`)).token);
      await assert.rejects(c.services.configuration.stage(writer, { commandId: "w-inst", layer: "installation", set: { "workspace.landing.requirePermit": false } } as never), /only the owner/);
      await assert.rejects(c.services.configuration.stage(writer, { commandId: "w-task", layer: "task", scopeId: A, set: { "workspace.landing.requirePermit": false } } as never), (e: Error) => /requirePermit/.test(e.message), "a task layer cannot widen the permit");
      await assert.rejects(c.services.configuration.stage(writer, { commandId: "w-branch", layer: "task", scopeId: A, set: { "workspace.landing.branch": "elsewhere" } } as never), /only be set for the whole installation/);
      const inst = (await c.services.configuration.layer(owner, "installation"))!;
      assert.equal((await land(A)).result.state, "refused", "none of that changed the policy");

      await setInChat("Let finished work land without the review permit from now on.", "workspace.landing.requirePermit", false);
      // The revision read before that edit is stale now: a change written against it is refused, whoever writes it.
      await assert.rejects(c.services.configuration.stage(owner, { commandId: "o-stale", layer: "installation", expectedRevision: inst.revision, set: { "workspace.landing.requirePermit": true } } as never), (e: Error & { code?: string }) => e.code === "stale_revision", "a stale revision is refused");
      assert.equal(await c.services.configuration.installationValue("workspace.landing.requirePermit"), false);
      const landed = await land(A);
      assert.equal(landed.result.state, "done", JSON.stringify(landed));
      assert.equal(landed.result.detail.landed, true);
      assert.equal(await readFile(join(shared, "src", "a.ts"), "utf8"), "export const a = 2; // the agent's work\n");
      sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "integrator commits the landed file");
      for (const f of finishes) f();
      await c.dispatch.dispatcher.idle();

      // ---- the owner protects docs/ in chat: the next landing keeps it for review and writes nothing ---------------------------------------------------
      await setInChat("Never let a landing touch docs/ without me.", "workspace.landing.protectedPaths", ["docs/"]);
      const view = await lookAtLanding();
      assert.match(view, /Landing branch: "?integration"? \(you set it\)/);
      assert.match(view, /Review permit: not required \(you set it\)/);
      assert.match(view, /Built-in protected files .*: kept for your review \(the default\)/);
      assert.match(view, /Your extra protected paths, kept for your review: "?docs\/"?/);
      const B = await running({ "src/a.ts": "export const a = 3;\n", "docs/guide.md": "# Guide, rewritten by the agent\n" });
      const beforeB = sharedState();
      const held = await land(B);
      assert.equal(held.result.state, "done", JSON.stringify(held));
      assert.equal(held.result.detail.written, 0, JSON.stringify(held));
      assert.equal(held.result.detail.landed, false);
      assert.match(held.result.summary, /kept for review \(1 protected/);
      assert.equal(sharedState(), beforeB, "a landing is all or nothing");

      // ---- the owner moves the branch in chat: the next landing goes by it --------------------------------------------------------------------------
      await setInChat("Land on main from now on.", "workspace.landing.branch", "main");
      const moved = await land(B);
      assert.equal(moved.result.state, "refused", JSON.stringify(moved));
      assert.match(moved.result.summary, /not on the landing branch "main"/);

      // ---- settings that cannot be read: the landing is refused (nothing guessed), and the view says so -------------------------------------------------
      const leaseMain = await leaseNow(B);
      const cfg = c.services.configuration as unknown as Record<string, unknown>;
      const kept = { taskValues: cfg.taskValues, installationValues: cfg.installationValues, installationSettings: cfg.installationSettings };
      const broken = async () => { throw new Error("the settings store is unreadable"); };
      Object.assign(cfg, { taskValues: broken, installationValues: broken, installationSettings: broken });
      try {
        const unreadable = await land(B, leaseMain);
        assert.equal(unreadable.ok, false, JSON.stringify(unreadable));
        assert.equal(unreadable.error?.code, "unavailable", JSON.stringify(unreadable));
        assert.match(unreadable.error!.message, /could not be read/, "an unreadable policy is said as such, not as an unset branch");
        assert.match(await lookAtLanding(), /cannot be read right now, so every landing is refused/);
      } finally { Object.assign(cfg, kept); }
      assert.match((await land(B)).result.summary, /not on the landing branch "main"/, "readable again: the owner's policy applies again");
      assert.equal(sharedState(), beforeB);

      // ---- one more protected folder in plain words: the full new list keeps docs/ (it is in force) and the new folder is the owner's (card H12s third review) ----------
      await setInChat("Also keep the scripts folder for my review.", "workspace.landing.protectedPaths", ["docs/", "scripts/"]);
      assert.match(await lookAtLanding(), /Your extra protected paths, kept for your review: "?docs\/"?, "?scripts\/"?\./);
      // A list that leaves paths out names each one before the owner agrees (here it is left unanswered).
      const narrowing = await say("Only protect ci/ from now on.", { set: "workspace.landing.protectedPaths", value: ["ci/"] });
      assert.equal(narrowing.outcomes[0].status, "proposed", JSON.stringify(narrowing));
      assert.match(narrowing.reply.join("\n"), /these 2 entries are no longer in it: "docs\/", "scripts\/"/, narrowing.reply.join("\n"));
      for (const f of finishes) f();
      await c.dispatch.dispatcher.idle();
    } finally { for (const f of finishes) f(); await c.close(); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}
