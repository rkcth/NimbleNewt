import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController } from "./index.js";
import { Ids, mismatch, readExamples } from "./testing/doc-examples.js";

// Card D02: every request and answer in docs/nimblenewt/api-guide.md is run against a real controller, on SQLite and on PostgreSQL (the two storage choices startController takes).

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const GUIDE = "docs/nimblenewt/api-guide.md";

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });

test("the guide has examples, they pair up, and they cover every kind of answer the guide teaches (card D02)", () => {
  const examples = readExamples(GUIDE);
  assert.ok(examples.length >= 16, `only ${examples.length} examples`);
  const codes = new Set(examples.flatMap((e) => { const b = e.response.body as { error?: { code?: string } } | undefined; return b?.error?.code === undefined ? [] : [b.error.code]; }));
  for (const code of ["command_conflict", "stale_revision", "invalid_command", "unauthenticated", "forbidden"]) assert.ok(codes.has(code), `no example shows ${code}`);
  assert.ok(examples.some((e) => JSON.stringify(e.response.body).includes('"replayed":true')), "no example shows a replay");
  assert.ok(examples.some((e) => JSON.stringify(e.response.body).includes('"next"')), "no example shows a page");
});

for (const kind of ["sqlite", "postgres"] as const) {
  test(`${kind}: every example in the API guide gives the answer the guide shows (card D02)`, async () => {
    const d = mkdtempSync(join(tmpdir(), "nn-d02-"));
    let schema: string | undefined;
    let storage;
    if (kind === "sqlite") storage = { kind: "sqlite" as const, path: join(d, "c.sqlite") };
    else {
      server ??= startTestServer();
      schema = `d02_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
      storage = { kind: "postgres" as const, url: (await server).url(), schema };
    }
    const c = await startController({ storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
    try {
      const owner = await c.services.principals.bootstrapOwner({ name: "rob" });
      const principal = await c.services.principals.authenticate(owner.token);
      await c.services.principals.enroll(principal, { commandId: "d02-agent", kind: "agent", name: "ann", grants: [] });
      const agent = (await c.services.principals.issueCredential(principal, "agent:ann")).token;
      const tokens: Record<string, string> = { owner: owner.token, agent, nobody: "x".repeat(40) };
      const ids = new Ids();
      let lastPages = 0;
      for (const example of readExamples(GUIDE)) {
        const token = tokens[example.as];
        assert.ok(token !== undefined, `${GUIDE}:${example.line}: nobody called ${example.as}`);
        const live = await c.api.handle(token, ids.fill(example.request.body) as never);
        ids.learn(live);
        const bad = mismatch(example.response.body, live);
        assert.equal(bad, undefined, `${GUIDE}:${example.line}: ${bad}`);
        // Answers are matched as a subset, so a field the guide leaves out is free, except `next`: a page the guide shows without one must end the list.
        const shown = (example.response.body as { result?: Record<string, unknown> }).result;
        if (shown !== undefined && "items" in shown && !("next" in shown)) {
          assert.equal((live as { result?: Record<string, unknown> }).result?.["next"], undefined, `${GUIDE}:${example.line}: the guide shows no next, the controller gave one`);
          lastPages++;
        }
      }
      assert.ok(lastPages >= 2, "the guide shows both ways a list ends (an empty page after a full one, and a short page)");
    } finally {
      await c.close();
      if (schema !== undefined) await withClient((await server!).url(), async (client) => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
