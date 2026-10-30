import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const provider = (location: "local" | "cloud") => ({ enabled: true, paid: location === "cloud", location });
const route = { contextTokens: 100_000, capabilities: ["tools"] };
const table = {
  providers: { strata: provider("local"), openrouter: provider("cloud") },
  routes: { "strata/qwen": route, "openrouter/qwen": route },
  profiles: { main: ["strata/qwen", "openrouter/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main" },
};
const topology = { services: ["strata-svc"], targets: { "strata/qwen": { endpoint: "strata-http", account: "local-acct", service: "strata-svc" }, "openrouter/qwen": { endpoint: "or-api", account: "or-acct" } }, aliases: {} };

test("routing orders typed in the owner chat run without the assistant, report their stages, and a short form is expanded and shown before anything runs (card U06b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-cut-chat-"));
  let read = 0;
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter(() => { read++; return []; }) } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.routing.setTable(rob, { commandId: "t1", expectedRevision: 0, table });
    await c.services.cutover.setTopology(rob, { commandId: "o1", expectedRevision: 0, topology });
    const say = (messageId: string, text: string) => c.chat!.submit(boot.token, { messageId, text });
    const entries = async () => ((await c.api.handle(boot.token, { v: 1, op: "routing.controls", args: {} } as never)) as any).result.controls.entries.length as number;

    const off = await say("m1", '/nimblenewt.routing-disable {"level":"provider","name":"openrouter","reason":"out of credit"}');
    assert.equal(off.outcomes[0]!.status, "applied", JSON.stringify(off.outcomes));
    assert.match(off.reply.join("\n"), /Received: yes[\s\S]*Accepted: yes[\s\S]*Effected: new work no longer reaches the target/);
    assert.equal(await entries(), 1);
    // A short form changes nothing: it is expanded into the exact line, and that line is what runs.
    const short = await say("m2", "/restore provider openrouter credit is back");
    assert.deepEqual([short.outcomes[0]!.status, short.outcomes[0]!.code], ["refused", "needs_confirmation"]);
    const line = /\/nimblenewt\.routing-reenable \{[^\n]*\}/.exec(short.reply.join("\n"))?.[0];
    assert.ok(line !== undefined && line.includes("credit is back"), short.reply.join("\n"));
    assert.equal(await entries(), 1, "the short form did not run");
    const lifted = await say("m3", line!);
    assert.match(lifted.reply.join("\n"), /Effected: the target may be used again/);
    assert.equal(await entries(), 0);
    assert.match((await say("m4", "/exclude river x")).reply.join("\n"), /needs what to act on/);
    assert.equal(read, 0, "none of it went to the assistant");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
