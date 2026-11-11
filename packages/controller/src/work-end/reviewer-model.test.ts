import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigurationService } from "../configuration/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RoutingService } from "../routing/index.js";
import { PrincipalService } from "../security/index.js";
import { BoundedReviewerModel, REVIEWER_LIMITS, REVIEWER_ROUTE_SETTING, TOO_LONG, reviewerRoute } from "./reviewer-model.js";
import { INTERROGATOR_LIMITS, ReportInterrogator, parseAnswer } from "./interrogator.js";

after(stopServer);

// Card W10 wiring: the shipped client of the second agent. The client is bounded both ways and the route is the owner's setting judged by the routing table's own rules; with no usable route the questioning is not run, never passed.
const options = { clock: () => "2026-11-11T10:00:00.000Z", pause: async () => undefined };
const provider = (location: "local" | "cloud", extra: Record<string, unknown> = {}) => ({ enabled: true, paid: false, location, ...extra });
const route = { contextTokens: 100_000, capabilities: ["tools"] };
const TABLE = {
  providers: { mine: provider("local"), spare: provider("cloud"), dead: provider("local", { enabled: false }), small: provider("local") },
  routes: { "mine/big": route, "spare/free": route, "dead/x": route, "small/tiny": { contextTokens: 8192, capabilities: ["tools"] } },
  profiles: { judge: ["mine/big", "spare/free"] }, roles: { "safety-supervisor": "judge", coordinator: "judge" },
};
const ask = { system: "S", user: "U" };

test("the client redacts what it is given, cuts it to the bounds and replaces a reply over the verdict parser's limit with a marker that holds no verdict, so padding after a verdict cannot get it read (card W10 wiring)", async () => {
  const seen: { system: string; user: string }[] = [];
  const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const raw = { complete: async () => "", completeDetailed: async (_r: string, q: { system: string; user: string }) => { seen.push(q); return { text: `{"verdict":"supported"}${" ".repeat(5_000_000)}`, usage: { inputTokens: 5, outputTokens: 7 } }; } };
  const m = new BoundedReviewerModel(raw);
  const reply = await m.completeDetailed("mine/big", { system: `rules ${key}`, user: `report ${key} ${"x".repeat(100_000)}` });
  assert.doesNotMatch(seen[0]!.system + seen[0]!.user, /sk-abcdefghijklmnop/, "no secret goes to the reviewer's model");
  assert.ok(seen[0]!.user.length <= REVIEWER_LIMITS.user && /\(cut to fit\)$/.test(seen[0]!.user));
  assert.ok(seen[0]!.system.length <= REVIEWER_LIMITS.system);
  assert.equal(reply.text, TOO_LONG, "a huge reply is not passed on, not even its first part (trimming would turn a verdict plus padding into a verdict)");
  assert.throws(() => parseAnswer(reply.text, false), /holds no JSON object/);
  assert.equal((await new BoundedReviewerModel({ complete: async () => "  {\"verdict\":\"supported\"}  " }).complete("mine/big", ask)), "  {\"verdict\":\"supported\"}  ", "a reply within the limit is passed on as it is");
  assert.deepEqual(reply.usage, { inputTokens: 5, outputTokens: 7 }, "the tokens are passed on for the daily cap");
  assert.equal(await m.complete("mine/big", ask), TOO_LONG, "complete is the same bounded call");
});

test("the client refuses a raw reply that holds no text, a throw passes through, a client with only complete() is used, and more than the allowed calls at once are refused at once (card W10 wiring)", async () => {
  for (const bad of [null, undefined, {}, { text: 5 }, { text: { verdict: "supported" } }]) {
    const m = new BoundedReviewerModel({ complete: async () => "", completeDetailed: async () => bad as never });
    await assert.rejects(m.completeDetailed("mine/big", ask), /returned no text/, JSON.stringify(bad));
  }
  await assert.rejects(new BoundedReviewerModel({ complete: async () => { throw new Error("outage: down"); } }).complete("mine/big", ask), /outage: down/);
  assert.equal(await new BoundedReviewerModel({ complete: async () => "plain" }).complete("mine/big", ask), "plain");
  const gates: (() => void)[] = [];
  const slow = new BoundedReviewerModel({ complete: async () => { await new Promise<void>((ok) => gates.push(ok)); return "ok"; } });
  const first = [slow.complete("mine/big", ask), slow.complete("mine/big", ask)];
  const third = await Promise.race([slow.complete("mine/big", ask).then(() => "was accepted", (error: Error) => error.message), new Promise<string>((ok) => setTimeout(() => ok("was left waiting"), 300))]);
  assert.match(third, /too many questions/, "a third call is refused at once");
  gates.splice(0).forEach((g) => g());
  assert.deepEqual(await Promise.all(first), ["ok", "ok"]);
  const again = slow.complete("mine/big", ask);
  await new Promise((ok) => setImmediate(ok));
  gates.splice(0).forEach((g) => g());
  assert.equal(await again, "ok", "the slots are free again once the calls ended, failed ones included");
});

for (const backend of backends) {
  test(`${backend.name}: the reviewer route is the owner's setting judged by the routing table; unset, unknown, disabled, too small and unreadable routes are not run with why, a usable one is the only route asked (card W10 wiring)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const routing = RoutingService.withEpoch(world.storage, projects.epoch, options, {});
      const configuration = ConfigurationService.withEpoch(world.storage, projects.epoch, { routing });
      const base = { setting: () => configuration.installationValue(REVIEWER_ROUTE_SETTING), routing };
      const routes = reviewerRoute(base);
      // No routing table and no setting: not run, and the words tell the owner what to do.
      await assert.rejects(routes(), /no reviewer route is set, so no second agent questioned the report/);
      await routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
      await assert.rejects(routes(), /no reviewer route is set/, "unset is off even though the table gives safety-supervisor a list");
      let rev: number | undefined;
      const set = async (n: string, value: unknown): Promise<void> => { const st = await configuration.stage(owner, { commandId: `${n}s`, layer: "installation", ...(rev === undefined ? {} : { expectedRevision: rev }), set: { [REVIEWER_ROUTE_SETTING]: value } } as never); rev = (await configuration.apply(owner, { commandId: `${n}a`, layer: "installation", expectedRevision: st.revision })).revision; };
      await set("a", "mine/big");
      assert.deepEqual(await routes(), ["mine/big"], "only the owner's route, not the table's whole list");
      await set("b", "spare/free");
      assert.deepEqual(await routes(), ["spare/free"], "a cloud route is allowed because the owner named it; a change applies at the next questioning");
      for (const [value, why] of [["dead/x", /dead\/x cannot be used/], ["small/tiny", /small\/tiny cannot be used/], ["ghost/none", /ghost\/none cannot be used: it is not in the routing table|cannot be used/]] as const) {
        await set(`c-${value}`, value);
        await assert.rejects(routes(), why, value);
      }
      // The setting only holds a route written provider/model: anything else is refused when the owner sets it, with nothing changed.
      for (const bad of ["", "mine", "mine/", "/big", "../etc/passwd", "mine/big extra", "__proto__", 7, null, ["mine/big"], { route: "mine/big" }, "a".repeat(300)]) {
        await assert.rejects(configuration.stage(owner, { commandId: `bad-${JSON.stringify(bad)?.slice(0, 20)}`, layer: "installation", expectedRevision: rev!, set: { [REVIEWER_ROUTE_SETTING]: bad } } as never), (error: Error) => /provider\/model|must be/.test(error.message), JSON.stringify(bad)?.slice(0, 30));
      }
      await assert.rejects(routes(), /small\/tiny|ghost\/none/, "a refused value changed nothing");
      assert.equal(await configuration.installationValue(REVIEWER_ROUTE_SETTING), "ghost/none");
      // Taken out of the setting, it is off again.
      const removal = await configuration.stage(owner, { commandId: "rm-s", layer: "installation", expectedRevision: rev!, remove: [REVIEWER_ROUTE_SETTING] } as never);
      await configuration.apply(owner, { commandId: "rm-a", layer: "installation", expectedRevision: removal.revision });
      await assert.rejects(routes(), /no reviewer route is set/);
      // A routing table that cannot be read is not run either (the reason is bounded and redacted).
      await assert.rejects(reviewerRoute({ setting: async () => "mine/big", routing: { select: async () => { throw new Error("storage down sk-abcdefghijklmnopqrstuvwxyz0123456789"); } } })(), (error: Error) => /could not be checked against the routing table/.test(error.message) && !/sk-abcdefgh/.test(error.message));
      // The interrogator over this route: the model is asked on it and on no other; with none set it is not run (the dispatcher records that, never a pass).
      const calls: string[] = [];
      const asked = new ReportInterrogator(new BoundedReviewerModel({ complete: async (r) => { calls.push(r); return '{"verdict":"supported"}'; } }), { routes: reviewerRoute({ ...base, setting: async () => "mine/big" }), retryDelayMs: 0 });
      const input = { task: { title: "T", acceptanceCriteria: [], requiredEvidence: [], checks: [] }, report: "r", notes: [], evidence: { verified: "skipped", plan: "not known", diff: "none" }, rounds: [], round: 1, maxRounds: 2 } as never;
      assert.equal((await asked.ask(input)).verdict, "supported");
      assert.deepEqual(calls, ["mine/big"]);
      await assert.rejects(new ReportInterrogator(new BoundedReviewerModel({ complete: async (r) => { calls.push(r); return '{"verdict":"supported"}'; } }), { routes: reviewerRoute(base), retryDelayMs: 0 }).ask(input), /no reviewer route is set/);
      assert.deepEqual(calls, ["mine/big"], "no call was made without a route");
      assert.ok(INTERROGATOR_LIMITS.prompt <= REVIEWER_LIMITS.user, "the client's bound is never below the prompt the interrogator builds");
    } finally { await world.close(); }
  });
}
