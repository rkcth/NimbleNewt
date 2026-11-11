import assert from "node:assert/strict";
import { test } from "node:test";
import { providerAddressBook } from "./launcher.js";

// Review of the W10 wiring: the launcher's model client refreshes the recorded provider addresses before every chat turn and every second-agent call, and these run concurrently. A refresh must never leave the map
// empty while it reads, or a call that looks its route up meanwhile finds no endpoint and fails (the chat is unavailable, or the second agent is not run).

test("a refresh keeps the old addresses while it reads and swaps in the new ones in one step; with no controller yet it keeps what it has", async () => {
  let release: (() => void) | undefined;
  let records: { provider: string; endpoint: string; credentialName?: string }[] | undefined = [{ provider: "local", endpoint: "http://127.0.0.1:8002/v1" }];
  let slow = false;
  const book = providerAddressBook(async () => { if (slow) await new Promise<void>((ok) => { release = ok; }); return records; });
  await book.refresh();
  assert.equal(book.endpoints.get("local")?.endpoint, "http://127.0.0.1:8002/v1");

  slow = true;
  records = [{ provider: "local", endpoint: "http://127.0.0.1:9000/v1" }, { provider: "cloud", endpoint: "https://api.example.invalid/v1", credentialName: "cloud-key" }];
  const pending = book.refresh();
  await new Promise((ok) => setImmediate(ok));
  assert.equal(book.endpoints.get("local")?.endpoint, "http://127.0.0.1:8002/v1", "while the read is in flight the old address is still there");
  release!();
  await pending;
  assert.equal(book.endpoints.get("local")?.endpoint, "http://127.0.0.1:9000/v1");
  assert.deepEqual(book.endpoints.get("cloud"), { endpoint: "https://api.example.invalid/v1", credentialName: "cloud-key" });

  slow = false;
  records = [{ provider: "cloud", endpoint: "https://api.example.invalid/v1" }];
  await book.refresh();
  assert.equal(book.endpoints.has("local"), false, "a provider no longer recorded is dropped");
  records = undefined;
  await book.refresh();
  assert.equal(book.endpoints.has("cloud"), true, "no controller yet: nothing is dropped");
});
