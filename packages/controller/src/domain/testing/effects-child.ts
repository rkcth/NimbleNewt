/**
 * Child process for the effect crash test. Usage: node effects-child.js <mode> <directory>, where <directory> holds `db.sqlite` (seeded with an
 * epoch) and `outside.log` (the outside world: one line per application of an effect). Modes: `keyed` and `opaque` name the target; the
 * process is killed with SIGKILL after the outside application succeeded and just before the result is saved.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStorage } from "../../storage/sqlite/index.js";
import type { ControllerStorage } from "../../storage/types.js";
import { EffectService, type EffectBridge } from "../effects.js";

const [mode, directory] = process.argv.slice(2) as [string, string];
const kill = (): never => { (process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)); return undefined as never; };
const log = join(directory, "outside.log");

export const outsideLines = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const bridge: EffectBridge = {
  idempotent: mode === "keyed",
  execute: async (r) => {
    if (!(mode === "keyed" && outsideLines().includes(r.key))) appendFileSync(log, `${r.key}\n`);
    return { receipt: "r" };
  },
};

const real = await SqliteStorage.open({ path: join(directory, "db.sqlite"), busyTimeoutMs: 20_000 });
const storage: ControllerStorage = new Proxy(real, {
  get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver) as unknown;
    if (typeof value !== "function") return value;
    if (name === "applyOperation") {
      return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => {
        if (input.settleEffects.length > 0) kill();
        return target.applyOperation(input);
      };
    }
    return value.bind(target);
  },
});
const effects = EffectService.withEpoch(storage, await real.currentEpoch(), undefined, { holder: "child", clock: () => "2026-10-20T10:00:00.000Z" });
await effects.perform({ commandId: "crash-effect", actor: "child", kind: "git-push", target: "repo:main", input: { commit: "abc" } }, bridge);
process.stdout.write("finished\n");
await real.close();
