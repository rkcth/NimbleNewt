import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { StatusService } from "../status/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { CatalogService, MAINTAINER_LIMITS, TOOLBOX_MANAGE, ToolboxProposalService, toolboxMaintainers } from "./index.js";

// Card T08 (eighth slice): the owner's maintainers' view, read from the rights as the controller itself judges them, with the proposals that wait for each maintainer. Read only.
after(stopServer);

const options = { clock: () => "2026-11-22T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "Garden" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "Orchard" })).id;
        const ta = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "T" })).id;
        const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
        for (const role of ["coder"]) await agents.defineRole(owner, { commandId: cid("role"), name: role, capabilities: [] });
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const cat = CatalogService.withEpoch(world.storage, projects.epoch, desks, options);
        const props = ToolboxProposalService.withEpoch(world.storage, projects.epoch, cat, desks, options, async () => undefined);
        const ports = { agents, principals, grants: GrantService.withEpoch(world.storage, projects.epoch, options), catalog: cat, proposals: props };
        const c: Ctx = {
          cat, props, desks, principals, agents, owner, a, b, ta, storage: world.storage, epoch: projects.epoch, ports,
          agent: async (friendlyName, grants, extra = {}) => {
            const id = (await agents.create(owner, { commandId: cid("ag"), friendlyName, ...(extra.roles === undefined ? {} : { roles: extra.roles }) })).id;
            const pid = `agent:${id}`;
            await principals.setGrants(owner, { commandId: cid("g"), principalId: pid, expectedRevision: (await principals.get(pid))!.revision, grants });
            return { id, pid, p: await principals.authenticate((await principals.issueCredential(owner, pid)).token) };
          },
          setGrants: async (pid, grants) => principals.setGrants(owner, { commandId: cid("g"), principalId: pid, expectedRevision: (await principals.get(pid))!.revision, grants }),
          note: async (by, text) => (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title: "work", body: text, visibility: "shared", status: "accepted" } as never)).id,
          everything: async () => {
            const out: string[] = [];
            for (const kind of ["agent", "principal", "catalog-entry", "catalog-version", "toolbox-proposal", "toolbox-proposer", "grant-record"]) {
              for (let afterId: string | undefined; ;) { const page = await world.storage.listAggregates(kind, { ...(afterId === undefined ? {} : { afterId }), limit: 200 }); for (const x of page) out.push(`${kind}/${x.id}@${x.revision}`); if (page.length < 200) break; afterId = page.at(-1)!.id; }
            }
            const audit = await world.storage.listAudit({ afterSeq: 0, limit: 1000 });
            return [...out, `audit:${audit.length}`];
          },
        };
        await body(c);
      } finally { await world.close(); }
    });
  interface Agent { id: string; pid: string; p: Principal }
  interface Ctx {
    cat: CatalogService; props: ToolboxProposalService; desks: DeskService; principals: PrincipalService; agents: AgentService; owner: Principal; a: string; b: string; ta: string; storage: ControllerStorage; epoch: number;
    ports: Parameters<typeof toolboxMaintainers>[1];
    agent(name: string, grants: Grant[], extra?: { roles?: string[] }): Promise<Agent>;
    setGrants(principalId: string, grants: Grant[]): Promise<void>;
    note(by: Principal, body: string): Promise<string>;
    everything(): Promise<string[]>;
  }
  const worker = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "catalog.read", project: "*" }, { action: "catalog.register", project: "*" }];
  const cast = async (c: Ctx) => {
    const ann = await c.agent("Ann", worker(c.a));
    const cody = await c.agent("Cody", worker(c.a), { roles: ["coder"] });
    const maya = await c.agent("Maya", [...worker(c.a), { action: TOOLBOX_MANAGE, project: "*" }]);
    const pat = await c.agent("Pat", [...worker(c.a), { action: TOOLBOX_MANAGE, project: c.b }]);
    const readme = await c.note(ann.p, "Run lint on the changed files."); const code = await c.note(ann.p, "console.log('lint')");
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, audience: { roles: ["coder"] } } as never);
    // A second shared tool made for the Orchard project alone: a maintainer of Orchard alone covers it.
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.fmt", kind: "tool", version: "1.0.0", manifest: { ...manifest, purpose: "format" }, instructionsRecordId: readme, executableRecordId: code, audience: { projects: [c.b] } } as never);
    return { ann, cody, maya, pat };
  };
  // Agents are listed in the order of their record IDs, which are random: tests compare as sorted sets (the page tests check that the order itself holds still).
  const rowsOf = async (c: Ctx, q: { name?: string; after?: number } = {}) => (await toolboxMaintainers(c.owner, c.ports, q)).items.map((x) => [x.agent, x.everyProject, x.projects, x.waiting] as const).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const sorted = <T extends readonly unknown[]>(rows: T[]): T[] => [...rows].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1));
  const names = async (c: Ctx, q: { name?: string; after?: number } = {}) => (await toolboxMaintainers(c.owner, c.ports, q)).items.map((x) => x.agent).sort();

  suite("the maintainers are the active agents that hold toolbox.manage now, each with the reach of its right and the proposals that wait for it; a tool named leaves only those whose right covers it", async (c) => {
    const { cody, maya, pat } = await cast(c);
    const all = await toolboxMaintainers(c.owner, c.ports);
    assert.deepEqual(await rowsOf(c), sorted([[maya.pid, true, [], 0], [pat.pid, false, [c.b], 0]]), "Ann and Cody hold no such right");
    assert.deepEqual([all.after, all.more, all.scanLimited, all.tool], [0, false, false, undefined]);
    // A tool made for coders is covered by a holder for every project only; one made for Orchard alone also by Orchard's maintainer.
    assert.deepEqual(await names(c, { name: "lint" }), [maya.pid]);
    assert.deepEqual(await names(c, { name: "toolbox.fmt" }), [maya.pid, pat.pid].sort());
    // A proposal against lint waits for Maya only (Pat may not decide it); the author's own is never counted for the author.
    const better = await c.note(cody.p, "console.log('lint, faster')");
    await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", executableRecordId: better, rationale: "faster", tests: "ran it" } as never);
    assert.deepEqual((await rowsOf(c)).map((x) => [x[0], x[3]]), sorted([[maya.pid, 1], [pat.pid, 0]]));
    assert.deepEqual((await rowsOf(c, { name: "fmt" })).map((x) => [x[0], x[3]]), sorted([[maya.pid, 0], [pat.pid, 0]]), "waiting is counted for the named tool only");
    const mine = await c.note(maya.p, "console.log('lint by maya')");
    await c.props.propose(maya.p, { commandId: cid("pp"), name: "lint", executableRecordId: mine, rationale: "maya's own", tests: "ran it" } as never);
    assert.equal((await rowsOf(c)).find((x) => x[0] === maya.pid)![3], 1, "Maya's own proposal does not wait for Maya");
    // The right changes at once with the grant: taken away, the agent is no longer listed; given to another, it is.
    await c.setGrants(maya.pid, worker(c.a));
    assert.deepEqual(await names(c), [pat.pid]);
    await c.setGrants(cody.pid, [...worker(c.a), { action: TOOLBOX_MANAGE, project: c.a }]);
    const now = await toolboxMaintainers(c.owner, c.ports);
    assert.deepEqual(now.items.map((x) => [x.agent, x.projects]).sort(), [[cody.pid, [c.a]], [pat.pid, [c.b]]].sort());
    assert.equal(now.items.find((x) => x.agent === cody.pid)!.waiting, 0, "Cody's right covers Garden alone, not a tool made for coders: Maya's proposal does not wait for it (and Cody's own never counts)");
  });

  suite("a retired agent and an agent whose right is held back by a restriction are not maintainers, one given the right by a grant is; the view reads everything and creates nothing", async (c) => {
    const { maya, pat } = await cast(c);
    const before = await c.everything();
    for (let i = 0; i < 2; i++) await toolboxMaintainers(c.owner, c.ports, { name: "lint" });
    assert.deepEqual(await c.everything(), before, "reading creates and changes nothing (no record, no audit entry)");
    await c.agents.retire(c.owner, { commandId: cid("ret"), agentId: pat.id, expectedRevision: (await c.agents.get(c.owner, pat.id))!.revision });
    assert.deepEqual(await names(c), [maya.pid], "a retired agent holds nothing");
    // A restriction on the right beats the grant (the controller's own rule is the one read); lifting it gives the right back. A right given by a grant record, not on the agent's own record, counts.
    const grants = GrantService.withEpoch(c.storage, c.epoch, options);
    const r = await grants.restrict(c.owner, { commandId: cid("rs"), subject: maya.pid, action: TOOLBOX_MANAGE, project: "*", reason: "frozen" });
    assert.deepEqual(await names(c), [], "a restricted right is not held");
    await grants.lift(c.owner, { commandId: cid("lf"), restrictionId: r.id, expectedRevision: r.revision, reason: "done" });
    assert.deepEqual(await names(c), [maya.pid]);
    const ann = await c.agent("Ann2", worker(c.a));
    await grants.grant(c.owner, { commandId: cid("gr"), grantee: ann.pid, action: TOOLBOX_MANAGE, project: c.a, source: "direct", basis: "the owner said so" });
    assert.deepEqual((await rowsOf(c)).map((x) => [x[0], x[2]]).sort(), [[ann.pid, [c.a]], [maya.pid, []]].sort());
    // A task credential of the owner, an agent and a stranger are refused; the owner's own is the only reader.
    await refuses("forbidden", () => toolboxMaintainers(maya.p, c.ports));
    await refuses("forbidden", () => toolboxMaintainers({ ...c.owner, taskScope: { taskId: c.ta, projectId: c.a } }, c.ports));
    await refuses("forbidden", () => toolboxMaintainers({ id: "client:x", kind: "client", name: "x", grants: [] }, c.ports));
    // Bad words fail closed: nothing is listed for them.
    await refuses("not_found", () => toolboxMaintainers(c.owner, c.ports, { name: "nothing-like-it" }), /no shared tool/);
    await refuses("invalid_command", () => toolboxMaintainers(c.owner, c.ports, { name: "nimblenewt.x" }));
    await refuses("invalid_command", () => toolboxMaintainers(c.owner, c.ports, { name: 5 }));
    for (const bad of [-1, 1.5, "1", Number.NaN, 2_000_000, null]) await refuses("invalid_command", () => toolboxMaintainers(c.owner, c.ports, { after: bad }), /after/);
  });

  suite("a right that has ended or lapsed from non-use is not held, a wider action that covers toolbox.manage is, and only an agent that could hold the right has its rights judged", async (c) => {
    const { maya, pat } = await cast(c);
    const grants = GrantService.withEpoch(c.storage, c.epoch, options);
    const ann = await c.agent("Ann2", worker(c.a));
    const bea = await c.agent("Bea", worker(c.a));
    const cal = await c.agent("Cal", [...worker(c.a), { action: "toolbox.*", project: c.b }]);
    await grants.grant(c.owner, { commandId: cid("gr"), grantee: ann.pid, action: TOOLBOX_MANAGE, project: "*", source: "direct", basis: "until December", expiresAt: "2026-12-01T00:00:00.000Z" });
    await grants.grant(c.owner, { commandId: cid("gr"), grantee: bea.pid, action: TOOLBOX_MANAGE, project: c.a, source: "direct", basis: "while in use", idleDays: 3 });
    assert.deepEqual(await names(c), [maya.pid, pat.pid, ann.pid, bea.pid, cal.pid].sort(), "all five hold it today");
    // Judged ten days later: Ann's right has ended and Bea's has lapsed from non-use; the rights on the agents' own records still hold.
    const later = PrincipalService.withEpoch(c.storage, c.epoch, { ...options, clock: () => "2026-12-02T12:00:00.000Z" });
    const judged: string[] = [];
    const counting = { current: async (id: string) => { judged.push(id); return later.current(id); }, get: (id: string) => later.get(id) };
    const out = await toolboxMaintainers(c.owner, { ...c.ports, principals: counting });
    assert.deepEqual(out.items.map((x) => x.agent).sort(), [maya.pid, pat.pid, cal.pid].sort());
    assert.deepEqual(out.items.find((x) => x.agent === cal.pid)!.projects, [c.b], "toolbox.* for Orchard is the right for Orchard");
    // Only those five were judged: the two agents with no such right anywhere (Ann and Cody of the cast) were passed over without reading every grant record for them.
    assert.deepEqual(judged.sort(), [maya.pid, pat.pid, ann.pid, bea.pid, cal.pid].sort());
    // A wait longer than one page of the proposals (or a look that stopped early) is marked "at least"; one that fits is not.
    const waitOf = async (answer: { items: { author: string }[]; next?: string; partial?: true }) =>
      (await toolboxMaintainers(c.owner, { ...c.ports, proposals: { list: async () => answer as never } }, { name: "lint" })).items.filter((x) => x.agent === maya.pid).map((x) => [x.waiting, x.waitingMore]);
    const hundred = Array.from({ length: MAINTAINER_LIMITS.waiting }, () => ({ author: pat.pid }));
    assert.deepEqual(await waitOf({ items: hundred, next: "more" }), [[100, true]]);
    assert.deepEqual(await waitOf({ items: hundred.slice(0, 3), next: "more", partial: true }), [[3, true]]);
    assert.deepEqual(await waitOf({ items: [...hundred.slice(0, 2), { author: maya.pid }] }), [[2, undefined]], "Maya's own is not counted, and nothing more waits");
  });

  suite("more than one page: ten at a time, `after` is how many were already shown, the next page continues in the same order, and a longer wait is counted as at least", async (c) => {
    await cast(c);
    const extra: string[] = [];
    for (let i = 0; i < 11; i++) extra.push((await c.agent(`Mia ${i}`, [...worker(c.a), { action: TOOLBOX_MANAGE, project: "*" }])).pid);
    const first = await toolboxMaintainers(c.owner, c.ports);
    assert.equal(first.items.length, MAINTAINER_LIMITS.page);
    assert.deepEqual([first.more, first.after], [true, 0]);
    assert.deepEqual((await toolboxMaintainers(c.owner, c.ports)).items.map((x) => x.agent), first.items.map((x) => x.agent), "the same order each time");
    const second = await toolboxMaintainers(c.owner, c.ports, { after: 10 });
    assert.equal(second.items.length, 3, "13 maintainers in all: Maya, Pat and 11 more... less Ann and Cody");
    assert.deepEqual([second.more, second.after], [false, 10]);
    const seen = [...first.items, ...second.items].map((x) => x.agent);
    assert.equal(new Set(seen).size, 13, "no maintainer is skipped or shown twice");
    assert.ok(extra.every((x) => seen.includes(x)));
    assert.deepEqual((await toolboxMaintainers(c.owner, c.ports, { after: 13 })).items, [], "past the end there is nothing");
    assert.deepEqual((await toolboxMaintainers(c.owner, c.ports, { after: 12 })).items.map((x) => x.agent), [seen[12]]);
  });

  suite("the owner's status view: names with IDs, the reach, the waiting count, the 'N more' line with its `after`, and nothing for anyone but the owner", async (c) => {
    const { cody, maya, pat } = await cast(c);
    const better = await c.note(cody.p, "console.log('lint, faster')");
    await c.props.propose(cody.p, { commandId: cid("pp"), name: "lint", executableRecordId: better, rationale: "faster", tests: "ran it" } as never);
    const status = StatusService.withEpoch(c.storage, c.epoch, { toolbox: { list: (by: Principal) => c.cat.toolbox(by), forks: async () => ({ forks: [] }), maintainers: (by: Principal, q: { name?: string; after?: number }) => toolboxMaintainers(by, c.ports, q) } } as never, options);
    const text = async (request: Record<string, unknown>): Promise<string[]> => ((await status.ask(c.owner, { kind: "toolbox_maintainers", ...request } as never))!).lines.map((l) => l.text);
    const lines = (await text({})).sort((x, y) => (x.startsWith('"Maya"') ? -1 : y.startsWith('"Maya"') ? 1 : 0));
    assert.equal(lines[0], `"Maya" (${maya.pid}) holds toolbox.manage for every project, so it may decide proposals for any shared tool; 1 proposal waits for a decision it may make.`);
    assert.equal(lines[1], `"Pat" (${pat.pid}) holds toolbox.manage for the projects "Orchard" (${c.b}), so it may decide proposals only for shared tools made for those projects alone; no proposal waits for a decision it may make.`);
    assert.match(lines.find((l) => l.startsWith("The owner"))!, /^The owner may always decide a proposal; an agent never decides its own\./);
    assert.equal(lines.length, 3);
    const one = await text({ name: "fmt" });
    assert.equal(one.length, 3);
    assert.ok(one.slice(0, 2).every((l) => /no proposal waits for a decision it may make on toolbox\.fmt\.$/.test(l)));
    assert.deepEqual(await text({ name: "lint", after: 1 }), ["There are no more maintainers to show."]);
    const lone = await text({ name: "lint", after: 0 });
    assert.equal(lone.length, 2);
    // Nothing for anyone but the owner, nothing for a bad request word, and a tool that does not exist reads as missing.
    assert.equal(await status.ask(maya.p, { kind: "toolbox_maintainers" }), undefined);
    assert.equal(await status.ask({ ...c.owner, taskScope: { taskId: c.ta, projectId: c.a } }, { kind: "toolbox_maintainers" }), undefined);
    assert.equal(await status.ask(c.owner, { kind: "toolbox_maintainers", name: "ghost" }), undefined);
    await assert.rejects(() => status.ask(c.owner, { kind: "toolbox_maintainers", after: -1 } as never), /after/);
    await assert.rejects(() => status.ask(c.owner, { kind: "toolbox_maintainers", extra: 1 } as never));
    // With nobody holding the right the view says so.
    await c.setGrants(maya.pid, worker(c.a)); await c.setGrants(pat.pid, worker(c.a));
    assert.deepEqual(await text({}), ["No agent holds toolbox.manage now: only the owner decides toolbox proposals."]);
  });

  suite("the view's wording for a long wait, a wait that could not be counted, a page with more behind it and a look that stopped early", async (c) => {
    const { maya } = await cast(c);
    const answer = { items: [{ agent: maya.pid, everyProject: true, projects: [], waiting: 100, waitingMore: true as const }, { agent: "agent:agt-gone", everyProject: false, projects: ["proj-a", "proj-b", "proj-c", "proj-d", "proj-e", "proj-f", "proj-g"] }, { agent: "agent:agt-one", everyProject: true, projects: [], waiting: 1 }], after: 20, more: true, scanLimited: true };
    const status = StatusService.withEpoch(c.storage, c.epoch, { toolbox: { list: async () => ({ items: [] }), forks: async () => ({ forks: [] }), maintainers: async () => answer } } as never, options);
    const lines = ((await status.ask(c.owner, { kind: "toolbox_maintainers" }))!).lines.map((l) => l.text);
    assert.match(lines[0]!, /; at least 100 proposals wait for a decision it may make\.$/);
    assert.match(lines[1]!, /^agent:agt-gone holds toolbox\.manage for the projects proj-a, proj-b, proj-c, proj-d, proj-e and 2 more, so it may decide proposals only for shared tools made for those projects alone; the proposals waiting for it could not be counted\.$/);
    assert.match(lines[2]!, /; 1 proposal waits for a decision it may make\.$/);
    assert.ok(lines.includes("There are more maintainers; ask again with after 23 to see the next ones."), "the next page starts after those already shown");
    assert.ok(lines.includes("The look stopped before it had read every agent; there may be more maintainers."));
  });
}
