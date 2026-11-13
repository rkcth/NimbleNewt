import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces, WipBackupHost, WorkspaceError, httpsOrigin, httpsTokenEnv, isSshRemote, redactEnv, sshAgentEnv, wipPushEnv } from "./index.js";

// Card P02b, the product wiring: the credential seam (fake secrets made at run time, never a real one), a restore through the local host's own layout, and the host's message cleaning. Real git, disposable folders, a loopback fake server.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const fake = (label: string): string => `${label}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
const scan = (file: { path: string; bytes: Buffer }): string | undefined => (file.bytes.toString("utf8").includes("PLANTED-SECRET") ? "holds a credential" : undefined);
const detail = (r: { ok: boolean }): { readonly [key: string]: unknown } => (r as unknown as { detail: { [key: string]: unknown } }).detail;
const REF = "refs/heads/nn-wip/prj-one/tsk-one";

test("the https seam builds one scoped header from a secret the host resolved; ssh uses the agent only; a missing or misplaced secret fails by name; every value is redacted from messages", async () => {
  const token = fake("tok");
  const env = httpsTokenEnv("https://git.example.com:8443/me/wip.git", token);
  assert.deepEqual(Object.keys(env).sort(), ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
  assert.equal(env["GIT_CONFIG_KEY_0"], "http.https://git.example.com:8443/.extraHeader", "scoped to the remote's own origin");
  assert.equal(env["GIT_CONFIG_VALUE_0"], `Authorization: Basic ${Buffer.from(`git:${token}`).toString("base64")}`);
  assert.equal(httpsTokenEnv("https://git.example.com/a.git", "bob:pw-123456")["GIT_CONFIG_VALUE_0"], `Authorization: Basic ${Buffer.from("bob:pw-123456").toString("base64")}`, "user:password is taken as given");
  assert.throws(() => httpsTokenEnv("ssh://git@example.com/a.git", token), /only for an https remote/);
  assert.throws(() => httpsTokenEnv("/a/folder.git", token), /only for an https remote/);
  assert.throws(() => httpsTokenEnv("https://u:p@git.example.com/a.git", token), /only for an https remote/, "an address with a login in it is not one");
  assert.throws(() => httpsTokenEnv("https://git.example.com/a.git", "a\nb"), /control character/);
  assert.equal(httpsOrigin("https://git.example.com/x/y.git"), "https://git.example.com/");
  assert.deepEqual([isSshRemote("git@example.com:me/wip.git"), isSshRemote("ssh://git@example.com/x.git"), isSshRemote("https://example.com/x.git"), isSshRemote("/a/b.git"), isSshRemote("C:\\repos\\wip.git")], [true, true, false, false, false]);
  const agent = fake("sock");
  assert.deepEqual(sshAgentEnv({ SSH_AUTH_SOCK: agent }), { GIT_SSH_COMMAND: "ssh -o BatchMode=yes", SSH_AUTH_SOCK: agent });
  assert.deepEqual(sshAgentEnv({}), { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });

  const asked: string[] = [];
  const push = wipPushEnv({ secret: async (name) => { asked.push(name); return name === "garden-token" ? token : undefined; }, env: { SSH_AUTH_SOCK: agent } });
  assert.deepEqual(await push({ remote: "/backups/garden.git" }), {});
  assert.deepEqual(await push({ remote: "https://git.example.com/a.git" }), {}, "an https remote with no named secret gets nothing extra");
  assert.equal((await push({ remote: "https://git.example.com/a.git", credential: "garden-token" }))["GIT_CONFIG_COUNT"], "1");
  assert.deepEqual(asked, ["garden-token"], "the secret is read only when a call names it");
  assert.equal((await push({ remote: "git@example.com:me/wip.git" }))["SSH_AUTH_SOCK"], agent);
  await assert.rejects(push({ remote: "git@example.com:me/wip.git", credential: "garden-token" }), /uses the host's ssh agent/);
  await assert.rejects(push({ remote: "https://git.example.com/a.git", credential: "absent-name" }), (e: Error) => /secret named absent-name is not in the secret store/.test(e.message) && !e.message.includes(token));
  await assert.rejects(push({ remote: "/a/folder.git", credential: "garden-token" }), /only for an https remote/);

  const shown = redactEnv(`fatal: could not read ${token} or ${env["GIT_CONFIG_VALUE_0"]!.replace("Authorization: Basic ", "")} at ${env["GIT_CONFIG_VALUE_0"]}`, env);
  assert.ok(!shown.includes(token) && !shown.includes(Buffer.from(`git:${token}`).toString("base64")), shown);
});

test("the host cleans the secret out of what git said, and a credential that cannot be prepared fails the call with a plain reason and pushes nothing", { skip }, async () => {
  const token = fake("tok");
  const leaky = { backupWip: async () => { throw new WorkspaceError("unavailable", `the push to the backup remote failed: remote said ${token}`); }, restoreWip: async () => { throw new WorkspaceError("unavailable", `could not fetch ${token}`); } };
  const where = { shared: "/s", checkout: "/c", gitDir: "/g", bridgeState: "/b", quarantineRoot: "/q" };
  const target = { checkout: "/c2", gitDir: "/g2", finish: async () => "x", abandon: async () => undefined };
  const host = new WipBackupHost({ git: leaky as never, locate: () => where, scan, pushEnv: async () => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://h/.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${token}` }), restoreTarget: () => target });
  const call = { projectId: "prj-one", taskId: "tsk-one", remote: "https://h/x.git", ref: REF, developer: "agent:ann", executor: "host:local" };
  const r = await host.backup(call);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(token), JSON.stringify(r));
  const q = await host.restore({ projectId: "prj-one", taskId: "tsk-one", remote: "https://h/x.git", ref: REF, expectCommit: "a".repeat(40) });
  assert.equal(q.ok, false);
  assert.ok(!JSON.stringify(q).includes(token), JSON.stringify(q));
  let pushed = 0;
  const failing = new WipBackupHost({ git: { backupWip: async () => { pushed++; return {}; } } as never, locate: () => where, scan, pushEnv: async () => { throw new Error(`no ${token}`.replace(token, "secret named x is not in the secret store")); } });
  const f = await failing.backup(call);
  assert.deepEqual([f.ok, pushed], [false, 0]);
  assert.match((f as { reason: string }).reason, /credential could not be prepared: no secret named x/);
  assert.deepEqual(await new WipBackupHost({ git: leaky as never, locate: () => where, scan }).restore({ projectId: "prj-one", taskId: "tsk-one", remote: "/r", ref: REF, expectCommit: "a".repeat(40) }), { ok: false, reason: "this host does not restore work-in-progress backups" });
});

test("git sends the scoped header from the environment to the remote it names, and a failed push carries none of it", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-wipcred-"));
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res) => { seen.push({ path: req.url ?? "", authorization: req.headers.authorization }); res.statusCode = 404; res.end("nothing here"); });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}/`;
    const shared = join(dir, "shared"); await mkdir(shared, { recursive: true });
    sh(dir, "init", "-q", "-b", "main", shared); await writeFile(join(shared, "a.txt"), "a\n"); sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "one");
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    const where = { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: join(dir, "state"), quarantineRoot: join(dir, "q") };
    await git.createCheckout({ shared, commit: await git.head(shared), gitDir: where.gitDir, checkout: where.checkout });
    await writeFile(join(where.checkout, "b.txt"), "b\n");
    const token = fake("tok");
    // The same key syntax the seam builds (`http.<origin>.extraHeader`), over plain http so no certificate is needed; the https leg against a real server is the owner's first trial.
    const host = new WipBackupHost({ git, locate: () => where, scan, pushEnv: async ({ credential }) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${origin}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`git:${credential}`).toString("base64")}` }) });
    const r = await host.backup({ projectId: "prj-one", taskId: "tsk-one", remote: `${origin}wip.git`, ref: REF, developer: "agent:ann", executor: "host:local", credential: token });
    assert.equal(r.ok, false);
    assert.ok(seen.length > 0, "git reached the fake server");
    assert.ok(seen.every((s) => s.authorization === `Basic ${Buffer.from(`git:${token}`).toString("base64")}`), JSON.stringify(seen));
    assert.ok(!JSON.stringify(r).includes(token) && !JSON.stringify(r).includes(Buffer.from(`git:${token}`).toString("base64")), "the failure says nothing of the credential");
    assert.equal(sh(where.gitDir, "for-each-ref", "refs/nn/wip-last"), "", "a failed push is never counted");
    // Without a credential nothing is sent.
    seen.length = 0;
    const bare = new WipBackupHost({ git, locate: () => where, scan });
    assert.equal((await bare.backup({ projectId: "prj-one", taskId: "tsk-one", remote: `${origin}wip.git`, ref: REF, developer: "agent:ann", executor: "host:local" })).ok, false);
    assert.ok(seen.length > 0 && seen.every((s) => s.authorization === undefined));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test("a restore through the local layout: a lost task folder comes back as the task's own checkout and the next backup carries on; a folder still there is never written over; a wrong or foreign branch restores nothing", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-wiprestore-"));
  try {
    const shared = join(dir, "shared"); await mkdir(join(shared, "src"), { recursive: true });
    sh(dir, "init", "-q", "-b", "main", shared); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "one");
    const remote = join(dir, "remote.git"); sh(dir, "init", "-q", "--bare", "-b", "main", remote);
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    const root = join(dir, "work");
    const ws = new LocalWorkspaces({ root, git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }) });
    const host = ws.wipHost({ scan });
    const made = await ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    assert.equal(ws.holds({ taskId: "tsk-one", projectId: "prj-one" }), true);
    assert.equal(ws.holds({ taskId: "tsk-two", projectId: "prj-one" }), false);
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(made.checkout, "work.txt"), "unfinished\n");
    await writeFile(join(made.checkout, "secret.txt"), "PLANTED-SECRET\n");
    const base = { projectId: "prj-one", taskId: "tsk-one", remote, ref: REF, developer: "agent:ann", executor: "host:local" };
    const pushed = await host.backup(base);
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    const commit = detail(pushed)["commitId"] as string;

    // A folder still there is never written over: the restore goes to a new folder nothing uses.
    const beside = await host.restore({ ...base, expectCommit: commit });
    assert.equal(beside.ok, true, JSON.stringify(beside));
    const where = detail(beside)["where"] as string;
    assert.match(where, /new folder/);
    const sides = await readdir(join(root, "restored", "prj-one"));
    assert.equal(sides.length, 1);
    assert.equal(await readFile(join(root, "restored", "prj-one", sides[0]!, "checkout", "work.txt"), "utf8"), "unfinished\n");
    assert.equal(existsSync(join(root, "restored", "prj-one", sides[0]!, "checkout", "secret.txt")), false, "a file the scan left out is not in the backup");
    assert.equal(await readFile(join(made.checkout, "work.txt"), "utf8"), "unfinished\n", "the live checkout was not touched");
    assert.equal(existsSync(join(root, "restored", "prj-one", sides[0]!, "complete")), false, "a side folder is never taken for the task's checkout");

    // The wrong commit and a branch that is not one of ours restore nothing, and leave nothing behind.
    const wrong = await host.restore({ ...base, expectCommit: "f".repeat(40) });
    assert.equal(wrong.ok, false);
    assert.match((wrong as { reason: string }).reason, /not the last backup the controller confirmed/);
    sh(remote, "update-ref", "refs/heads/nn-wip/prj-one/foreign", sh(remote, "commit-tree", "-m", "someone else", sh(remote, "rev-parse", `${REF}^{tree}`)));
    const foreign = await host.restore({ ...base, ref: "refs/heads/nn-wip/prj-one/foreign", expectCommit: sh(remote, "rev-parse", "refs/heads/nn-wip/prj-one/foreign") });
    assert.equal(foreign.ok, false);
    assert.match((foreign as { reason: string }).reason, /does not hold a NimbleNewt work-in-progress commit/);
    assert.deepEqual(await readdir(join(root, "restored", "prj-one")), sides, "a failed restore leaves no folder");
    assert.deepEqual(await readdir(join(root, ".making")), [], "nor a half-made task folder");

    // The task's disk is lost: the restore becomes the task's own checkout, and the work is the backed-up work.
    await rm(join(root, "prj-one", "tsk-one"), { recursive: true, force: true });
    assert.equal(ws.holds({ taskId: "tsk-one", projectId: "prj-one" }), false);
    const back = await host.restore({ ...base, expectCommit: commit });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.match(detail(back)["where"] as string, /task's own checkout/);
    const found = ws.locate({ taskId: "tsk-one", projectId: "prj-one" })!;
    assert.ok(found !== undefined);
    assert.equal(await readFile(join(found.checkout, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(await readFile(join(found.checkout, "work.txt"), "utf8"), "unfinished\n");
    assert.match(await git.diffStat({ gitDir: found.gitDir, checkout: found.checkout }), /2 files? changed|work\.txt/, "the restored work shows as changes against the old base");
    // The task goes on: the next backup builds on the restored one (a fast-forward, not a refused first commit), and an unchanged checkout is only confirmed.
    const same = await host.backup(base);
    assert.equal(same.ok, true, JSON.stringify(same));
    assert.equal(detail(same)["unchanged"], true);
    await writeFile(join(found.checkout, "work.txt"), "unfinished, then more\n");
    const next = await host.backup(base);
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(sh(remote, "rev-parse", `${REF}^`), commit, "the new backup sits on the restored one");
    // No shared repository for a project: a lost task cannot be restored where it could not go on.
    const lonely = await host.restore({ ...base, projectId: "prj-none", ref: "refs/heads/nn-wip/prj-none/tsk-one", expectCommit: commit });
    assert.equal(lonely.ok, false);
    assert.match((lonely as { reason: string }).reason, /no shared repository/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
