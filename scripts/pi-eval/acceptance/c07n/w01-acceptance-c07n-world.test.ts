import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { LocalWorker } from "./local-worker.js";
import type { RouteResolver } from "./dispatcher.js";
import { controllerGuards } from "./runtime-guards.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

/** W01 acceptance for card C07n with the controller's real context service behind the guards, on every backend. */
for (const backend of backends) {
  test(`${backend.name}: a route with no window anywhere sends nothing and opens one context_overflow blocker naming the route; the routing table's figure is used when the host's does not know the route`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
      const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
      await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
      const histories = HistoryService.withEpoch(w.storage, w.epoch, w.options);
      const desks = DeskService.withEpoch(w.storage, w.epoch, w.options);
      const retrieval = RetrievalService.withEpoch(w.storage, w.epoch, desks, histories, w.options);
      const enforcement = ContextEnforcementService.withEpoch(w.storage, w.epoch, { blockers: w.blockers, retrieval }, w.options);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { attemptId, taskId } = await w.task("t", ann);
      let ran = false;
      const big = { systemPromptChars: 3_000_000, toolSchemaChars: 0, startupTokens: 0, replyReserveTokens: 500 };
      const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } as never;
      const host = (guards: ReturnType<typeof controllerGuards>, version: string, firstCall: () => typeof big): LocalWorker => new LocalWorker({
        hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version, capabilities: () => CAPS, guards: { context: guards.context! },
        sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
        runtimes: { open: async () => ({ firstCall, run: async () => { ran = true; return { status: "completed" as const }; }, checkpoint: async () => ({}), close: async () => undefined }) },
      });
      const onRoute = (name: string): RouteResolver => async (a) => { const r = await w.deps.route(a); return "route" in r ? { ...r, route: name } : r; };
      const binding = { context: enforcement, pause: w.pauses, messages: undefined as never, system: w.dispatcherPrincipal, agent: async (o: { credential: string }) => w.credentials.authenticate(o.credential), assignee: (o: { attemptId: string }) => w.credentials.agentOf(w.dispatcherPrincipal, o.attemptId) };
      const blockersNow = async () => (await store.storage.listAggregates("blocker", { limit: 50 })).map((b) => b.body as unknown as { type: string; state: string; summary: string });

      const blind = controllerGuards({ ...binding, window: () => undefined } as never);
      const blindHost = host(blind, "v", () => big);
      await blindHost.register(w.hosts, self);
      const first = w.restart({ workers: [blindHost], route: onRoute("unknown/model") });
      await first.tick();
      await first.idle();
      assert.equal(ran, false, "a call of a million tokens on a route of unknown window was sent");
      const summary = (await first.get(w.owner, attemptId!))!.outcome?.summary ?? "";
      assert.match(summary, /unknown\/model/, summary);
      assert.match(summary, /window/i, summary);
      const open = (await blockersNow()).filter((b) => b.type === "context_overflow" && b.state === "open");
      assert.equal(open.length, 1, JSON.stringify(await blockersNow()));
      assert.match(open[0]!.summary, /unknown\/model/, "the blocker does not name the route");
      assert.match(open[0]!.summary, /contextTokens/, "the blocker does not name the routing table's contextTokens");
      assert.match(open[0]!.summary, /host/i, "the blocker does not name the host's own window figure");
      assert.equal((await store.storage.listAggregates("ctx-admission", { limit: 10 })).length, 0, "the call was recorded as judged: there was no window to judge it against");
      const resumed = await blind.context!.resume({ attemptId, taskId, route: "unknown/model" } as never, 100);
      assert.equal(resumed.resume, false, "the stored conversation was resumed on a route with no known window");
      assert.equal((await blockersNow()).filter((b) => b.type === "context_overflow").length, 1, "the same task was blocked twice");

      const judged = controllerGuards({ ...binding, window: () => undefined, routeWindow: (order: { route: string }) => (order.route === "table/model" ? 4096 : undefined) } as never);
      const route = onRoute("table/model");
      const over = await w.task("u", ann);
      const sized = host(judged, "v2", () => ({ systemPromptChars: 3000, toolSchemaChars: 6000, startupTokens: 400, replyReserveTokens: 500 }));
      const second = w.restart({ workers: [sized], route });
      await second.tick();
      await second.idle();
      const records = (await store.storage.listAggregates("ctx-admission", { limit: 10 })).map((a) => { const b = a.body as unknown as { route: string; routeName?: string; window: number; admit: boolean }; return [b.routeName ?? b.route, b.window, b.admit]; });
      assert.deepEqual(records, [["table/model", 4096, false]], "the first call was not judged against the routing table's figure");
      assert.equal((await second.get(w.owner, over.attemptId!))!.outcome?.status, "failed");
      const fits = await w.task("v", ann);
      ran = false;
      const roomy = host(judged, "v3", () => ({ systemPromptChars: 1000, toolSchemaChars: 1000, startupTokens: 100, replyReserveTokens: 200 }));
      const third = w.restart({ workers: [roomy], route });
      await third.tick();
      await third.idle();
      assert.equal(ran, true, "a first call that fits the routing table's window was not sent");
      assert.equal((await third.get(w.owner, fits.attemptId!))!.outcome?.status, "succeeded");
      assert.equal((await judged.context!.resume({ attemptId: fits.attemptId!, taskId: fits.taskId, route: "table/model" } as never, 100)).resume, true);
      const overShare = await judged.context!.resume({ attemptId: fits.attemptId!, taskId: fits.taskId, route: "table/model" } as never, 30_000);
      assert.equal(overShare.resume, false, "a conversation over the resume share of the table's window was resumed");
      assert.match(overShare.reason, /30000 tokens, over 2457 \(60% of this model's 4096\)/, overShare.reason);
    } finally { await store.close(); }
  });
}
