import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { StorageError } from "../storage/errors.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ProjectPlanService, ProjectResourceService, ResponsibilityService, relativePath, scopeAllows } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    owner: Principal;
    projects: ProjectService; resources: ProjectResourceService; plans: ProjectPlanService; duties: ResponsibilityService;
    /** Moves the injected clock. */
    setNow(iso: string): void;
    agent(name: string, grants: Grant[]): Promise<Principal>;
    project(name: string): Promise<string>;
    task(projectId: string, title: string, extra?: Record<string, unknown>): Promise<string>;
    bind(by: Principal, projectId: string, extra: Record<string, unknown>): Promise<{ id: string; revision: number; replayed: boolean }>;
    auditCount(): Promise<number>;
    reopen(): { resources: ProjectResourceService; duties: ResponsibilityService };
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = "2026-10-22T10:00:00.000Z";
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const resources = ProjectResourceService.withEpoch(world.storage, projects.epoch, options);
        const plans = ProjectPlanService.withEpoch(world.storage, projects.epoch, options);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const agent = async (nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        await body({
          owner, projects, resources, plans, duties, agent,
          setNow: (iso) => { now = iso; },
          project: async (nm) => (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: nm })).id,
          task: async (projectId, title, extra = {}) => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId, title, ...extra } as never)).id,
          bind: (by, projectId, extra) => resources.bindResource(by, { commandId: cid("b"), projectId, kind: "repository", label: "x", locator: "/x", ...extra } as never),
          auditCount: async () => (await world.storage.listAudit({ afterSeq: 0, limit: 1000 })).length,
          reopen: () => ({ resources: ProjectResourceService.withEpoch(world.storage, projects.epoch, options), duties: ResponsibilityService.withEpoch(world.storage, projects.epoch, options) }),
        });
      } finally { await world.close(); }
    });
  const rights = (p: string, ...actions: string[]): Grant[] => actions.map((action) => ({ action, project: p }));

  // ---- resources --------------------------------------------------------------------------------------------------------------

  suite("a project starts with no repository, then binds two repositories and a non-code output; the repositories are listed for tasks, and a bind is applied once", async ({ owner, projects, resources, project, task, bind }) => {
    const p = await project("Launch");
    assert.deepEqual((await projects.getProject(p))!.repositories, [], "a project needs no repository");
    const first = await bind(owner, p, { label: "Web app", locator: "/work/web", repositoryId: "web" });
    const second = await bind(owner, p, { label: "Api", locator: "/work/api" });
    const out = await bind(owner, p, { kind: "output", label: "Launch brief", locator: "docs/launch-brief.md" });
    const shown = (await projects.getProject(p))!;
    assert.deepEqual(shown.repositories.map((r) => [r.id, r.location]), [["web", "/work/web"], ["api", "/work/api"]], "the handle defaults to the label; non-code outputs are not repositories");
    const bound = (await resources.list(owner, p))!;
    assert.deepEqual(bound.map((r) => r.kind).sort(), ["output", "repository", "repository"]);
    assert.ok(bound.every((r) => r.state === "bound" && r.scope.mode === "read" && r.locatorEpoch === 1), "read access by default");
    // a task may name a bound repository (S01), a non-code task names none
    await task(p, "fix it", { repositoryId: "web" });
    await task(p, "write the brief");
    // the same command again applies once, with the first result
    const command = { commandId: "bind-once", projectId: p, kind: "repository", label: "Docs", locator: "/work/docs" } as never;
    const a = await resources.bindResource(owner, command);
    const b = await resources.bindResource(owner, command);
    assert.deepEqual([a.id, a.revision, a.replayed, b.id, b.revision, b.replayed], [a.id, 1, false, a.id, 1, true]);
    assert.equal((await resources.list(owner, p))!.length, 4);
    await refuses("command_conflict", () => resources.bindResource(owner, { ...(command as object), locator: "/elsewhere" } as never));
    assert.ok(first.id !== second.id && second.id !== out.id);
  });

  suite("binding refuses duplicates, bad input, credentials, archived projects and a handle that disagrees with the project's list", async ({ owner, projects, resources, project, bind }) => {
    const p = await project("P");
    await bind(owner, p, { label: "Main", locator: "/r/main", repositoryId: "main" });
    await refuses("invalid_command", () => bind(owner, p, { label: "main", locator: "/r/other", repositoryId: "other" }), (e) => assert.equal(e.field, "label"));
    await refuses("invalid_command", () => bind(owner, p, { label: "Second", locator: "/r/second", repositoryId: "main" }), (e) => assert.equal(e.field, "repositoryId"));
    await refuses("invalid_command", () => bind(owner, p, { kind: "output", label: "Out", locator: "/o", repositoryId: "main" }), (e) => assert.equal(e.field, "repositoryId"));
    await refuses("invalid_command", () => bind(owner, p, { kind: "robot", label: "Out", locator: "/o" }), (e) => assert.equal(e.field, "kind"));
    await refuses("invalid_command", () => bind(owner, p, { label: "Key", locator: "https://user:hunter2hunter2@example.com/r.git" }), (e) => assert.equal(e.field, "locator"));
    await refuses("invalid_command", () => bind(owner, p, { label: "Key2", locator: "/r/x", note: "x" }), (e) => assert.match(e.field ?? "", /note/));
    await refuses("invalid_command", () => bind(owner, p, { label: "Bad", locator: "/r/bad", paths: ["../etc"] }), (e) => assert.match(e.field ?? "", /paths/));
    await refuses("invalid_command", () => bind(owner, p, { label: "!!!", locator: "/r/bad" }), (e) => assert.equal(e.field, "repositoryId"));
    // a repository the project already lists (S01) is bound only at the same location
    await projects.updateProject({ commandId: cid("u"), actor: owner.id, projectId: p, expectedRevision: (await projects.getProject(p))!.revision, addRepositories: [{ id: "legacy", location: "/r/legacy" }] });
    await refuses("invalid_command", () => bind(owner, p, { label: "Legacy", locator: "/r/legacy-moved", repositoryId: "legacy" }));
    const ok = await bind(owner, p, { label: "Legacy", locator: "/r/legacy", repositoryId: "legacy" });
    assert.equal((await resources.get(owner, ok.id))!.repositoryId, "legacy");
    assert.equal((await projects.getProject(p))!.repositories.filter((r) => r.id === "legacy").length, 1, "listed once");
    const archived = await project("Old");
    await projects.updateProject({ commandId: cid("u"), actor: owner.id, projectId: archived, expectedRevision: 1, state: "archived" });
    await refuses("invalid_command", () => bind(owner, archived, { label: "A", locator: "/a" }));
    await refuses("not_found", async () => { const r = await resources.list(owner, "proj-aaaaaaaaaaaaaaaaaaaa"); if (r === undefined) throw new DomainError("not_found", "x"); });
  });

  suite("simultaneous binds cannot both take one label or one repository handle", async ({ owner, resources, project }) => {
    const p = await project("P");
    const results = await Promise.allSettled([1, 2, 3].map((i) => resources.bindResource(owner, { commandId: cid(`race${i}`), projectId: p, kind: "repository", label: "Same", locator: `/r/${i}`, repositoryId: `h${i}` } as never)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one wins");
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && ["stale_revision", "invalid_command", "command_conflict"].includes(r.reason.code), String(r.reason));
    assert.equal((await resources.list(owner, p))!.length, 1);
    // outputs touch no project record, so only the registry serializes them
    const q = await project("Q");
    const outs = await Promise.allSettled([1, 2, 3, 4].map((i) => resources.bindResource(owner, { commandId: cid(`out${i}`), projectId: q, kind: "output", label: "Brief", locator: `docs/brief-${i}.md` } as never)));
    assert.equal(outs.filter((r) => r.status === "fulfilled").length, 1, "exactly one output takes the label");
    assert.equal((await resources.list(owner, q))!.filter((r) => r.label === "Brief").length, 1);
  });

  suite("a move needs resource.scope.write when the binding is writable or unlimited; a read-limited one may be moved with resource.write", async ({ owner, resources, project, agent }) => {
    const p = await project("P");
    const lead = await agent("lead", rights(p, "resource.read", "resource.write"));
    const boss = await agent("boss", rights(p, "resource.read", "resource.write", "resource.scope.write"));
    const sandbox = await resources.bindResource(boss, { commandId: cid("b"), projectId: p, kind: "repository", label: "sandbox", locator: "/r/sandbox", access: "write", paths: ["tmp"] } as never);
    const open = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "document", label: "all", locator: "/r/all" } as never);
    const narrow = await resources.bindResource(lead, { commandId: cid("b"), projectId: p, kind: "document", label: "narrow", locator: "/r/narrow", paths: ["a"] } as never);
    await refuses("forbidden", () => resources.moveResource(lead, { commandId: cid("mv"), resourceId: sandbox.id, expectedRevision: 1, locator: "/r/production" }));
    await refuses("forbidden", () => resources.moveResource(lead, { commandId: cid("mv"), resourceId: sandbox.id, expectedRevision: 1, locator: "/" }));
    await refuses("forbidden", () => resources.moveResource(lead, { commandId: cid("mv"), resourceId: open.id, expectedRevision: 1, locator: "/r/elsewhere" }), undefined);
    await resources.moveResource(lead, { commandId: cid("mv"), resourceId: narrow.id, expectedRevision: 1, locator: "/r/narrow2" });
    await resources.moveResource(boss, { commandId: cid("mv"), resourceId: sandbox.id, expectedRevision: 1, locator: "/r/sandbox2" });
    assert.equal((await resources.get(owner, sandbox.id))!.locator, "/r/sandbox2");
  });

  suite("a location that contains or lies inside another project's binding is refused unless acknowledged by someone who may give scopes; the same location is fine", async ({ owner, resources, project, agent }) => {
    const a = await project("A");
    const b = await project("B");
    await resources.bindResource(owner, { commandId: cid("b"), projectId: a, kind: "repository", label: "mono", locator: "/work/mono" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "repository", label: "same", locator: "/work/mono/" } as never);
    for (const l of ["/work", "/work/mono/pkg/x", "/", "\\WORK\\Mono\\pkg"]) await refuses("invalid_command", () => resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "output", label: `o${l.length}`, locator: l } as never), (e) => assert.equal(e.field, "locator"));
    await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "output", label: "ok", locator: "/work/mono/pkg", acknowledgeOverlap: true } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "output", label: "elsewhere", locator: "/work/monorepo" } as never);
    const lead = await agent("lead", rights(b, "resource.read", "resource.write"));
    await refuses("forbidden", () => resources.bindResource(lead, { commandId: cid("b"), projectId: b, kind: "output", label: "ack", locator: "/work/mono/z", acknowledgeOverlap: true } as never));
    const mover = await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "output", label: "mv", locator: "/elsewhere/x" } as never);
    await refuses("invalid_command", () => resources.moveResource(owner, { commandId: cid("mv"), resourceId: mover.id, expectedRevision: 1, locator: "/work/mono/inner" }), (e) => assert.equal(e.field, "locator"));
    await resources.moveResource(owner, { commandId: cid("mv"), resourceId: mover.id, expectedRevision: 1, locator: "/work/mono/inner", acknowledgeOverlap: true });
  });

  suite("the overlap guard sees through spelling: ./, //, file://, drive-letter case and UNC forms, and refuses .. and percent-escaped separators", async ({ owner, resources, project }) => {
    const a = await project("A");
    const b = await project("B");
    await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "repository", label: "shared", locator: "/r/shared/a" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "repository", label: "win", locator: "C:\\R\\Work" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "repository", label: "unc", locator: "\\\\Host\\Share\\Dir" } as never);
    const attempt = (locator: string, label: string) => resources.bindResource(owner, { commandId: cid("b"), projectId: a, kind: "output", label, locator } as never);
    let i = 0;
    for (const l of ["/r/./shared", "/r//shared", "/r/shared/", "file:///r/shared", "FILE:///R/Shared", "/R/SHARED", "c:/r", "c:/r/work/x", "C:\\R", "//host/share", "\\\\host\\share", "file://host/share", "//host/share/dir/deeper"]) {
      await refuses("invalid_command", () => attempt(l, `o${i++}`), (e) => assert.equal(e.field, "locator", l));
    }
    for (const l of ["/r/x/../shared", "/r/shared/..", "..\\r", "/r/%2Fshared", "/r/%2fshared", "/r%5Cshared", "/r/%2e%2e/shared"]) {
      await refuses("invalid_command", () => attempt(l, `o${i++}`), (e) => assert.equal(e.field, "locator", l));
    }
    await attempt("/r/shared2", "fine");
    await attempt("/r/./shared/a", "equal");
    assert.equal(relativePath("a/100%"), undefined);
  });

  suite("a default repository handle steps aside for a used one, and an unbind is refused while an unfinished task is dispatched against the binding", async ({ owner, projects, resources, project, task }) => {
    const p = await project("P");
    const one = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "App", locator: "/r/app" } as never);
    const t = await task(p, "T", { repositoryId: "app" });
    await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t });
    await refuses("invalid_command", () => resources.unbindResource(owner, { commandId: cid("ub"), resourceId: one.id, expectedRevision: 1 }), (e) => assert.ok(e.message.includes(t)));
    await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: t, expectedRevision: 1, to: "ready" });
    await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: t, expectedRevision: 2, to: "in_progress" });
    await refuses("invalid_command", () => resources.unbindResource(owner, { commandId: cid("ub"), resourceId: one.id, expectedRevision: 1 }));
    await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: t, expectedRevision: 3, to: "done" });
    await resources.unbindResource(owner, { commandId: cid("ub"), resourceId: one.id, expectedRevision: 1 });
    const again = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "App", locator: "/r/app" } as never);
    assert.equal((await resources.get(owner, again.id))!.repositoryId, "app-2");
    // a new dispatch of a task naming the old, unbound handle is refused
    const later = await task(p, "later", { repositoryId: "app" });
    await refuses("invalid_command", () => resources.pinCheckout(owner, { commandId: cid("pin"), taskId: later }), (e) => assert.equal(e.field, "repositoryId"));
  });

  suite("internal state stays outside the target repositories: binding, moving, scoping and dispatching write nothing into them, and the services never touch the file system", async ({ owner, projects, resources, project, task }) => {
    const dir = mkdtempSync(join(tmpdir(), "nn-p01-"));
    try {
      const p = await project("P");
      const { id } = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "Checkout", locator: dir, repositoryId: "co" } as never);
      const t = await task(p, "T", { repositoryId: "co" });
      await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t });
      await resources.setScope(owner, { commandId: cid("s"), resourceId: id, expectedRevision: 1, access: "write", paths: ["src"] });
      assert.deepEqual(readdirSync(dir), [], "nothing was created in the repository");
      assert.equal((await projects.getProject(p))!.repositories[0]!.location, dir);
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    // the compiled services import no file-system module
    const folder = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["common.js", "resources.js", "plan.js", "responsibilities.js"]) {
      const source = readFileSync(join(folder, file), "utf8");
      assert.ok(!/node:fs|"fs"|node:child_process/.test(source), `${file} touches no files`);
    }
  });

  suite("one repository bound to two projects has two bindings with separate access scopes", async ({ owner, resources, project, agent }) => {
    const a = await project("A");
    const b = await project("B");
    const ra = await resources.bindResource(owner, { commandId: cid("b"), projectId: a, kind: "repository", label: "Shared", locator: "/r/shared", repositoryId: "shared" } as never);
    const rb = await resources.bindResource(owner, { commandId: cid("b"), projectId: b, kind: "repository", label: "Shared", locator: "/r/shared", repositoryId: "shared", access: "write", paths: ["src", "docs/"] } as never);
    assert.notEqual(ra.id, rb.id);
    assert.deepEqual(await resources.authorizeUse(owner, ra.id, { mode: "read" }), { allowed: true });
    assert.equal((await resources.authorizeUse(owner, ra.id, { mode: "write" }))!.allowed, false, "A reads only");
    assert.equal((await resources.authorizeUse(owner, rb.id, { mode: "write", path: "src/lib/x.ts" }))!.allowed, true);
    assert.equal((await resources.authorizeUse(owner, rb.id, { mode: "write", path: "docs/a.md" }))!.allowed, true, "a trailing slash in the scope does not matter");
    assert.equal((await resources.authorizeUse(owner, rb.id, { mode: "write", path: "srcx/a" }))!.allowed, false, "a sibling with the same prefix is outside");
    assert.equal((await resources.authorizeUse(owner, rb.id, { mode: "read", path: "secrets/k" }))!.allowed, false);
    assert.equal((await resources.authorizeUse(owner, rb.id, { mode: "read" }))!.allowed, false, "the whole resource is not a path below the limit");
    assert.equal((await resources.authorizeUse(owner, rb.id, { mode: "read", path: "src/../secrets" }))!.allowed, false, "no escaping the scope with '..'");
    // changing one binding's scope leaves the other alone
    await resources.setScope(owner, { commandId: cid("s"), resourceId: rb.id, expectedRevision: 1, access: "read", paths: ["src"] });
    assert.equal((await resources.get(owner, ra.id))!.scope.mode, "read");
    assert.equal((await resources.get(owner, ra.id))!.revision, 1);
    // an agent of A sees A's binding, not B's (which looks like a missing one)
    const ann = await agent("ann", rights(a, "resource.read"));
    assert.ok(await resources.get(ann, ra.id));
    assert.equal(await resources.get(ann, rb.id), undefined);
    assert.equal(await resources.list(ann, b), undefined);
    assert.equal(await resources.authorizeUse(ann, rb.id, { mode: "read", path: "src/x" }), undefined);
    // path rules
    assert.equal(relativePath("a\\b/./c"), undefined);
    assert.equal(relativePath("a\\b/c"), "a/b/c");
    assert.equal(relativePath("/abs"), undefined);
    assert.equal(relativePath("C:\\x"), undefined);
    assert.equal(relativePath("a/b::$DATA"), undefined);
    assert.equal(relativePath("trail. "), undefined);
    for (const bad of ["../x", "../b/secrets", "/etc/passwd", "C:\\x", "a/../../x"]) {
      assert.equal(scopeAllows({ mode: "write", paths: [] }, { mode: "write", path: bad }), false, `an unlimited scope still refuses ${bad}`);
      assert.equal(scopeAllows({ mode: "read", paths: [] }, { mode: "read", path: bad }), false);
    }
    assert.equal(scopeAllows({ mode: "read", paths: [] }, { mode: "read", path: "docs/a.md" }), true);
    assert.equal(scopeAllows({ mode: "read", paths: [] }, { mode: "read" }), true);
  });

  suite("write access and widening need resource.scope.write; narrowing and ordinary binding need only resource.write; nothing without a grant", async ({ owner, resources, project, agent }) => {
    const p = await project("P");
    const other = await project("Q");
    const lead = await agent("lead", rights(p, "resource.read", "resource.write"));
    const boss = await agent("boss", rights(p, "resource.read", "resource.write", "resource.scope.write"));
    const nobody = await agent("nobody", rights(other, "resource.read", "resource.write"));
    await refuses("forbidden", () => resources.bindResource(nobody, { commandId: cid("b"), projectId: p, kind: "repository", label: "R", locator: "/r" } as never));
    await refuses("forbidden", () => resources.bindResource(lead, { commandId: cid("b"), projectId: p, kind: "repository", label: "W", locator: "/w", access: "write" } as never));
    const read = await resources.bindResource(lead, { commandId: cid("b"), projectId: p, kind: "document", label: "Doc", locator: "doc", paths: ["a"] } as never);
    await refuses("forbidden", () => resources.setScope(lead, { commandId: cid("s"), resourceId: read.id, expectedRevision: 1, access: "write", paths: ["a"] }));
    await refuses("forbidden", () => resources.setScope(lead, { commandId: cid("s"), resourceId: read.id, expectedRevision: 1, access: "read" }), undefined);
    await refuses("forbidden", () => resources.setScope(lead, { commandId: cid("s"), resourceId: read.id, expectedRevision: 1, access: "read", paths: ["b"] }));
    const narrowed = await resources.setScope(lead, { commandId: cid("s"), resourceId: read.id, expectedRevision: 1, access: "read", paths: ["a/b"] });
    assert.equal(narrowed.revision, 2);
    await resources.setScope(boss, { commandId: cid("s"), resourceId: read.id, expectedRevision: 2, access: "write", paths: ["a/b"] });
    await refuses("stale_revision", () => resources.setScope(boss, { commandId: cid("s"), resourceId: read.id, expectedRevision: 2, access: "read", paths: ["a/b"] }), (e) => assert.equal(e.currentRevision, 3));
    // another project's agent cannot even tell the binding exists
    await refuses("forbidden", () => resources.setScope(nobody, { commandId: cid("s"), resourceId: read.id, expectedRevision: 3, access: "read", paths: ["a/b"] }), (e) => assert.ok(!e.message.includes(p)));
    await refuses("forbidden", () => resources.setScope(nobody, { commandId: cid("s"), resourceId: "rsc-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 1, access: "read" }));
  });

  // ---- task checkouts ---------------------------------------------------------------------------------------------------------

  suite("a moved checkout does not redirect a dispatched task, and a same-named checkout does not capture it", async ({ owner, projects, resources, project, task, agent }) => {
    const p = await project("P");
    const app = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "app", locator: "/old/app", repositoryId: "app" } as never);
    const t = await task(p, "dispatched", { repositoryId: "app" });
    const later = await task(p, "not yet dispatched", { repositoryId: "app" });
    assert.equal((await resources.resolveCheckout(owner, t))!.locator, "/old/app");
    assert.equal((await resources.resolveCheckout(owner, t))!.pinned, false);
    const pin = await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t });
    assert.equal((await resources.resolveCheckout(owner, t))!.pinned, true);
    await refuses("invalid_command", () => resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t }));
    // the location moves: the dispatched task refuses, the undispatched one follows the record
    await resources.moveResource(owner, { commandId: cid("mv"), resourceId: app.id, expectedRevision: 1, locator: "/new/app" });
    await refuses("checkout_changed", () => resources.resolveCheckout(owner, t));
    assert.equal((await resources.resolveCheckout(owner, later))!.locator, "/new/app");
    assert.equal((await projects.getProject(p))!.repositories[0]!.location, "/new/app", "the project's list follows the move");
    // an agent holding the task also gets the refusal
    const ann = await agent("ann", rights(p, "resource.read", "task.read"));
    await refuses("checkout_changed", () => resources.resolveCheckout(ann, t));
    // confirming it (the pin's revision) resolves to the new place, once
    const again = await resources.repinCheckout(owner, { commandId: cid("repin"), taskId: t, expectedRevision: pin.revision });
    assert.equal(again.revision, pin.revision + 1);
    assert.equal((await resources.resolveCheckout(owner, t))!.locator, "/new/app");
    await refuses("stale_revision", () => resources.repinCheckout(owner, { commandId: cid("repin"), taskId: t, expectedRevision: pin.revision }));
    // unbind the repository and bind another one with the same label and the old location: the task is not captured by it
    await refuses("invalid_command", () => resources.unbindResource(owner, { commandId: cid("ub"), resourceId: app.id, expectedRevision: 2 }), (e) => assert.ok(e.message.includes(t), "names the task"));
    await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: t, expectedRevision: 1, to: "cancelled" });
    await resources.unbindResource(owner, { commandId: cid("ub"), resourceId: app.id, expectedRevision: 2 });
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "app", locator: "/new/app", repositoryId: "app-2" } as never);
    await refuses("checkout_changed", () => resources.resolveCheckout(owner, t), (e) => assert.match(e.message, /unbound/));
    await refuses("invalid_command", () => resources.resolveCheckout(owner, later), (e) => assert.match(e.message, /not bound/));
    await refuses("invalid_command", () => resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "app again", locator: "/x", repositoryId: "app" } as never), (e) => assert.equal(e.field, "repositoryId"));
  });

  suite("a task pointed at another repository after dispatch is refused until confirmed; a task with no repository has no checkout; the same location in another project captures nothing", async ({ owner, projects, resources, project, task }) => {
    const p = await project("P");
    const q = await project("Q");
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "one", locator: "/r/one", repositoryId: "one" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "two", locator: "/r/two", repositoryId: "two" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: q, kind: "repository", label: "one", locator: "/r/two", repositoryId: "one" } as never);
    const t = await task(p, "T", { repositoryId: "one" });
    const pin = await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t });
    await projects.updateTask({ commandId: cid("u"), actor: owner.id, taskId: t, expectedRevision: 1, repositoryId: "two" });
    await refuses("checkout_changed", () => resources.resolveCheckout(owner, t));
    await projects.updateTask({ commandId: cid("u"), actor: owner.id, taskId: t, expectedRevision: 2, repositoryId: null });
    await refuses("checkout_changed", () => resources.resolveCheckout(owner, t));
    await projects.updateTask({ commandId: cid("u"), actor: owner.id, taskId: t, expectedRevision: 3, repositoryId: "two" });
    await resources.repinCheckout(owner, { commandId: cid("repin"), taskId: t, expectedRevision: pin.revision });
    const got = (await resources.resolveCheckout(owner, t))!;
    assert.equal(got.locator, "/r/two");
    assert.equal(got.projectId, p, "it resolves inside its own project, never to Q's binding at the same location");
    const none = await task(p, "no repo");
    await refuses("invalid_command", () => resources.resolveCheckout(owner, none), (e) => assert.equal(e.field, "repositoryId"));
    await refuses("invalid_command", () => resources.pinCheckout(owner, { commandId: cid("pin"), taskId: none }));
    assert.equal(await resources.resolveCheckout(owner, "task-aaaaaaaaaaaaaaaaaaaa"), undefined);
  });

  suite("a pin whose repository was cleared is released (not while the task names one), holds nothing afterwards, and the task is pinned afresh if it names a repository again (card P01b)", async ({ owner, projects, resources, project, task }) => {
    const p = await project("P");
    const bound = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "one", locator: "/r/one", repositoryId: "one" } as never);
    const t = await task(p, "T", { repositoryId: "one" });
    await resources.dispatchCheckout({ commandId: "dpa-pin:fixed", taskId: t, actor: "dispatcher", pin: true });
    const pin = { revision: (await resources.getPin(owner, t) as unknown as { revision: number }).revision };
    await refuses("invalid_command", () => resources.releaseCheckout(owner, { commandId: cid("rel"), taskId: t, expectedRevision: pin.revision }), (e) => assert.match(e.message, /still names/));
    await projects.updateTask({ commandId: cid("u"), actor: owner.id, taskId: t, expectedRevision: 1, repositoryId: null });
    await refuses("stale_revision", () => resources.releaseCheckout(owner, { commandId: cid("rel"), taskId: t, expectedRevision: pin.revision + 5 }));
    const released = await resources.releaseCheckout(owner, { commandId: cid("rel"), taskId: t, expectedRevision: pin.revision });
    assert.equal(released.revision, pin.revision + 1);
    await refuses("invalid_command", () => resources.releaseCheckout(owner, { commandId: cid("rel2"), taskId: t, expectedRevision: released.revision }), (e) => assert.match(e.message, /no checkout/));
    // Released: the binding is no longer held by it, and the task needs no repository.
    assert.equal((await resources.dispatchCheckout({ commandId: cid("d"), taskId: t, actor: "dispatcher", pin: false })).kind, "none");
    await resources.unbindResource(owner, { commandId: cid("ub"), resourceId: bound.id, expectedRevision: (await resources.list(owner, p))![0]!.revision } as never);
    await resources.bindResource(owner, { commandId: cid("b2"), projectId: p, kind: "repository", label: "two", locator: "/r/one2", repositoryId: "two" } as never);
    await projects.updateTask({ commandId: cid("u"), actor: owner.id, taskId: t, expectedRevision: 2, repositoryId: "two" });
    // The dispatcher uses one fixed command ID per task: pinning again after a release must not be answered with the first pin's result.
    const again = await resources.dispatchCheckout({ commandId: "dpa-pin:fixed", taskId: t, actor: "dispatcher", pin: true });
    assert.equal(again.kind, "ok");
    assert.equal((await resources.getPin(owner, t))!.pinnedBy, "dispatcher", "pinned afresh, not answered from the first pin's command");
    assert.equal((await resources.getPin(owner, t) as unknown as { released?: unknown }).released, undefined);
    assert.equal((await resources.resolveCheckout(owner, t))!.locator, "/r/one2");
  });

  suite("a project's lookups read its own bindings: the read of one project does not look through another's, and past the limit it is refused as unavailable, not answered from part (card P01b)", async ({ owner, resources, project }) => {
    const p = await project("P");
    const q = await project("Q");
    for (let i = 0; i < 4; i++) await resources.bindResource(owner, { commandId: cid("b"), projectId: q, kind: "output", label: `q${i}`, locator: `/q/${i}` } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "p0", locator: "/p/0" } as never);
    const tight = ProjectResourceService.withEpoch(resources.runner.storage, resources.runner.epoch, { scanLimit: 2, clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined });
    // Q has four bindings, more than the limit; P's own lookups are not held up by them (the overlap check on a new binding still looks across projects, and says so when it cannot).
    assert.equal((await tight.list(owner, p))!.length, 1);
    await refuses("unavailable", () => tight.list(owner, q));
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "p1", locator: "/p/1" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "p2", locator: "/p/2" } as never);
    await refuses("unavailable", () => tight.list(owner, p));
    assert.equal((await resources.list(owner, p))!.length, 3);
  });

  const T = "2026-10-22T10:00:00.000Z";
  const raw = (resources: ProjectResourceService, changes: unknown[]) => resources.runner.storage.applyOperation({
    operationId: cid("raw"), epoch: resources.runner.epoch, actor: "test", correlationId: cid("raw"), at: T,
    changes: changes as never, audit: [{ type: "raw", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  });

  suite("the overlap check reads one record per project, not every binding: past the limit in bindings it still works, and moves and unbinds keep it right (card P01c)", async ({ owner, resources, project }) => {
    const p = await project("P");
    const q = await project("Q");
    for (let i = 0; i < 4; i++) await resources.bindResource(owner, { commandId: cid("b"), projectId: q, kind: "output", label: `q${i}`, locator: `/q/${i}` } as never);
    const tight = ProjectResourceService.withEpoch(resources.runner.storage, resources.runner.epoch, { scanLimit: 2, clock: () => T, pause: async () => undefined });
    // Q has four bindings (more than the limit of 2): the old check read all of them and was unavailable; now it reads Q's one registry.
    const ok = await tight.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "p0", locator: "/p/0" } as never);
    await refuses("invalid_command", () => tight.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "in", locator: "/q/2/inside" } as never), (e) => assert.match(e.message, /another project/));
    await refuses("invalid_command", () => tight.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "up", locator: "/q" } as never), (e) => assert.match(e.message, /another project/));
    // A move updates the list: Q's binding moved away no longer clashes, and its new place does.
    const q0 = (await resources.list(owner, q))!.find((r) => r.label === "q0")!;
    await resources.moveResource(owner, { commandId: cid("mv"), resourceId: q0.id, expectedRevision: q0.revision, locator: "/elsewhere/0" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "old-place", locator: "/q/0/x" } as never);
    await refuses("invalid_command", () => resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "new-place", locator: "/elsewhere/0/x" } as never));
    // An unbound binding stops clashing.
    const moved = (await resources.get(owner, q0.id))!;
    await resources.unbindResource(owner, { commandId: cid("ub"), resourceId: q0.id, expectedRevision: moved.revision } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "free", locator: "/elsewhere/0/x" } as never);
    // The same place is allowed (equal is not nested) and an acknowledged overlap needs the scope right.
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "same", locator: "/q/1" } as never);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "ack", locator: "/q/1/deep", acknowledgeOverlap: true } as never);
    assert.ok(ok.id);
  });

  suite("a project whose registry was made before bound locations were listed is read from its bindings, and gets the list at its next change (card P01c)", async ({ owner, resources, project }) => {
    const p = await project("P");
    const q = await project("Q");
    const first = await resources.bindResource(owner, { commandId: cid("b"), projectId: q, kind: "output", label: "q0", locator: "/q/0" } as never);
    // Strip the location list from the registry, as a registry written by the earlier version would be.
    const reg = (await resources.runner.storage.getAggregate({ kind: "resource-registry", id: q }))!;
    const { locs: _locs, ...legacy } = reg.body as { locs?: unknown };
    await raw(resources, [{ type: "update", ref: { kind: "resource-registry", id: q }, expectedRevision: reg.revision, body: legacy }]);
    await refuses("invalid_command", () => resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "in", locator: "/q/0/in" } as never));
    // The next change to Q lists its locations.
    await resources.bindResource(owner, { commandId: cid("b"), projectId: q, kind: "output", label: "q1", locator: "/q/1" } as never);
    const after = (await resources.runner.storage.getAggregate({ kind: "resource-registry", id: q }))!.body as { locs?: Record<string, string> };
    assert.deepEqual(Object.values(after.locs!).sort(), ["/q/0", "/q/1"]);
    assert.ok(first.id);
  });

  suite("ending a binding reads its own pin list: tasks that finished do not hold it, a repin or release moves the pin, and a binding without a list gets one marked as possibly incomplete at its first pin, and ending it still looks through the checkouts (card P01c)", async ({ owner, resources, projects, project, task }) => {
    const p = await project("P");
    const a = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "a", locator: "/r/a", repositoryId: "a" } as never);
    const b = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "b", locator: "/r/b", repositoryId: "b" } as never);
    const t1 = await task(p, "one", { repositoryId: "a" });
    const t2 = await task(p, "two", { repositoryId: "a" });
    await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t1 });
    await resources.dispatchCheckout({ commandId: "dp:t2", taskId: t2, actor: "dispatcher", pin: true });
    const pins = async (id: string) => ((await resources.runner.storage.getAggregate({ kind: "resource-pins", id }))!.body as { tasks: string[] }).tasks;
    assert.deepEqual((await pins(a.id)).sort(), [t1, t2].sort());
    await refuses("invalid_command", () => resources.unbindResource(owner, { commandId: cid("ub"), resourceId: a.id, expectedRevision: a.revision } as never), (e) => assert.match(e.message, /tasks still work/));
    // Pointing t1 at the other repository and confirming it moves the pin between the lists.
    await projects.updateTask({ commandId: cid("u"), actor: owner.id, taskId: t1, expectedRevision: (await projects.getTask(t1))!.revision, repositoryId: "b" } as never);
    const pin1 = (await resources.getPin(owner, t1))!;
    await resources.repinCheckout(owner, { commandId: cid("rp"), taskId: t1, expectedRevision: pin1.revision });
    assert.deepEqual(await pins(a.id), [t2]);
    assert.deepEqual(await pins(b.id), [t1]);
    // A finished task does not hold the binding.
    const t2rec = (await projects.getTask(t2))!;
    await projects.transitionTask({ commandId: cid("c"), actor: owner.id, taskId: t2, expectedRevision: t2rec.revision, to: "cancelled" });
    const afterCancel = (await resources.get(owner, a.id))!;
    await resources.unbindResource(owner, { commandId: cid("ub"), resourceId: a.id, expectedRevision: afterCancel.revision } as never);
    // A release removes the task from its list.
    await projects.updateTask({ commandId: cid("u"), actor: owner.id, taskId: t1, expectedRevision: (await projects.getTask(t1))!.revision, repositoryId: null } as never);
    const pin2 = (await resources.getPin(owner, t1))!;
    await resources.releaseCheckout(owner, { commandId: cid("rel"), taskId: t1, expectedRevision: pin2.revision });
    assert.deepEqual(await pins(b.id), []);
    // A binding made before pin lists existed (a store that neither reads nor writes them): no list; ending it looks through the checkouts, and the first pin starts a list marked `legacy` without looking.
    const storage = resources.runner.storage;
    const earlier = new Proxy(storage, { get: (target, key) => {
      if (key === "getAggregate") return (ref: { kind: string; id: string }) => (ref.kind === "resource-pins" ? Promise.resolve(undefined) : target.getAggregate(ref as never));
      if (key === "applyOperation") return (input: { changes: { ref: { kind: string } }[] }) => target.applyOperation({ ...input, changes: input.changes.filter((c) => c.ref.kind !== "resource-pins") } as never);
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const old = ProjectResourceService.withEpoch(earlier, resources.runner.epoch, { clock: () => T, pause: async () => undefined });
    const c = await old.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "c", locator: "/r/c", repositoryId: "c" } as never);
    const t3 = await task(p, "three", { repositoryId: "c" });
    await old.pinCheckout(owner, { commandId: cid("pin"), taskId: t3 });
    assert.equal(await storage.getAggregate({ kind: "resource-pins", id: c.id }), undefined);
    await refuses("invalid_command", () => resources.unbindResource(owner, { commandId: cid("ub"), resourceId: c.id, expectedRevision: c.revision } as never), (e) => assert.match(e.message, /tasks still work/));
    const t4 = await task(p, "four", { repositoryId: "c" });
    await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t4 });
    // The pin itself does not look through the checkouts: its list starts marked as possibly incomplete, and ending the binding still finds t3.
    assert.deepEqual(await pins(c.id), [t4]);
    assert.equal(((await storage.getAggregate({ kind: "resource-pins", id: c.id }))!.body as { legacy?: boolean }).legacy, true);
    await refuses("invalid_command", () => resources.unbindResource(owner, { commandId: cid("ub"), resourceId: c.id, expectedRevision: c.revision } as never), (e) => assert.match(e.message, /tasks still work/));
  });

  suite("a pin that commits while a binding is being unbound is not lost: the unbind is refused and the binding stays bound (card P01c)", async ({ owner, resources, project, task }) => {
    const p = await project("P");
    const a = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "a", locator: "/r/a", repositoryId: "a" } as never);
    const t = await task(p, "one", { repositoryId: "a" });
    const storage = resources.runner.storage;
    let raced = false;
    const between = new Proxy(storage, { get: (target, key) => {
      if (key === "applyOperation") return async (input: { changes: { type: string; ref: { kind: string }; body?: { state?: string } }[] }) => {
        if (!raced && input.changes.some((c) => c.type === "update" && c.ref.kind === "project-resource" && c.body?.state === "unbound")) {
          raced = true;
          assert.equal((await resources.dispatchCheckout({ commandId: "dp:race", taskId: t, actor: "dispatcher", pin: true })).kind, "ok");
        }
        return target.applyOperation(input as never);
      };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const unbinder = ProjectResourceService.withEpoch(between, resources.runner.epoch, { clock: () => T, pause: async () => undefined });
    await assert.rejects(() => unbinder.unbindResource(owner, { commandId: cid("ub"), resourceId: a.id, expectedRevision: a.revision } as never), (e: unknown) => e instanceof DomainError);
    assert.equal(raced, true);
    assert.equal((await resources.get(owner, a.id))!.state, "bound", "a live task is pinned to it");
  });

  suite("a store fault during a pin is a fault, not a blocker: only the pin limit is answered with a reason (card P01c)", async ({ owner, resources, project, task }) => {
    const p = await project("P");
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "a", locator: "/r/a", repositoryId: "a" } as never);
    const t = await task(p, "one", { repositoryId: "a" });
    const broken = new Proxy(resources.runner.storage, { get: (target, key) => {
      if (key === "applyOperation") return async () => { throw new StorageError("unavailable", "connection refused"); };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const service = ProjectResourceService.withEpoch(broken, resources.runner.epoch, { clock: () => T, pause: async () => undefined });
    await assert.rejects(() => service.dispatchCheckout({ commandId: "dp:fault", taskId: t, actor: "dispatcher", pin: true }), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
  });

  suite("finished tasks are cleared from a pin list even when the scan limit is below the usual clearing size (card P01c)", async ({ owner, resources, projects, project, task }) => {
    const p = await project("P");
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "a", locator: "/r/a", repositoryId: "a" } as never);
    const tight = ProjectResourceService.withEpoch(resources.runner.storage, resources.runner.epoch, { scanLimit: 3, clock: () => T, pause: async () => undefined });
    for (let i = 0; i < 6; i++) {
      const t = await task(p, `t${i}`, { repositoryId: "a" });
      assert.equal((await tight.dispatchCheckout({ commandId: `dp:${i}`, taskId: t, actor: "dispatcher", pin: true })).kind, "ok", `pin ${i}`);
      await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: t, expectedRevision: (await projects.getTask(t))!.revision, to: "cancelled" });
    }
  });

  suite("a pin the scan limit forbids is a blocker, not a failure: the dispatcher's pin is answered with the reason (card P01c)", async ({ owner, resources, project, task }) => {
    const p = await project("P");
    const a = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "a", locator: "/r/a", repositoryId: "a" } as never);
    const tight = ProjectResourceService.withEpoch(resources.runner.storage, resources.runner.epoch, { scanLimit: 2, clock: () => T, pause: async () => undefined });
    for (let i = 0; i < 2; i++) await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: await task(p, `t${i}`, { repositoryId: "a" }) });
    const third = await task(p, "t3", { repositoryId: "a" });
    const answer = await tight.dispatchCheckout({ commandId: "dp:third", taskId: third, actor: "dispatcher", pin: true });
    assert.equal(answer.kind, "unbound");
    assert.match((answer as { reason: string }).reason, /too many to track safely/);
    assert.ok(a.id);
  });

  suite("dispatching needs assignment.manage on the task; reading a checkout needs the task and resource read rights and an outsider sees nothing", async ({ owner, resources, project, task, agent }) => {
    const p = await project("P");
    const q = await project("Q");
    await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "repository", label: "r", locator: "/r", repositoryId: "r" } as never);
    const t = await task(p, "T", { repositoryId: "r" });
    const reader = await agent("reader", rights(p, "resource.read", "task.read", "assignment.read"));
    const outsider = await agent("outsider", rights(q, "resource.read", "task.read", "assignment.manage", "assignment.read"));
    await refuses("forbidden", () => resources.pinCheckout(reader, { commandId: cid("pin"), taskId: t }));
    await refuses("forbidden", () => resources.pinCheckout(outsider, { commandId: cid("pin"), taskId: t }));
    await resources.pinCheckout(owner, { commandId: cid("pin"), taskId: t });
    assert.equal((await resources.resolveCheckout(reader, t))!.label, "r");
    assert.equal(await resources.resolveCheckout(outsider, t), undefined);
    assert.ok(await resources.getPin(reader, t));
    assert.equal(await resources.getPin(outsider, t), undefined);
    const noResource = await agent("blind", rights(p, "task.read"));
    assert.equal(await resources.resolveCheckout(noResource, t), undefined);
  });

  suite("a project's resources are never truncated: past the scan limit a check is refused rather than answered from part of the list", async ({ owner, resources, project }) => {
    const p = await project("P");
    for (let i = 0; i < 3; i++) await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: `o${i}`, locator: `/o/${i}` } as never);
    const tight = ProjectResourceService.withEpoch(resources.runner.storage, resources.runner.epoch, { scanLimit: 2, clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined });
    await refuses("unavailable", () => tight.list(owner, p));
    await refuses("unavailable", () => tight.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "output", label: "o9", locator: "/o/9" } as never));
    assert.equal((await resources.list(owner, p))!.length, 3);
  });

  // ---- the plan on the project record -----------------------------------------------------------------------------------------

  suite("workstreams, milestones, a due date and participants are optional fields of the project record; the other project commands keep them", async ({ owner, projects, plans, project, agent }) => {
    const p = await project("P");
    const ann = await agent("ann", []);
    const plain = (await projects.getProject(p))!;
    assert.equal(plain.dueDate, undefined);
    assert.equal(plain.workstreams, undefined);
    const set = await plans.setPlan(owner, {
      commandId: cid("plan"), projectId: p, expectedRevision: 1, dueDate: "2026-12-31",
      workstreams: [{ id: "build", name: "Build" }, { id: "docs", name: "Documentation", description: "user guide" }],
      milestones: [{ id: "alpha", name: "Alpha", dueDate: "2026-11-01", workstreamId: "build" }, { id: "ship", name: "Ship", dueDate: "2026-12-31T17:00:00Z" }],
      participants: [{ principalId: ann.id, role: "writer" }],
    });
    assert.equal(set.revision, 2);
    const got = (await projects.getProject(p))!;
    assert.equal(got.dueDate, "2026-12-31");
    assert.deepEqual(got.milestones!.map((m) => [m.id, m.state]), [["alpha", "open"], ["ship", "open"]]);
    assert.deepEqual(got.participants, [{ principalId: ann.id, role: "writer" }]);
    // S01 commands keep the planning fields
    await projects.updateProject({ commandId: cid("u"), actor: owner.id, projectId: p, expectedRevision: 2, name: "Renamed" });
    const kept = (await projects.getProject(p))!;
    assert.deepEqual([kept.name, kept.dueDate, kept.workstreams!.length, kept.participants!.length], ["Renamed", "2026-12-31", 2, 1]);
    // a field left out is kept; null clears the date; a repeat applies once
    const clear = { commandId: "clear-1", projectId: p, expectedRevision: 3, dueDate: null } as never;
    const c1 = await plans.setPlan(owner, clear);
    const c2 = await plans.setPlan(owner, clear);
    assert.deepEqual([c1.revision, c2.revision, c2.replayed], [4, 4, true]);
    const cleared = (await projects.getProject(p))!;
    assert.equal(cleared.dueDate, undefined);
    assert.equal(cleared.milestones!.length, 2);
    await refuses("stale_revision", () => plans.setPlan(owner, { commandId: cid("plan"), projectId: p, expectedRevision: 3, dueDate: "2027-01-01" }), (e) => assert.equal(e.currentRevision, 4));
  });

  suite("plan input is checked: real dates, unique IDs, known workstreams, active agents as participants, and at least one field", async ({ owner, plans, project, agent }) => {
    const p = await project("P");
    const ann = await agent("ann", []);
    const set = (extra: Record<string, unknown>, rev = 1) => plans.setPlan(owner, { commandId: cid("plan"), projectId: p, expectedRevision: rev, ...extra } as never);
    for (const bad of ["2026-02-30", "2026-13-01", "tomorrow", "2026-12-31T25:00:00Z", "2026-12-31T10:00:00+02:00", 20261231, ""]) await refuses("invalid_command", () => set({ dueDate: bad }), (e) => assert.equal(e.field, "dueDate"));
    await refuses("invalid_command", () => set({}));
    await refuses("invalid_command", () => set({ workstreams: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }), (e) => assert.match(e.field ?? "", /workstreams/));
    await refuses("invalid_command", () => set({ workstreams: [{ id: "A B", name: "A" }] }));
    await refuses("invalid_command", () => set({ milestones: [{ id: "m", name: "M", workstreamId: "nope" }] }), (e) => assert.match(e.field ?? "", /workstreamId/));
    await refuses("invalid_command", () => set({ milestones: [{ id: "m", name: "M", state: "late" }] }));
    await refuses("invalid_command", () => set({ milestones: [{ id: "m", name: "M", extra: 1 }] }));
    await refuses("invalid_command", () => set({ participants: [{ principalId: "owner:rob" }] }), (e) => assert.match(e.field ?? "", /participants/));
    await refuses("invalid_command", () => set({ participants: [{ principalId: "agent:nobody" }] }));
    await refuses("invalid_command", () => set({ participants: [{ principalId: ann.id }, { principalId: ann.id }] }));
    await set({ workstreams: [{ id: "w", name: "W" }], milestones: [{ id: "m", name: "M", workstreamId: "w" }] });
    // dropping a workstream a milestone names is refused
    await refuses("invalid_command", () => set({ workstreams: [] }, 2), (e) => assert.match(e.field ?? "", /workstreamId/));
  });

  suite("plan authority: the plan and the participant list are separate rights, and a project's agent cannot touch another project's plan", async ({ owner, plans, project, agent }) => {
    const p = await project("P");
    const q = await project("Q");
    const ann = await agent("ann", []);
    const planner = await agent("planner", rights(p, "project.read", "project.plan.write"));
    const hr = await agent("hr", rights(p, "project.read", "project.participants.write"));
    const stranger = await agent("stranger", rights(q, "project.read", "project.plan.write", "project.participants.write"));
    await plans.setPlan(planner, { commandId: cid("plan"), projectId: p, expectedRevision: 1, dueDate: "2026-12-31" });
    await refuses("forbidden", () => plans.setPlan(planner, { commandId: cid("plan"), projectId: p, expectedRevision: 2, participants: [{ principalId: ann.id }] }));
    await refuses("forbidden", () => plans.setPlan(hr, { commandId: cid("plan"), projectId: p, expectedRevision: 2, dueDate: "2027-01-01" }));
    await plans.setPlan(hr, { commandId: cid("plan"), projectId: p, expectedRevision: 2, participants: [{ principalId: ann.id }] });
    await refuses("forbidden", () => plans.setPlan(stranger, { commandId: cid("plan"), projectId: p, expectedRevision: 3, dueDate: "2027-01-01" }));
    assert.equal(await plans.isParticipant(p, ann.id), true);
    assert.equal(await plans.isParticipant(q, ann.id), false);
    assert.equal(await plans.schedule(stranger, p), undefined, "unreadable looks missing");
    // being a participant grants nothing
    await refuses("forbidden", () => plans.setPlan(ann, { commandId: cid("plan"), projectId: p, expectedRevision: 3, dueDate: "2027-01-01" }));
  });

  suite("passing a due date changes no progress state: the schedule reports overdue from the clock and writes nothing", async ({ owner, projects, plans, project, task, setNow, auditCount }) => {
    const p = await project("P");
    const t = await task(p, "open task");
    await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: t, expectedRevision: 1, to: "ready" });
    await plans.setPlan(owner, { commandId: cid("plan"), projectId: p, expectedRevision: 1, dueDate: "2026-11-01", milestones: [{ id: "m1", name: "First", dueDate: "2026-10-30" }, { id: "m2", name: "Second", dueDate: "2026-12-01" }, { id: "m3", name: "Done", dueDate: "2026-10-01", state: "reached" }] });
    const before = await plans.schedule(owner, p);
    assert.equal(before!.overdue, false);
    assert.deepEqual(before!.milestones.map((m) => m.overdue), [false, false, false]);
    const audits = await auditCount();
    const snapshot = JSON.stringify([await projects.getProject(p), await projects.getTask(t)]);
    setNow("2026-11-15T00:00:00.000Z");
    const after = await plans.schedule(owner, p);
    assert.equal(after!.overdue, true);
    assert.deepEqual(after!.milestones.map((m) => [m.id, m.state, m.overdue]), [["m1", "open", true], ["m2", "open", false], ["m3", "reached", false]], "a reached milestone is never overdue");
    setNow("2027-06-01T00:00:00.000Z");
    assert.equal((await plans.schedule(owner, p))!.milestones.every((m) => m.state === "reached" || m.overdue), true);
    assert.equal(await auditCount(), audits, "reading the schedule wrote nothing");
    assert.equal(JSON.stringify([await projects.getProject(p), await projects.getTask(t)]), snapshot, "project and task are exactly as they were (revisions, states, timestamps)");
    // a day-only date falls due at the end of that day
    setNow("2026-11-01T23:00:00.000Z");
    await plans.setPlan(owner, { commandId: cid("plan"), projectId: p, expectedRevision: 2, milestones: [{ id: "d", name: "D", dueDate: "2026-11-01" }] });
    assert.equal((await plans.schedule(owner, p))!.milestones[0]!.overdue, false);
    setNow("2026-11-02T00:00:00.000Z");
    assert.equal((await plans.schedule(owner, p))!.milestones[0]!.overdue, true);
    // only an explicit command reaches a milestone
    await plans.setPlan(owner, { commandId: cid("plan"), projectId: p, expectedRevision: 3, milestones: [{ id: "d", name: "D", dueDate: "2026-11-01", state: "reached" }] });
    assert.equal((await plans.schedule(owner, p))!.milestones[0]!.overdue, false);
  });

  // ---- responsibilities -------------------------------------------------------------------------------------------------------

  suite("an ongoing responsibility lives in a project with no repository, keeps its history, and a check is a bounded entry linked to its task", async ({ owner, projects, resources, duties, project, task, agent }) => {
    const p = await project("Operations");
    assert.deepEqual((await projects.getProject(p))!.repositories, []);
    const ops = await agent("ops", rights(p, "responsibility.read"));
    const svc = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Web server", locator: "https://example.test/health" } as never);
    const r = await duties.create(owner, {
      commandId: cid("r"), projectId: p, title: "Keep the web server healthy", objective: "The site answers and certificates stay valid", desiredCondition: "health endpoint returns 200",
      ownerId: ops.id, managed: [svc.id], everyMinutes: 60, eventSources: ["uptime-monitor"], permittedActions: ["desk.write", "task.*"],
      maintenanceWindows: [{ days: [0, 6], start: "02:00", end: "04:00" }], escalation: { to: "owner", afterMinutes: 30, note: "page me" },
    } as never);
    const got = (await duties.get(owner, r.id))!;
    assert.deepEqual([got.state, got.ownerId, got.managed, got.everyMinutes], ["active", ops.id, [svc.id], 60]);
    const t = await task(p, "renew certificate");
    const first = await duties.record(ops, { commandId: cid("o"), responsibilityId: r.id, kind: "check", summary: "health 200, cert 20 days left", outcome: "ok" });
    const second = await duties.record(owner, { commandId: cid("o"), responsibilityId: r.id, kind: "intervention", summary: "opened a task to renew the cert", taskId: t });
    assert.deepEqual([first.id, second.id], [`${r.id}.1`, `${r.id}.2`]);
    const history = (await duties.history(owner, r.id, { limit: 10 }))!;
    assert.deepEqual(history.items.map((i) => [i.seq, i.kind, i.taskId ?? null]), [[1, "check", null], [2, "intervention", t]]);
    assert.equal(history.next, undefined);
    const page = (await duties.history(owner, r.id, { limit: 1 }))!;
    assert.deepEqual([page.items.length, page.next], [1, 1]);
    assert.equal((await duties.history(owner, r.id, { afterSeq: 1, limit: 1 }))!.items[0]!.seq, 2);
    // the responsibility survives its checks: still active, same revision
    assert.equal((await duties.get(owner, r.id))!.revision, 1);
    // an entry must link a task of its own project and carry no credential
    const other = await project("Elsewhere");
    const foreign = await task(other, "foreign");
    await refuses("invalid_command", () => duties.record(owner, { commandId: cid("o"), responsibilityId: r.id, kind: "note", summary: "x", taskId: foreign }), (e) => assert.equal(e.field, "taskId"));
    await refuses("invalid_command", () => duties.record(owner, { commandId: cid("o"), responsibilityId: r.id, kind: "note", summary: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), (e) => assert.equal(e.field, "summary"));
    const blindWriter = await agent("blindwriter", rights(p, "responsibility.read", "responsibility.write"));
    const hiddenTask = await task(p, "hidden");
    await refuses("invalid_command", () => duties.record(blindWriter, { commandId: cid("o"), responsibilityId: r.id, kind: "note", summary: "x", taskId: hiddenTask }), (e) => assert.equal(e.field, "taskId"));
    await refuses("invalid_command", () => duties.record(blindWriter, { commandId: cid("o"), responsibilityId: r.id, kind: "note", summary: "x", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }), (e) => assert.equal(e.field, "taskId"));
    await refuses("invalid_command", () => duties.record(owner, { commandId: cid("o"), responsibilityId: r.id, kind: "party", summary: "x" } as never));
    // the same record command again adds one entry only
    const rec = { commandId: "rec-once", responsibilityId: r.id, kind: "note", summary: "once" } as never;
    const a = await duties.record(owner, rec);
    const b = await duties.record(owner, rec);
    assert.deepEqual([a.id, b.id, b.replayed], [`${r.id}.3`, `${r.id}.3`, true]);
    assert.equal((await duties.history(owner, r.id, { limit: 100 }))!.items.length, 3);
  });

  suite("status reads the schedule: the next check falls due from the last check, an overdue check starts nothing, and maintenance windows are UTC", async ({ owner, duties, project, setNow, auditCount }) => {
    const p = await project("P");
    const r = await duties.create(owner, { commandId: cid("r"), projectId: p, title: "Docs", objective: "Docs match the release", everyMinutes: 120, maintenanceWindows: [{ days: [4], start: "10:30", end: "11:00" }] } as never);
    let s = (await duties.status(owner, r.id))!;
    assert.deepEqual([s.checkOverdue, s.nextCheckDue, s.lastCheckAt, s.events], [false, "2026-10-22T12:00:00.000Z", undefined, 0], "from creation when never checked");
    assert.equal(s.inMaintenanceWindow, false, "10:00 UTC is before the window (2026-10-22 is a Thursday)");
    setNow("2026-10-22T10:45:00.000Z");
    assert.equal((await duties.status(owner, r.id))!.inMaintenanceWindow, true);
    setNow("2026-10-22T11:00:00.000Z");
    assert.equal((await duties.status(owner, r.id))!.inMaintenanceWindow, false, "the end is exclusive");
    setNow("2026-10-22T12:00:01.000Z");
    const audits = await auditCount();
    s = (await duties.status(owner, r.id))!;
    assert.equal(s.checkOverdue, true);
    assert.equal(await auditCount(), audits, "an overdue check starts nothing");
    await duties.record(owner, { commandId: cid("o"), responsibilityId: r.id, kind: "check", summary: "fine", outcome: "ok" });
    s = (await duties.status(owner, r.id))!;
    assert.deepEqual([s.checkOverdue, s.nextCheckDue, s.lastCheckAt, s.lastCheckOutcome], [false, "2026-10-22T14:00:01.000Z", "2026-10-22T12:00:01.000Z", "ok"]);
    // a note is not a check
    setNow("2026-10-22T20:00:00.000Z");
    await duties.record(owner, { commandId: cid("o"), responsibilityId: r.id, kind: "note", summary: "just a note" });
    assert.equal((await duties.status(owner, r.id))!.lastCheckAt, "2026-10-22T12:00:01.000Z");
    // paused is never overdue
    await duties.update(owner, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 1, state: "paused" });
    assert.equal((await duties.status(owner, r.id))!.checkOverdue, false);
  });

  suite("a resource has one managing responsibility: a second claim is refused, simultaneous claims have one winner, and dropping it or retiring frees it", async ({ owner, resources, duties, project }) => {
    const p = await project("P");
    const server = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Server", locator: "ssh://host" } as never);
    const a = await duties.create(owner, { commandId: cid("r"), projectId: p, title: "A", objective: "keep it up", managed: [server.id] } as never);
    await refuses("invalid_command", () => duties.create(owner, { commandId: cid("r"), projectId: p, title: "B", objective: "also", managed: [server.id] } as never), (e) => assert.equal(e.field, "managed"));
    // The hand-off package names the claim (card L03h): held while the responsibility manages it, and not once it is dropped.
    assert.deepEqual([(await resources.heldClaim(server.id))?.responsibilityId], [a.id]);
    const b = await duties.create(owner, { commandId: cid("r"), projectId: p, title: "B", objective: "no resources" } as never);
    await refuses("invalid_command", () => duties.update(owner, { commandId: cid("u"), responsibilityId: b.id, expectedRevision: 1, managed: [server.id] } as never), (e) => assert.equal(e.field, "managed"));
    // release by dropping it, then the other may take it
    await duties.update(owner, { commandId: cid("u"), responsibilityId: a.id, expectedRevision: 1, managed: [] } as never);
    assert.equal(await resources.heldClaim(server.id), undefined, "a dropped claim is not a hold");
    await duties.update(owner, { commandId: cid("u"), responsibilityId: b.id, expectedRevision: 1, managed: [server.id] } as never);
    await refuses("invalid_command", () => duties.update(owner, { commandId: cid("u"), responsibilityId: a.id, expectedRevision: 2, managed: [server.id] } as never));
    // retiring frees it and is final
    await duties.update(owner, { commandId: cid("u"), responsibilityId: b.id, expectedRevision: 2, state: "retired" });
    assert.deepEqual((await duties.get(owner, b.id))!.managed, []);
    await refuses("invalid_command", () => duties.update(owner, { commandId: cid("u"), responsibilityId: b.id, expectedRevision: 3, state: "active" }));
    await refuses("invalid_command", () => duties.record(owner, { commandId: cid("o"), responsibilityId: b.id, kind: "note", summary: "late" }));
    const c = await duties.create(owner, { commandId: cid("r"), projectId: p, title: "C", objective: "take over", managed: [server.id] } as never);
    assert.deepEqual((await duties.get(owner, c.id))!.managed, [server.id]);
    // two at once for a free resource: one winner
    await duties.update(owner, { commandId: cid("u"), responsibilityId: c.id, expectedRevision: 1, managed: [] } as never);
    const raced = await Promise.allSettled([1, 2, 3].map((i) => duties.create(owner, { commandId: cid(`race${i}`), projectId: p, title: `R${i}`, objective: "race", managed: [server.id] } as never)));
    assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of raced) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && (r.reason.code === "invalid_command" || r.reason.code === "stale_revision"), String(r.reason));
    const claimants = (await duties.list(owner, p, { state: "active" }))!.filter((x) => x.managed.includes(server.id));
    assert.equal(claimants.length, 1, "exactly one active responsibility manages the server");
  });

  suite("a managed resource cannot be unbound, and a resource of another project or an unbound one cannot be managed", async ({ owner, resources, duties, project }) => {
    const p = await project("P");
    const q = await project("Q");
    const mine = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Mine", locator: "m" } as never);
    const theirs = await resources.bindResource(owner, { commandId: cid("b"), projectId: q, kind: "service", label: "Theirs", locator: "t" } as never);
    const gone = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Gone", locator: "g" } as never);
    await resources.unbindResource(owner, { commandId: cid("ub"), resourceId: gone.id, expectedRevision: 1 });
    await refuses("invalid_command", () => duties.create(owner, { commandId: cid("r"), projectId: p, title: "T", objective: "o", managed: [theirs.id] } as never), (e) => assert.equal(e.field, "managed"));
    await refuses("invalid_command", () => duties.create(owner, { commandId: cid("r"), projectId: p, title: "T", objective: "o", managed: [gone.id] } as never));
    const r = await duties.create(owner, { commandId: cid("r"), projectId: p, title: "T", objective: "o", managed: [mine.id] } as never);
    await refuses("invalid_command", () => resources.unbindResource(owner, { commandId: cid("ub"), resourceId: mine.id, expectedRevision: 1 }), (e) => assert.match(e.message, /manages/));
    await duties.update(owner, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 1, managed: [] } as never);
    await resources.unbindResource(owner, { commandId: cid("ub"), resourceId: mine.id, expectedRevision: 1 });
    await refuses("invalid_command", () => duties.update(owner, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 2, managed: [mine.id] } as never));
  });

  suite("responsibility authority: write, assign and history are separate; the owner agent may add history only to its own; others see nothing", async ({ owner, duties, resources, project, agent }) => {
    const p = await project("P");
    const q = await project("Q");
    const svc = await resources.bindResource(owner, { commandId: cid("b"), projectId: p, kind: "service", label: "S", locator: "s" } as never);
    const ann = await agent("ann", rights(p, "responsibility.read"));
    const ben = await agent("ben", rights(p, "responsibility.read"));
    const writer = await agent("writer", rights(p, "responsibility.read", "responsibility.write"));
    const assigner = await agent("assigner", rights(p, "responsibility.read", "responsibility.write", "responsibility.assign"));
    const stranger = await agent("stranger", rights(q, "responsibility.read", "responsibility.write", "responsibility.assign"));
    await refuses("forbidden", () => duties.create(ann, { commandId: cid("r"), projectId: p, title: "T", objective: "o" } as never));
    await refuses("forbidden", () => duties.create(stranger, { commandId: cid("r"), projectId: p, title: "T", objective: "o" } as never));
    await refuses("forbidden", () => duties.create(writer, { commandId: cid("r"), projectId: p, title: "T", objective: "o", ownerId: ann.id } as never));
    await refuses("forbidden", () => duties.create(writer, { commandId: cid("r"), projectId: p, title: "T", objective: "o", managed: [svc.id] } as never));
    const r = await duties.create(assigner, { commandId: cid("r"), projectId: p, title: "T", objective: "o", ownerId: ann.id, managed: [svc.id] } as never);
    await refuses("forbidden", () => duties.update(writer, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 1, ownerId: ben.id } as never));
    await refuses("forbidden", () => duties.update(writer, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 1, managed: [] } as never));
    await duties.update(writer, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 1, title: "Renamed", everyMinutes: 10 } as never);
    await refuses("forbidden", () => duties.update(stranger, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 2, title: "Hacked" } as never), (e) => assert.ok(!e.message.includes(p)));
    // history: the owner agent, a writer and the installation owner; nobody else
    await duties.record(ann, { commandId: cid("o"), responsibilityId: r.id, kind: "check", summary: "ok" });
    await refuses("forbidden", () => duties.record(ben, { commandId: cid("o"), responsibilityId: r.id, kind: "check", summary: "forged" }));
    await refuses("forbidden", () => duties.record(stranger, { commandId: cid("o"), responsibilityId: r.id, kind: "check", summary: "forged" }));
    await duties.record(writer, { commandId: cid("o"), responsibilityId: r.id, kind: "note", summary: "fine" });
    // reads: hidden from another project and from an agent without the read right
    assert.equal(await duties.get(stranger, r.id), undefined);
    assert.equal(await duties.history(stranger, r.id, { limit: 5 }), undefined);
    assert.equal(await duties.status(stranger, r.id), undefined);
    assert.equal(await duties.list(stranger, p), undefined);
    const blind = await agent("blind", rights(p, "responsibility.write"));
    assert.equal(await duties.get(blind, r.id), undefined);
    // the owner must be an active agent, escalation to an unknown agent is refused
    await refuses("invalid_command", () => duties.update(owner, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 2, ownerId: "owner:rob" } as never), (e) => assert.equal(e.field, "ownerId"));
    await refuses("invalid_command", () => duties.update(owner, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 2, escalation: { to: "agent:ghost" } } as never), (e) => assert.equal(e.field, "escalation.to"));
    await duties.update(owner, { commandId: cid("u"), responsibilityId: r.id, expectedRevision: 2, ownerId: null, everyMinutes: null, escalation: null } as never);
    const cleared = (await duties.get(owner, r.id))!;
    assert.deepEqual([cleared.ownerId, cleared.everyMinutes, cleared.escalation], [undefined, undefined, undefined]);
  });

  suite("responsibility input is checked and bounded", async ({ owner, duties, project }) => {
    const p = await project("P");
    const make = (extra: Record<string, unknown>) => duties.create(owner, { commandId: cid("r"), projectId: p, title: "T", objective: "o", ...extra } as never);
    await refuses("invalid_command", () => duties.create(owner, { commandId: cid("r"), projectId: p, title: "T" } as never));
    await refuses("invalid_command", () => make({ everyMinutes: 0 }), (e) => assert.equal(e.field, "everyMinutes"));
    await refuses("invalid_command", () => make({ everyMinutes: null }));
    await refuses("invalid_command", () => make({ permittedActions: ["Not An Action"] }), (e) => assert.match(e.field ?? "", /permittedActions/));
    await refuses("invalid_command", () => make({ maintenanceWindows: [{ days: [7], start: "01:00", end: "02:00" }] }));
    await refuses("invalid_command", () => make({ maintenanceWindows: [{ days: [1], start: "23:00", end: "01:00" }] }), (e) => assert.match(e.field ?? "", /end/));
    await refuses("invalid_command", () => make({ maintenanceWindows: [{ days: [1], start: "9:00", end: "10:00" }] }));
    await refuses("invalid_command", () => make({ eventSources: Array.from({ length: 21 }, (_, i) => `s${i}`) }));
    await refuses("invalid_command", () => make({ objective: "use key ghp_abcdefghijklmnopqrstuvwxyz0123456789 to log in" }), (e) => assert.equal(e.field, "objective"));
    await refuses("invalid_command", () => make({ surprise: 1 }), (e) => assert.equal(e.field, "surprise"));
    await refuses("invalid_command", () => make({ managed: ["not-an-id"] }));
    const ok = await make({ eventSources: ["a", "a", "b"] });
    assert.deepEqual((await duties.get(owner, ok.id))!.eventSources, ["a", "b"], "duplicates fold");
    await refuses("invalid_command", () => duties.update(owner, { commandId: cid("u"), responsibilityId: ok.id, expectedRevision: 1 } as never));
    await refuses("stale_revision", () => duties.update(owner, { commandId: cid("u"), responsibilityId: ok.id, expectedRevision: 5, title: "x" } as never));
  });

  suite("a restarted controller sees the same records and replays commands by ID", async ({ owner, resources, duties, project, reopen }) => {
    const p = await project("P");
    const command = { commandId: "once-bind", projectId: p, kind: "service", label: "S", locator: "s" } as never;
    const first = await resources.bindResource(owner, command);
    const r = await duties.create(owner, { commandId: "once-resp", projectId: p, title: "T", objective: "o", managed: [first.id] } as never);
    const fresh = reopen();
    const again = await fresh.resources.bindResource(owner, command);
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    const resp = await fresh.duties.create(owner, { commandId: "once-resp", projectId: p, title: "T", objective: "o", managed: [first.id] } as never);
    assert.deepEqual([resp.id, resp.replayed], [r.id, true]);
    assert.equal((await fresh.resources.list(owner, p))!.length, 1);
    assert.equal((await fresh.duties.list(owner, p))!.length, 1);
  });
}
