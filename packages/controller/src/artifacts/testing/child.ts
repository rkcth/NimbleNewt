/**
 * Child process for the artifact crash tests. Usage: node child.js <mode> <directory>, where <directory> holds `db.sqlite` and `blobs/`.
 * It publishes one artifact (two files) and is killed with SIGKILL at the point named by <mode>:
 *   - `none`: no kill, publishes and prints the result.
 *   - `after-temp-write`: the first blob is written and flushed to `tmp/`, not yet named.
 *   - `after-first-rename`: the first blob has its final name; nothing is recorded.
 *   - `before-manifest`: every blob is stored; the manifest commit is about to be sent.
 *   - `after-manifest`: the manifest has committed; the process dies before it can say so.
 */
import { join } from "node:path";
import { ArtifactService } from "../service.js";
import { FileBlobStore } from "../blobs.js";
import { SqliteStorage } from "../../storage/sqlite/index.js";
import type { ControllerStorage } from "../../storage/types.js";

const [mode, directory] = process.argv.slice(2) as [string, string];
const kill = (): never => { process.kill(process.pid, "SIGKILL"); return undefined as never; };

let renames = 0;
const blobs = await FileBlobStore.open({
  directory: join(directory, "blobs"),
  testHooks: {
    afterTempWrite: () => { if (mode === "after-temp-write") kill(); },
    afterRename: () => { renames += 1; if (mode === "after-first-rename" && renames === 1) kill(); },
  },
});
const real = await SqliteStorage.open({ path: join(directory, "db.sqlite"), busyTimeoutMs: 20_000 });
const storage: ControllerStorage = new Proxy(real, {
  get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver) as unknown;
    if (typeof value !== "function") return value;
    if (name === "applyOperation") {
      return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => {
        if (mode === "before-manifest") kill();
        const result = await target.applyOperation(input);
        if (mode === "after-manifest") kill();
        return result;
      };
    }
    return value.bind(target);
  },
});
const artifacts = ArtifactService.withEpoch(storage, await real.currentEpoch(), blobs, { clock: () => "2026-10-20T10:00:00.000Z" });
const result = await artifacts.publish({
  commandId: "crash-publish", actor: "child", name: "crash test",
  files: [{ path: "one.txt", content: Buffer.from("first file") }, { path: "two.txt", content: Buffer.from("second file") }],
});
process.stdout.write(`published ${JSON.stringify(result)}\n`);
await real.close();
