import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ToolResult } from "./ports.js";
import { createTargetVersions } from "./target-versions.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";

after(stopServer);

const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld, repo: string) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      const repo = mkdtempSync(join(tmpdir(), "nn-tvf-"));
      dirs.push(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "one");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "one");
      try { await body(await buildWorld(store.storage), repo); } finally { await store.close(); }
    });

  /** A call on `target` that the policy sends to the owner; the controller's real reading (the checkout bound to the task's project) binds the review. */
  const scenario = async (c: DispatchWorld, repo: string, target: { kind: string; id: string }) => {
    const ann = await c.agent("ann", workGrants(c.project, ["git-push"]));
    await c.resources.bindResource(c.owner, { commandId: "bind", projectId: c.project, kind: "repository", label: "main", locator: repo, repositoryId: "repo1", access: "read" } as never);
    await c.task("push", ann, { repositoryId: "repo1" });
    const applied = { n: 0 };
    const go = deferred();
    const parked = deferred<ToolResult>();
    let again: ToolResult | undefined;
    const call = (gateway: { call(r: never, e: never): Promise<ToolResult> }) => gateway.call({ callId: "push1", tool: { name: "git-push", version: "2.0" }, args: { branch: "main" }, target } as never, { kind: "effect", effectKind: "git-push", target: "repo", input: {}, bridge: { idempotent: false, execute: async () => { applied.n++; return { receipt: "r" }; }, reconcile: async () => ({ state: (applied.n > 0 ? "applied" : "not_applied") as "applied" | "not_applied" }) } } as never);
    c.worker.script = async ({ gateway }) => { parked.resolve(await call(gateway as never)); await go.promise; again = await call(gateway as never); return { status: "completed", text: "x" }; };
    const d = c.restart({ targetVersion: createTargetVersions({ storage: c.storage, location: (id) => c.resources.checkoutLocation(id) }) });
    await d.tick();
    const first = await parked.promise;
    assert.equal(first.state, "awaiting-approval");
    const review = (await c.reviews.get(c.owner, (first as { reviewId: string }).reviewId))!;
    await c.reviews.decide(c.owner, { commandId: "dec", requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "ok" });
    return { review, applied, finish: async () => { go.resolve(); await d.idle(); return again; } };
  };

  suite("card A05b follow-up: an approval of a call on a file runs it once when the file is as reviewed, and the reviewer was shown the file's digest", async (c, repo) => {
    const s = await scenario(c, repo, { kind: "file", id: "a.txt" });
    assert.equal(s.review.operation.target.version, sha("one"));
    const result = await s.finish();
    assert.equal(result?.state, "confirmed");
    assert.equal(s.applied.n, 1);
  });

  for (const [what, change] of [["changed", (repo: string) => writeFileSync(join(repo, "a.txt"), "two")], ["removed", (repo: string) => unlinkSync(join(repo, "a.txt"))], ["swapped for a link out of the checkout", (repo: string) => { unlinkSync(join(repo, "a.txt")); symlinkSync("/etc/hostname", join(repo, "a.txt")); }]] as const) {
    suite(`card A05b follow-up: a file ${what} after the approval is not run`, async (c, repo) => {
      const s = await scenario(c, repo, { kind: "file", id: "a.txt" });
      change(repo);
      const result = await s.finish();
      assert.equal(result?.state, "refused");
      assert.equal(s.applied.n, 0, "nothing ran");
    });
  }

  suite("card A05b follow-up: an approval of a call on a branch is not used once the branch has moved", async (c, repo) => {
    const s = await scenario(c, repo, { kind: "branch", id: "main" });
    assert.equal(s.review.operation.target.version, git(repo, "rev-parse", "HEAD"));
    writeFileSync(join(repo, "a.txt"), "two");
    git(repo, "commit", "-q", "-am", "two");
    const result = await s.finish();
    assert.equal(result?.state, "refused");
    assert.match(JSON.stringify(result), /the target's version changed/);
    assert.equal(s.applied.n, 0);
  });

  suite("card A05b follow-up: a branch that is not there yet is reviewed as absent and is not run once it exists", async (c, repo) => {
    const s = await scenario(c, repo, { kind: "branch", id: "feature/new" });
    assert.equal(s.review.operation.target.version, "absent");
    git(repo, "branch", "feature/new");
    const result = await s.finish();
    assert.equal(result?.state, "refused");
    assert.equal(s.applied.n, 0);
  });
}
