/**
 * Child process for the delivery crash tests. Usage: node delivery-child.js <mode> <directory>, where <directory> holds `db.sqlite`
 * (seeded with an epoch, a project and, for the deliver modes, one task) and `engine.log` (the destination's memory: one delivery ID per line).
 * The process is killed with SIGKILL at the point <mode> names:
 *   - `create-before-commit` / `create-after-commit`: creating a task, just before / just after its transaction commits.
 *   - `deliver-before-receipt`: the destination has the message; the receipt has not been recorded.
 *   - `deliver-after-receipt`: the receipt has committed; the process dies before it can say so.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStorage } from "../../storage/sqlite/index.js";
import type { ControllerStorage } from "../../storage/types.js";
import { DeliveryDispatcher } from "../delivery.js";
import { TASK_EVENTS } from "../events.js";
import { ProjectService } from "../service.js";

const [mode, directory] = process.argv.slice(2) as [string, string];
const T = "2026-10-20T10:00:00.000Z";
const kill = (): never => { process.kill(process.pid, "SIGKILL"); return undefined as never; };

const real = await SqliteStorage.open({ path: join(directory, "db.sqlite"), busyTimeoutMs: 20_000 });
const storage: ControllerStorage = new Proxy(real, {
  get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver) as unknown;
    if (typeof value !== "function") return value;
    if (name === "applyOperation") {
      return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => {
        if (mode === "create-before-commit") kill();
        const result = await target.applyOperation(input);
        if (mode === "create-after-commit" || (mode === "deliver-after-receipt" && input.completeDeliveries.length > 0)) kill();
        return result;
      };
    }
    return value.bind(target);
  },
});
const epoch = await real.currentEpoch();

if (mode.startsWith("create-")) {
  const projects = ProjectService.withEpoch(real, epoch, { clock: () => T });
  const project = (await projects.listProjects({ limit: 1 }))[0]!;
  await ProjectService.withEpoch(storage, epoch, { clock: () => T }).createTask({ commandId: "crash-task", actor: "child", projectId: project.id, title: "crash test" });
} else {
  const log = join(directory, "engine.log");
  const dispatcher = new DeliveryDispatcher(storage, epoch, {
    destination: TASK_EVENTS, claimant: "child", clock: () => T,
    handler: async (d) => {
      if (!existsSync(log) || !readFileSync(log, "utf8").split("\n").includes(d.deliveryId)) appendFileSync(log, `${d.deliveryId}\n`);
      if (mode === "deliver-before-receipt") kill();
      return {};
    },
  });
  await dispatcher.runOnce();
}
process.stdout.write("finished\n");
await real.close();
