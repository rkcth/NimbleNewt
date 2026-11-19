import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startController } from "../api/index.js";
import { replyOf } from "../chat/chat.js";
import { stopServer } from "../domain/testing/backends.js";
import { DEFAULT_ROUTE_FLOOR_CHARS, ROUTE_FLOOR_DEFAULTS } from "../context/route-settings.js";
import { MIN_STARTABLE_WINDOW, WORKER_FIXED_PART_CHARS, smallWindowWarning, windowCanStartTask } from "../context/fixed-part.js";
import { SETUP_GUIDE } from "./readiness.js";
import { MIN_WORKABLE_CONTEXT_TOKENS } from "./providers.js";

after(stopServer);

// Card "Fixed-part sizing after T08": a window from the worker's accepted minimum up to the smallest one that can start a task is still accepted, and routing.provider.add says, with the figures, that no task can start on it.
type R = { ok: boolean; result?: { routes?: string[]; warnings?: string[]; shown?: string[]; replayed?: boolean }; error?: { code: string; message: string } };
const provider = (name: string, port: number, contextTokens: number) => ({ name, location: "local", endpoint: `http://127.0.0.1:${port}/v1`, models: ["m"], contextTokens });

test("routing.provider.add accepts a window too small to start a task, warns with the window that is needed, and repeats the warning on a replay", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-fixedpart-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }) } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const add = (providers: unknown[], commandId: string) => c.api.handle(boot.token, { v: 1, op: "routing.provider.add", commandId, args: { providers } } as never) as Promise<R>;
    const small = await add([provider("tiny", 8002, 16_384), provider("big", 8003, 65_536)], "p1");
    assert.equal(small.ok, true, JSON.stringify(small));
    assert.deepEqual(small.result!.routes, ["tiny/m", "big/m"], "the providers are added all the same");
    assert.equal(small.result!.warnings!.length, 1, "only the small window is warned about");
    const w = small.result!.warnings![0]!;
    assert.ok(w.startsWith("Provider tiny: a context window of 16,384 tokens is accepted, but no task can start on it"), w);
    assert.ok(w.includes("about 5,900 tokens") && w.includes(`at least ${MIN_STARTABLE_WINDOW.toLocaleString("en-US")} tokens`), w);
    assert.deepEqual(small.result!.shown, small.result!.warnings, "the chat shows the warning");
    // The chat's reply of an applied command shows the lines.
    assert.ok(replyOf([{ i: 0, status: "applied", op: "routing.provider.add", shown: small.result!.shown } as never]).includes(w));
    const again = await add([provider("tiny", 8002, 16_384), provider("big", 8003, 65_536)], "p1");
    assert.equal(again.result!.replayed, true);
    assert.deepEqual(again.result!.warnings, small.result!.warnings, "a replay says the same");
    // Large enough: no warning, no field.
    const fine = await add([provider("tiny", 8002, MIN_STARTABLE_WINDOW), provider("big", 8003, 65_536)], "p2");
    assert.equal(fine.ok, true, JSON.stringify(fine));
    assert.equal(fine.result!.warnings, undefined);
    assert.equal(fine.result!.shown, undefined);
    // Under the worker's minimum: refused as before.
    const refused = await add([provider("tiny", 8002, MIN_WORKABLE_CONTEXT_TOKENS - 1), provider("big", 8003, 65_536)], "p3");
    assert.equal(refused.ok, false);
    assert.match(refused.error!.message, /too small for the team to work in/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the figures: the floor covers the measured fixed part, every accepted window under the startable one warns, the guide's words come from the constants", () => {
  assert.ok(DEFAULT_ROUTE_FLOOR_CHARS >= WORKER_FIXED_PART_CHARS, "an unmeasured route counts at least the real fixed part");
  assert.equal(DEFAULT_ROUTE_FLOOR_CHARS, ROUTE_FLOOR_DEFAULTS.systemPromptChars + ROUTE_FLOOR_DEFAULTS.toolSchemaChars);
  for (let w = MIN_WORKABLE_CONTEXT_TOKENS; w < MIN_STARTABLE_WINDOW; w += 512) { assert.equal(windowCanStartTask(w), false, String(w)); assert.ok(smallWindowWarning(w) !== undefined, String(w)); }
  for (const w of [MIN_STARTABLE_WINDOW, 32_768, 40_960, 131_072]) { assert.equal(windowCanStartTask(w), true, String(w)); assert.equal(smallWindowWarning(w), undefined, String(w)); }
  const q = SETUP_GUIDE["model-route"].question;
  assert.ok(q.includes("about 5,900 tokens") && q.includes("32,768 or more is needed in practice") && !q.includes("4,200"), q);
});
