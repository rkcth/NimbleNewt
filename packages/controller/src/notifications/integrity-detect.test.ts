import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { StateApi, API_VERSION } from "../api/index.js";
import { ContextRouteSettingsService } from "../context/route-settings.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { InquiryService } from "../inquiries/index.js";
import { ContractService, WaitGraphService } from "../planning/index.js";
import { PrincipalService, TaskCredentialService } from "../security/index.js";
import { SwarmLimitsService, SWARM_LIMITS_REF } from "../swarm/limits.js";
import { integrityKey, watchIntegrity, type DetectedSecurity } from "./security-detect.js";

after(stopServer);

/**
 * Card U11d, integrity hooks: a stored record that fails its integrity check is told to the security detectors when an operation of the state API meets it (a damaged route setting) or when a store's own read on the way
 * to a decision does (a damaged swarm limits record read by `effective`, no operation involved). The error goes on unchanged, the same damage is one key, one failure is told once even when it passes both places, and
 * a failing detector changes nothing. Real damaged records on every storage backend.
 */
const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const damage = (storage: { applyOperation(op: never): Promise<unknown> }, epoch: number, ref: { kind: string; id: string }, body: unknown): Promise<unknown> =>
  storage.applyOperation({ operationId: cid("damage"), epoch, actor: "owner:rob", correlationId: cid("damage"), at: options.clock(), changes: [{ type: "create", ref, body }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);

for (const backend of backends) {
  test(`${backend.name}: a damaged stored setting is told to the security detectors from the API door and from the store's own read, once per kind of damage, and the caller sees the same error`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
      const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
      const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, options);
      const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
      const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
      const graph = WaitGraphService.withEpoch(world.storage, projects.epoch, contracts, BlockerService.withEpoch(world.storage, projects.epoch, options), options);
      const taskCredentials = TaskCredentialService.withEpoch(world.storage, projects.epoch, options);
      const told: { source: string; event: DetectedSecurity }[] = [];
      let broken = false;
      const detect = (source: string, event: DetectedSecurity): void => { told.push({ source, event }); if (broken) throw new Error("the detectors are down"); };
      const route = ContextRouteSettingsService.withEpoch(world.storage, projects.epoch);
      const watchedRoute = watchIntegrity(route, "context-route-settings", ["effective"], detect);
      const api = new StateApi({ principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, contextRouteSettings: watchedRoute, detect });
      const ownerToken = (await principals.bootstrapOwner({ name: "rob" })).token;
      const ask = (op: string) => api.handle(ownerToken, { v: API_VERSION, op, args: {} });

      // Sound: nothing is told.
      assert.ok((await ask("context.route.get")).ok);
      assert.equal(told.length, 0);

      // Damaged: the operation fails as before (integrity), and the detectors are told once; asking again is the same key.
      await damage(world.storage, projects.epoch, { kind: "ctx-route-settings", id: "main" }, { check: "maybe" });
      const first = await ask("context.route.get");
      assert.ok(!first.ok && first.error.code === "integrity", JSON.stringify(first));
      assert.equal(told.length, 1);
      assert.equal(told[0]!.source, "integrity");
      assert.equal(told[0]!.event.kind, "integrity-check-failed");
      assert.match(told[0]!.event.key, /^api:context\.route\.get:[0-9a-f]{24}$/);
      assert.equal(told[0]!.event.subject, "op:context.route.get");
      const again = await ask("context.route.get");
      assert.ok(!again.ok);
      assert.equal(told[1]!.event.key, told[0]!.event.key, "the same damage is the same key");
      // The message that reached the caller is not changed, and nothing of it is in the key.
      assert.ok(!JSON.stringify(told).includes("damaged"), "the message is not part of what is told");

      // The store's own read (the dispatcher's way in, no operation): told with the store as the place; the error is the store's own.
      await assert.rejects(() => watchedRoute.effective(), (e: unknown) => (e as { code?: string }).code === "integrity");
      const own = told[told.length - 1]!;
      assert.match(own.event.key, /^context-route-settings:[0-9a-f]{24}$/);
      assert.equal(own.event.subject, "store:context-route-settings");

      // The same error passing through both places is told once: a watched read inside an operation is not told again at the door.
      const before = told.length;
      const throughBoth = new StateApi({ principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, detect,
        contextRouteSettings: { get: async () => watchedRoute.effective() as never, change: route.change.bind(route) } });
      const both = await throughBoth.handle(ownerToken, { v: API_VERSION, op: "context.route.get", args: {} });
      assert.ok(!both.ok && both.error.code === "integrity");
      assert.equal(told.length, before + 1, "one failure, one report");

      // A detector that fails changes nothing for the caller.
      broken = true;
      const failing = await ask("context.route.get");
      assert.ok(!failing.ok && failing.error.code === "integrity");
      await assert.rejects(() => watchedRoute.effective(), (e: unknown) => (e as { code?: string }).code === "integrity");

      // The swarm limits record the spawn reads: damaged, told as its own place; a sound record reads and tells nothing.
      const swarm = SwarmLimitsService.withEpoch(world.storage, projects.epoch, options);
      const watchedSwarm = watchIntegrity(swarm, "swarm-limits", ["effective"], detect);
      const at = told.length;
      assert.deepEqual(await watchedSwarm.effective(), await swarm.effective());
      assert.equal(told.length, at);
      await damage(world.storage, projects.epoch, SWARM_LIMITS_REF, { depth: "deep" });
      await assert.rejects(() => watchedSwarm.effective(), (e: unknown) => (e as { code?: string }).code === "integrity");
      assert.match(told[told.length - 1]!.event.key, /^swarm-limits:/);
      // A member the guard was not asked about is the store's own, bound to it.
      assert.equal((await watchedSwarm.get(await principals.authenticate(ownerToken) as never)).damaged.length, 1);
      // Only an integrity error is told: any other failure of the read passes through silently.
      const quiet = told.length;
      const flaky = watchIntegrity({ effective: async () => { throw new Error("the disk is full"); } }, "flaky", ["effective"], detect);
      await assert.rejects(() => flaky.effective(), /disk is full/);
      assert.equal(told.length, quiet);
      // Different damage is a different key; digits and long IDs are not part of it.
      assert.equal(integrityKey("x", "blob abcdefghijkl12 is 42 bytes"), integrityKey("x", "blob zzzzzzzzzzzz99 is 7 bytes"));
      assert.notEqual(integrityKey("x", "the manifest is malformed"), integrityKey("x", "the manifest is missing"));
    } finally { await world.close(); }
  });
}
