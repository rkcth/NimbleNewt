import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher } from "../sandbox/launcher.js";
import { localEnvironmentHost } from "./host.js";

// Card A09, mount application, in a real sandbox (bubblewrap): the mount the host's reach gives is the resource, read-only, at the one path, and nothing else of the host is there. Skipped without a usable bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 on Linux (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const dirs: string[] = [];
const fresh = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "nn-mnt-"))); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

describe("a mounted resource in the real sandbox", () => {
  let launcher: SandboxLauncher; let usable = false;
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  before(async () => {
    launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    usable = process.platform === "linux" && launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
  });

  test("the resource is readable at /inputs/mounts/<resource>, cannot be written or removed from inside, and the host's other directories are not there", async (t) => {
    if (!usable) return t.skip(`bubblewrap or a node install it can mount is unusable: ${launcher.capacity.reason ?? nodeRoot}`);
    const base = fresh(); const data = join(base, "data"); mkdirSync(data);
    const host = localEnvironmentHost({ root: join(base, "environments"), worker: { session: async () => ({ sessionIntact: true, compactionIntact: true }) }, protectedPaths: [data] });
    assert.equal(host.problem, undefined);
    const store = host.resources!;
    mkdirSync(join(store.root, "ann.data"), { recursive: true }); mkdirSync(join(store.root, "other.data"), { recursive: true });
    writeFileSync(join(store.root, "ann.data", "a.txt"), "the resource's text"); writeFileSync(join(store.root, "other.data", "b.txt"), "another agent's");
    const grant = await host.reach("mount:ann.data", { agentId: "agent:ann" });
    const work = fresh(); mkdirSync(join(work, "home")); mkdirSync(join(work, "scratch")); mkdirSync(join(work, "work"));
    const program = `
      const fs = process.getBuiltinModule("fs");
      const out = { text: fs.readFileSync("/inputs/mounts/ann.data/a.txt", "utf8"), inputs: fs.readdirSync("/inputs").sort(), mounts: fs.readdirSync("/inputs/mounts").sort() };
      try { fs.writeFileSync("/inputs/mounts/ann.data/new.txt", "x"); out.write = "written"; } catch (e) { out.write = e.code; }
      try { fs.writeFileSync("/inputs/mounts/ann.data/a.txt", "changed"); out.overwrite = "written"; } catch (e) { out.overwrite = e.code; }
      try { fs.unlinkSync("/inputs/mounts/ann.data/a.txt"); out.unlink = "removed"; } catch (e) { out.unlink = e.code; }
      out.other = fs.existsSync("/inputs/mounts/other.data");
      out.hostStore = fs.existsSync(${JSON.stringify(store.root)});
      console.log("RESULT " + JSON.stringify(out));
    `;
    const programFile = join(work, "work", "probe.mjs"); writeFileSync(programFile, program);
    const run = await launcher.launch({
      recipe: { mode: "sandboxed", workdir: join(work, "work"), home: join(work, "home"), scratch: join(work, "scratch"), readOnly: [{ host: nodeRoot, guest: "/opt/interpreter" }, ...(grant!.readOnly as { host: string; guest: string }[])], network: "none", env: {}, protectedSubpaths: [] } as never,
      command: ["/opt/interpreter/bin/node", "/work/probe.mjs"], timeoutMs: 30_000, maxOutputBytes: 64 * 1024, limits: { cpus: 1, memoryMb: 512 }, requireEnforced: false,
    });
    const result = await run.result;
    assert.equal(result.exitCode, 0, result.stderr);
    const seen = JSON.parse(/RESULT (.*)/.exec(result.stdout)![1]!) as Record<string, unknown>;
    assert.equal(seen["text"], "the resource's text");
    assert.deepEqual(seen["mounts"], ["ann.data"], "only the one resource is there");
    assert.deepEqual([seen["write"], seen["overwrite"], seen["unlink"]], ["EROFS", "EROFS", "EROFS"], "nothing can be written, replaced or removed");
    assert.equal(seen["other"], false, "another resource is not there");
    assert.equal(seen["hostStore"], false, "the host's resource directory is not there");
    // Nothing changed on the host.
    assert.equal(readFileSync(join(store.root, "ann.data", "a.txt"), "utf8"), "the resource's text");
  });
});
