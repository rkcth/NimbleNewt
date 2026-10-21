import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { RoutingService, selectRoute, type RouteRequest, type RoutingTable } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

const table = {
  providers: { local: { enabled: true, paid: false, location: "local" }, cloud: { enabled: true, paid: true, location: "cloud" }, free: { enabled: true, paid: false, location: "cloud" } },
  routes: {
    "local/small": { contextTokens: 32_000, capabilities: ["tools"] },
    "local/big": { contextTokens: 128_000, capabilities: ["tools", "reasoning"] },
    "free/open": { contextTokens: 64_000, capabilities: ["tools"] },
    "cloud/top": { contextTokens: 200_000, capabilities: ["tools", "reasoning", "vision"] },
  },
  profiles: { easy: ["local/small", "local/big"], hard: ["local/big", "free/open", "cloud/top"] },
  roles: { coder: "easy", architect: "hard" },
};
const request = (extra: Partial<RouteRequest> = {}): RouteRequest => ({ role: "coder", contextTokens: 10_000, needs: ["tools"], data: "local-only", paidAuthorized: false, ...extra });

for (const backend of backends) {
  const suite = (name: string, body: (c: { routing: RoutingService; owner: Principal; agent: Principal }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "*", project: "*" }] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        await body({ routing: RoutingService.withEpoch(world.storage, projects.epoch, options), owner, agent });
      } finally { await world.close(); }
    });
  const install = (routing: RoutingService, owner: Principal, t: unknown = table, expectedRevision = 0) => routing.setTable(owner, { commandId: cid("t"), expectedRevision, table: t });

  suite("routes are chosen in order for the role's profile, and the answer carries the table revision", async ({ routing, owner }) => {
    await refuses("not_found", () => routing.select(request()), (e) => assert.match(e.message, /no routing table/));
    const set = await install(routing, owner);
    const pick = await routing.select(request());
    assert.deepEqual([pick.chosen, pick.profile, pick.revision], ["local/small", "easy", set.revision]);
    assert.deepEqual(pick.candidates.map((c) => c.route), ["local/small", "local/big"]);
    assert.equal((await routing.select(request({ role: "architect", needs: ["reasoning"] }))).chosen, "local/big");
    assert.equal((await routing.select(request({ profile: "hard" }))).profile, "hard", "a request may name its profile");
    await refuses("not_found", () => routing.select(request({ role: "janitor" })), (e) => assert.match(e.message, /no profile is configured for role janitor/));
  });

  suite("a disabled or excluded provider is out of the very next dispatch, retries and helper calls included, and a task's preferred route cannot bypass it", async ({ routing, owner }) => {
    await install(routing, owner);
    assert.equal((await routing.select(request())).chosen, "local/small");
    const ex = await routing.exclude(owner, { commandId: cid("x"), kind: "provider", name: "local", reason: "the GPU box is down" });
    const after = await routing.select(request());
    assert.equal(after.chosen, undefined, "nothing else was invented in its place");
    assert.match(after.candidates[0]!.reasons.join(), /provider local is excluded: the GPU box is down/);
    assert.equal(after.revision, ex.revision);
    const preferred = await routing.select(request({ prefer: "local/big" }));
    assert.equal(preferred.chosen, undefined, "a task override passes the same rules");
    assert.equal(preferred.candidates[0]!.route, "local/big");
    await routing.lift(owner, { commandId: cid("l"), kind: "provider", name: "local", reason: "back" });
    assert.equal((await routing.select(request())).chosen, "local/small");
    await routing.exclude(owner, { commandId: cid("x"), kind: "route", name: "local/small", reason: "bad output" });
    const route = await routing.select(request());
    assert.equal(route.chosen, "local/big", "excluding one route falls through to the next");
    assert.match(route.candidates[0]!.reasons.join(), /route is excluded: bad output/);
  });

  suite("a route that cannot carry the context or lacks a capability is skipped, with the reason", async ({ routing, owner }) => {
    await install(routing, owner);
    const big = await routing.select(request({ contextTokens: 100_000 }));
    assert.equal(big.chosen, "local/big");
    assert.match(big.candidates[0]!.reasons.join(), /needs 100000 tokens of context but supports 32000/);
    const reasoning = await routing.select(request({ needs: ["tools", "reasoning"] }));
    assert.equal(reasoning.chosen, "local/big");
    assert.match(reasoning.candidates[0]!.reasons.join(), /lacks reasoning/);
    const none = await routing.select(request({ contextTokens: 500_000 }));
    assert.equal(none.chosen, undefined);
    assert.ok(none.candidates.every((c) => !c.eligible));
  });

  suite("cloud routes are used only for data that may leave, and paid ones only when spending is authorized", async ({ routing, owner }) => {
    await install(routing, owner);
    const hard = (extra: Partial<RouteRequest>) => routing.select(request({ role: "architect", contextTokens: 150_000, needs: ["vision"], ...extra }));
    const local = await hard({});
    assert.equal(local.chosen, undefined);
    assert.match(local.candidates.find((c) => c.route === "cloud/top")!.reasons.join(), /may not leave the installation/);
    const allowed = await hard({ data: "cloud-allowed" });
    assert.equal(allowed.chosen, undefined, "cloud allowed but still paid");
    assert.match(allowed.candidates.find((c) => c.route === "cloud/top")!.reasons.join(), /paid and spending is not authorized/);
    assert.equal((await hard({ data: "cloud-allowed", paidAuthorized: true })).chosen, "cloud/top");
    // A free cloud route needs the data authorization but not spending.
    assert.equal((await routing.select(request({ role: "architect", contextTokens: 50_000, needs: ["tools"], profile: "hard", prefer: "free/open", data: "cloud-allowed" }))).chosen, "free/open");
    assert.equal((await routing.select(request({ profile: "hard", prefer: "free/open", data: "local-only" }))).chosen, "local/big");
  });

  suite("a disabled provider in the table is skipped, and an unknown preferred route is not a route", async ({ routing, owner }) => {
    await install(routing, owner, { ...table, providers: { ...table.providers, local: { enabled: false, paid: false, location: "local" } } });
    const pick = await routing.select(request());
    assert.equal(pick.chosen, undefined);
    assert.match(pick.candidates[0]!.reasons.join(), /provider local is disabled/);
    const odd = await routing.select(request({ prefer: "ghost/model" }));
    assert.deepEqual(odd.candidates[0], { route: "ghost/model", eligible: false, reasons: ["not a configured route"] });
  });

  suite("a bad proposal changes nothing; a stale one is refused; exclusions survive a new table", async ({ routing, owner }) => {
    const first = await install(routing, owner);
    const before = JSON.stringify(await routing.get());
    const bad = (t: unknown, code: DomainErrorCode = "invalid_command") => refuses(code, () => routing.setTable(owner, { commandId: cid("b"), expectedRevision: first.revision, table: t }));
    await bad({ ...table, routes: { ...table.routes, "ghost/x": { contextTokens: 1, capabilities: [] } } });
    await bad({ ...table, profiles: { easy: ["local/small", "local/small"] } });
    await bad({ ...table, profiles: { easy: ["nope/none"] } });
    await bad({ ...table, roles: { coder: "missing" } });
    await bad({ ...table, providers: { ...table.providers, local: { enabled: "yes", paid: false, location: "local" } } });
    await bad({ ...table, providers: { ...table.providers, local: { enabled: true, paid: false, location: "moon" } } });
    await bad({ ...table, routes: { "local/small": { contextTokens: 0, capabilities: [] } } });
    await bad({ ...table, routes: { "local/small": { contextTokens: 5, capabilities: ["Tools"] } } });
    await bad({ ...table, extra: 1 });
    await bad("table");
    await bad(JSON.parse('{"providers":{"__proto__":{"enabled":true,"paid":false,"location":"local"}},"routes":{},"profiles":{},"roles":{}}'));
    assert.equal(JSON.stringify(await routing.get()), before, "nothing was applied");
    await refuses("stale_revision", () => routing.setTable(owner, { commandId: cid("s"), expectedRevision: 7, table }));
    await refuses("stale_revision", () => routing.setTable(owner, { commandId: cid("s"), expectedRevision: 0, table }));
    await routing.exclude(owner, { commandId: cid("x"), kind: "provider", name: "cloud", reason: "no budget" });
    // A new table cannot drop or rename an excluded provider or route, and names cannot differ only by case.
    const live = (await routing.get())!;
    const renamed = { ...table, providers: { local: table.providers.local, Cloud: table.providers.cloud, free: table.providers.free }, routes: { "local/small": table.routes["local/small"], "local/big": table.routes["local/big"], "free/open": table.routes["free/open"], "Cloud/top": table.routes["cloud/top"] }, profiles: { easy: ["local/small"], hard: ["Cloud/top"] } };
    await refuses("invalid_command", () => routing.setTable(owner, { commandId: cid("r"), expectedRevision: live.revision, table: renamed }), (e) => assert.match(e.message, /provider cloud is excluded but is not in the new table/));
    await bad({ ...table, providers: { ...table.providers, Local: table.providers.local } });
    await bad({ ...table, routes: { ...table.routes, "Local/small": table.routes["local/small"] } });
    await routing.exclude(owner, { commandId: cid("xr"), kind: "route", name: "local/small", reason: "flaky" });
    const dropped = { ...table, routes: { "local/big": table.routes["local/big"], "free/open": table.routes["free/open"], "cloud/top": table.routes["cloud/top"] }, profiles: { easy: ["local/big"], hard: ["local/big"] } };
    await refuses("invalid_command", () => routing.setTable(owner, { commandId: cid("r"), expectedRevision: (live.revision + 1), table: dropped }), (e) => assert.match(e.message, /route local\/small is excluded but is not in the new table/));
    await routing.lift(owner, { commandId: cid("lr"), kind: "route", name: "local/small", reason: "fixed" });
    const current = (await routing.get())!;
    await routing.setTable(owner, { commandId: cid("n"), expectedRevision: current.revision, table: { ...table, profiles: { ...table.profiles, easy: ["local/big"] } } });
    assert.equal((await routing.get())!.exclusions.length, 1, "the exclusion outlived the new table");
    assert.deepEqual((await routing.select(request())).candidates.map((c) => c.route), ["local/big"]);
  });

  suite("only the owner changes routing; exclusions need a real target and a reason; the same command replays", async ({ routing, owner, agent }) => {
    await refuses("forbidden", () => routing.setTable(agent, { commandId: cid("t"), expectedRevision: 0, table }), (e) => assert.match(e.message, /only the owner/));
    await install(routing, owner);
    await refuses("forbidden", () => routing.exclude(agent, { commandId: cid("x"), kind: "provider", name: "local", reason: "x" }));
    await refuses("forbidden", () => routing.lift(agent, { commandId: cid("x"), kind: "provider", name: "local", reason: "x" }));
    await refuses("not_found", () => routing.exclude(owner, { commandId: cid("x"), kind: "provider", name: "locall", reason: "typo" }), (e) => assert.match(e.message, /not in the routing table/));
    await refuses("invalid_command", () => routing.exclude(owner, { commandId: cid("x"), kind: "provider", name: "local", reason: "" }));
    await refuses("invalid_command", () => routing.exclude(owner, { commandId: cid("x"), kind: "provider", name: "local", reason: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => routing.lift(owner, { commandId: cid("x"), kind: "provider", name: "local", reason: "not excluded" }), (e) => assert.match(e.message, /not excluded/));
    const command = { commandId: "exclude-once", kind: "provider" as const, name: "cloud", reason: "no budget" };
    const first = await routing.exclude(owner, command);
    assert.equal((await routing.exclude(owner, command)).replayed, true);
    assert.equal((await routing.get())!.revision, first.revision);
    await refuses("invalid_command", () => routing.exclude(owner, { ...command, commandId: cid("again") }), (e) => assert.match(e.message, /already excluded/));
    await refuses("invalid_command", () => routing.select({ ...request(), surprise: true } as never));
  });
}

test("selection is a pure function of the table and the request", () => {
  const t: RoutingTable = { ...(table as unknown as RoutingTable), exclusions: [] };
  assert.deepEqual(selectRoute(t, request()), selectRoute(t, request()));
});
