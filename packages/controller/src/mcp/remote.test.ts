import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { McpService, RemoteMcpConnector } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T18:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const SDK = { name: "@modelcontextprotocol/sdk", version: "1.12.0" };
const refuses = async (match: RegExp, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: a remote MCP server is reached only at a checked public address, the connection receives that address, and a revoked server gets no new connection`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const mcp = McpService.withEpoch(world.storage, projects.epoch, options);
      const register = async (name: string, url: string) => (await mcp.register(owner, { commandId: cid("rg"), name, mode: "remote", transport: "streamable-http", protocolRevision: "2025-06-18", sdk: SDK, remote: { url, credentialRef: "docs.token", scopes: ["docs:read"] }, audience: [project], allowed: { tools: ["search"] } } as never)).id;
      const docs = await register("docs", "https://mcp.example.com:8443/v1");
      const answers: Record<string, string[][]> = {};
      const lookups: string[] = [];
      const resolve = async (host: string): Promise<string[]> => { lookups.push(host); const list = answers[host]!; return list[Math.min(lookups.filter((h) => h === host).length, list.length) - 1]!; };
      const connector = new RemoteMcpConnector({ mcp, resolve, principal: owner });

      // A public name: the transport gets the checked address, the port and the name for TLS, not the name to look up again.
      answers["mcp.example.com"] = [["93.184.216.34"]];
      const target = await connector.connect(docs, async (t) => t);
      assert.deepEqual([target.host, target.address, target.port, target.secure, target.registryName], ["mcp.example.com", "93.184.216.34", 8443, true, "docs"]);

      // A name that points at a private address is refused, and the transport is never called.
      answers["mcp.example.com"] = [["10.0.0.5"]];
      let used = false;
      await refuses(/internal address/, () => connector.connect(docs, async () => { used = true; }));
      answers["mcp.example.com"] = [["93.184.216.34", "169.254.169.254"]];
      await refuses(/internal address/, () => connector.connect(docs, async () => { used = true; }));
      assert.equal(used, false);

      // The rebinding pattern: public at the check, private at the second lookup (and the other way round).
      answers["mcp.example.com"] = [["93.184.216.34"], ["127.0.0.1"]];
      lookups.length = 0;
      await refuses(/internal address/, () => connector.connect(docs, async () => { used = true; }));
      assert.equal(lookups.length, 2, "it was the second lookup that was refused");
      assert.equal(used, false);
      // A rotating public name is fine, and the connection uses the first, checked address.
      answers["mcp.example.com"] = [["93.184.216.34"], ["93.184.216.35"]];
      lookups.length = 0;
      assert.equal(await connector.connect(docs, async (t) => t.address), "93.184.216.34");
      assert.equal(lookups.length, 2);

      // Another connection is checked again from the start.
      answers["mcp.example.com"] = [["93.184.216.34"]];
      lookups.length = 0;
      assert.equal((await connector.connect(docs, async (t) => t.address)), "93.184.216.34");

      // Not for an agent: the lookup of where a server is reached is staff only.
      await refuses(/may not look up/, () => mcp.remoteEndpoint(ann, docs));
      // A local or unknown server is not reached this way.
      await refuses(/no such MCP server/, () => connector.connect(docs.slice(0, -1) + (docs.endsWith("a") ? "b" : "a"), async () => undefined));

      // The owner revokes it: no new connection, and the transport is not called.
      await mcp.revoke(owner, { commandId: cid("rv"), serverId: docs, expectedRevision: 1 });
      used = false;
      await refuses(/revoked; no new connection/, () => connector.connect(docs, async () => { used = true; }));
      assert.equal(used, false);
    } finally { await world.close(); }
  });
}
