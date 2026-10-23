import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { connectPublic, resolvePublic } from "./network.js";

const refuses = async (code: string, run: () => Promise<unknown>, pattern?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (pattern !== undefined) assert.match(error.message, pattern); return true; });
};

test("a public name that resolves to a private address is not reached (DNS rebinding), whatever the form of the private address", async () => {
  for (const address of ["10.0.0.5", "127.0.0.1", "192.168.1.9", "169.254.169.254", "172.16.0.1", "::1", "fd00::1", "::ffff:10.1.2.3", "100.64.0.1"]) {
    await refuses("forbidden", () => resolvePublic("tools.example.org", async () => [address]), /internal address/);
  }
});

test("every address a name gives must be public, since a client may pick any of them", async () => {
  await refuses("forbidden", () => resolvePublic("tools.example.org", async () => ["93.184.216.34", "127.0.0.1"]));
  const ok = await resolvePublic("tools.example.org", async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
  assert.equal(ok.address, "93.184.216.34");
  assert.equal(ok.addresses.length, 2);
});

test("an internal name or address is refused without a lookup, and a name that resolves to nothing is never connected to", async () => {
  let lookups = 0;
  const resolve = async (): Promise<string[]> => { lookups++; return ["93.184.216.34"]; };
  for (const host of ["localhost", "db.internal", "printer.local", "intranet", "10.0.0.1", "[::1]"]) await refuses("forbidden", () => resolvePublic(host, resolve));
  assert.equal(lookups, 0);
  await refuses("unavailable", () => resolvePublic("nowhere.example.org", async () => []));
  assert.equal((await resolvePublic("93.184.216.34", resolve)).address, "93.184.216.34");
  assert.equal(lookups, 0, "a public address given directly needs no lookup");
});

test("the connection goes to the checked address itself: a second lookup that answers differently is never used", async () => {
  const answers = [["93.184.216.34"], ["10.0.0.5"]];
  let lookups = 0;
  const resolve = async (): Promise<string[]> => answers[Math.min(lookups++, 1)]!;
  const reached = await connectPublic("https://tools.example.org:8443/mcp", resolve, async (target) => target);
  assert.deepEqual(reached, { host: "tools.example.org", address: "93.184.216.34", port: 8443, secure: true });
  assert.equal(lookups, 1, "the name is looked up once");
  await refuses("forbidden", () => connectPublic("https://tools.example.org/mcp", async () => ["10.0.0.5"], async () => "connected"));
  await refuses("invalid_command", () => connectPublic("ftp://tools.example.org/", resolve, async () => 1));
  assert.deepEqual(await connectPublic("http://tools.example.org/", async () => ["93.184.216.34"], async (t) => t.port), 80);
});
