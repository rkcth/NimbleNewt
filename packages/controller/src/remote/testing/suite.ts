import assert from "node:assert/strict";
import { test } from "node:test";
import { operationKind, type ToolOperationBody } from "../../dispatch/model.js";
import type { WorkOrder } from "../../dispatch/ports.js";
import { workGrants } from "../../dispatch/testing/world.js";
import { DomainError, type DomainErrorCode } from "../../domain/errors.js";
import type { Backend } from "../../domain/testing/backends.js";
import { WorkerRequestError, type RemoteAttempt } from "../client.js";
import { buildRemoteWorld, type RemoteHost, type RemoteWorld } from "./world.js";

export const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (e: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e instanceof Error ? e.message : ""); check?.(e); return true; });
};
/** The worker side was refused over the wire with this code (and status). */
export const wireRefuses = async (code: string, run: () => Promise<unknown>, status?: number, check?: (e: WorkerRequestError) => void): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof WorkerRequestError, String(e)); assert.equal(e.code, code, e.message); if (status !== undefined) assert.equal(e.status, status); check?.(e); return true; });
};
export const READ = (callId: string) => ({ callId, tool: { name: "read-file", version: "1.0.0" }, args: { path: "README.md" } });
export const local = (text: string) => ({ kind: "local" as const, run: async () => ({ text }) });

export interface Started { readonly taskId: string; readonly attemptId: string; readonly placement: number; readonly order: WorkOrder; readonly attempt: RemoteAttempt }
export interface Ctx extends RemoteWorld {
  /** A new task for agent ann, ticked until the dispatcher starts it on `host` (it is the only host that can), and the worker accepts the offer. */
  started(host: RemoteHost, title?: string, extra?: { agent?: string }): Promise<Started>;
  ops(attemptId: string): Promise<ToolOperationBody[]>;
}

/** The suite function for one storage backend: a remote world per test, torn down after. */
export function remoteSuite(backend: Backend) {
  return (name: string, body: (c: Ctx) => Promise<void>, o: Parameters<typeof buildRemoteWorld>[1] = {}) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      let world: RemoteWorld | undefined;
      try {
        world = await buildRemoteWorld(store.storage, o);
        const w = world;
        const agents = new Map<string, { id: string; aid: string }>();
        const c: Ctx = Object.assign(w, {
          started: async (host: RemoteHost, title = "Order seeds", extra: { agent?: string } = {}) => {
            const name = extra.agent ?? "ann";
            if (!agents.has(name)) agents.set(name, await w.agent(name, workGrants(w.project, ["read-file", "write-file"])));
            w.prefer(host);
            const { taskId, attemptId } = await w.task(title, agents.get(name)!);
            const report = await w.tick();
            assert.ok(report.started.includes(attemptId!), JSON.stringify(report.skipped));
            const offers = await host.client.offers();
            const offer = offers.find((x) => x.order.attemptId === attemptId)!;
            assert.ok(offer, "the attempt was offered to the host");
            const attempt = host.client.attempt(attemptId!, offer.placement);
            await attempt.accept();
            return { taskId, attemptId: attemptId!, placement: offer.placement, order: offer.order, attempt };
          },
          ops: async (attemptId: string) => (await w.storage.listAggregates(operationKind(attemptId), { limit: 100 })).map((a) => a.body as unknown as ToolOperationBody),
        });
        await body(c);
      } finally { await world?.done(); await store.close(); }
    });
}
