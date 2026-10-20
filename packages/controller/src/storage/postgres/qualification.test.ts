import assert from "node:assert/strict";
import { after, test } from "node:test";
import { isStorageError } from "../errors.js";
import { ACTIONS, runBoundaryQualification, type BoundaryRig, type CrashPoint } from "../qualification/boundaries.js";
import { PostgresStorage } from "./index.js";
import { FaultProxy } from "./testing/proxy.js";
import { startTestServer, withClient, type TestServer } from "./testing/server.js";

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

let counter = 0;

const rig: BoundaryRig = {
  name: "postgres",
  open: async () => {
    const s = await server();
    const real = new URL(s.url());
    const schema = `bnd_${process.pid}_${counter++}`;
    const proxy = await FaultProxy.start({ host: real.hostname, port: Number(real.port) });
    const proxied = new URL(real); proxied.port = String(proxy.port);
    const view = await PostgresStorage.open({ connectionString: s.url(), schema });
    const victim = await PostgresStorage.open({ connectionString: proxied.toString(), schema, maxConnections: 1 });
    await victim.currentEpoch(); // establish the one connection before any crash is armed
    return {
      view,
      attempt: async (action, point: CrashPoint | undefined) => {
        proxy.arm(point);
        try {
          await ACTIONS[action].run(victim);
          return { crashed: false, statements: proxy.statements };
        } catch (error) {
          assert.ok(isStorageError(error, "retryable") || isStorageError(error, "uncertain_commit"), `a cut connection must be reported as retryable or uncertain, got ${String(error)}`);
          return { crashed: true, statements: proxy.statements };
        }
      },
      close: async () => {
        await victim.close(); await view.close(); await proxy.stop();
        await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
      },
    };
  },
};

for (const action of ["operation", "claim", "epoch", "retry"] as const) {
  test(`PostgreSQL: a connection cut before or after every statement of ${action === "operation" ? "a complex operation" : `a ${action}`} leaves either all of it or none of it, and it is durable exactly when COMMIT has run`, async (t) => {
    const report = await runBoundaryQualification(rig, action);
    t.diagnostic(`crash matrix (${action}): ${report.statements} statements, ${report.points} crash points (before and after each), committed only at: ${report.committedPoints.join(", ")}`);
    assert.ok(report.points >= (action === "operation" ? 40 : 6), `only ${report.points} crash points were exercised`);
    assert.deepEqual(report.committedPoints, [`after ${report.statements}`]);
  });
}
