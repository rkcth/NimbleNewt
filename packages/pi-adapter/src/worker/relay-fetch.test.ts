import assert from "node:assert/strict";
import { test } from "node:test";
import type { FromChild } from "@nimblenewt/contracts";
import { relayFetch } from "./relay-fetch.js";

// Card G08: when the lease ends the process fails its model calls in flight AND tells the host to abort each one. The host holds the real call to the model; without the abort it went on reading the reply (and the model on writing it) after
// the lease ended, until the host stopped the attempt, which a remote host that cannot reach its controller does only minutes later.

test("closeAll fails every call in flight and asks the host to abort each one; a call already answered is not aborted, and a later call is refused once the relay refuses", async () => {
  const sent: FromChild[] = [];
  const relay = relayFetch("http://relay.local", (m) => { sent.push(m); });
  const a = relay.fetch("http://relay.local/m0/chat/completions", { method: "POST", body: "{}" });
  const b = relay.fetch("http://relay.local/m0/chat/completions", { method: "POST", body: "{}" });
  const c = relay.fetch("http://relay.local/m0/chat/completions", { method: "POST", body: "{}" });
  await new Promise((ok) => setImmediate(ok));
  const ids = sent.filter((m) => m.t === "fetch").map((m) => (m as { id: number }).id);
  assert.equal(ids.length, 3);
  // the third call is answered in full before the lease ends
  relay.accept({ t: "fetch.head", id: ids[2]!, status: 200, statusText: "OK", headers: [] } as never);
  relay.accept({ t: "fetch.end", id: ids[2]! } as never);
  assert.equal((await c).status, 200);
  relay.refuse("the lease ended (silent)");
  relay.closeAll("the lease ended (silent)");
  await assert.rejects(a, /the lease ended \(silent\)/);
  await assert.rejects(b, /the lease ended \(silent\)/);
  assert.deepEqual(sent.filter((m) => m.t === "fetch.abort").map((m) => (m as { id: number }).id).sort(), [ids[0], ids[1]].sort(), "each call in flight, and only those, is aborted at the host");
  // nothing is aborted twice, and nothing new leaves
  relay.closeAll("again");
  assert.equal(sent.filter((m) => m.t === "fetch.abort").length, 2);
  await assert.rejects(relay.fetch("http://relay.local/m0/chat/completions", { method: "POST", body: "{}" }), /the lease ended/);
  assert.equal(sent.filter((m) => m.t === "fetch").length, 3);
});

test("a call whose reply is streaming is aborted at the host by closeAll, and its stream fails in the process", async () => {
  const sent: FromChild[] = [];
  const relay = relayFetch("http://relay.local", (m) => { sent.push(m); });
  const p = relay.fetch("http://relay.local/m0/chat/completions", { method: "POST", body: "{}" });
  await new Promise((ok) => setImmediate(ok));
  const id = (sent.find((m) => m.t === "fetch") as { id: number }).id;
  relay.accept({ t: "fetch.head", id, status: 200, statusText: "OK", headers: [["content-type", "text/event-stream"]] } as never);
  const response = await p;
  relay.accept({ t: "fetch.chunk", id, data: Buffer.from("data: {}\n\n").toString("base64") } as never);
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  relay.closeAll("the lease ended (explicit)");
  await assert.rejects(reader.read(), /the lease ended \(explicit\)/);
  assert.deepEqual(sent.filter((m) => m.t === "fetch.abort").map((m) => (m as { id: number }).id), [id]);
});

test("a send that throws (the channel is gone) does not stop closeAll from failing the other calls", async () => {
  let broken = false;
  const relay = relayFetch("http://relay.local", (m) => { if (broken && m.t === "fetch.abort") throw new Error("the channel is closed"); });
  const a = relay.fetch("http://relay.local/m0/x", { method: "POST", body: "{}" });
  const b = relay.fetch("http://relay.local/m0/x", { method: "POST", body: "{}" });
  await new Promise((ok) => setImmediate(ok));
  broken = true;
  relay.closeAll("the channel closed");
  await assert.rejects(a, /the channel closed/);
  await assert.rejects(b, /the channel closed/);
});
