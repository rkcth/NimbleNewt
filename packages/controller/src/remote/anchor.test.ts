import assert from "node:assert/strict";
import { after } from "node:test";
import { findAnchors } from "../context/anchor.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DispatcherDeps } from "../dispatch/dispatcher.js";
import type { WorkOrder } from "../dispatch/ports.js";
import type { RelocationPolicyFor } from "./service.js";
import { FULL_ABILITIES, remoteSuite, type Ctx } from "./testing/suite.js";

after(stopServer);

// W12 follow-up: a remote worker re-inserts the goal anchor after each context cut. Nothing new goes over the wire: the offer already holds the whole order (its content opens with the block) and the sealed dispatch contract naming the
// block's digest, which the worker checks before it starts. The worker host (`@nimblenewt/worker` `withOrderAnchor`) hands its process the block the contract names. These tests prove, over the real worker protocol on every storage
// backend, that each placement's offer carries exactly that pair intact, that a new placement (a move to another host) carries it again, and that with the owner's switch off neither is sent.

const on: NonNullable<DispatcherDeps["anchor"]> = { plan: async () => ({ maxChars: 2400 }) };
const off: NonNullable<DispatcherDeps["anchor"]> = { plan: async () => undefined };
const open: RelocationPolicyFor = async () => ({ dataHosts: ["host:r2"] });

/** The block a worker host takes from an order: the one in its content whose digest the contract names (the worker's `orderAnchor` rule, restated; `integration/w12-remote-anchor.test.ts` runs the real one). */
const named = (order: WorkOrder): string | undefined => { const d = order.contract?.anchorDigest; return d === undefined ? undefined : findAnchors(order.content).find((a) => a.digest === d)?.text; };

async function twoHosts(c: Ctx) {
  const r1 = await c.host("r1");
  const r2 = await c.host("r2");
  r1.worker.requirements = () => ({ data: "local-only", harness: "pi", isolation: ["bubblewrap"], workspaces: ["garden"] });
  r2.worker.requirements = r1.worker.requirements;
  return { r1, r2 };
}

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("each placement's offer carries the anchor at the top of the order and the sealed contract naming it, the worker confirms that contract, and a move to another host offers the anchor again under the new placement (W12 follow-up)", async (c) => {
    const { r1, r2 } = await twoHosts(c);
    const s = await c.started(r1, "Order seeds");
    const found = findAnchors(s.order.content);
    assert.equal(found.length, 1, "one block in the order the worker was offered");
    assert.equal(found[0]!.at, 0, "at the top");
    assert.ok(s.order.content.startsWith(`${found[0]!.text}\n\nOrder seeds`));
    assert.equal(s.order.contract?.anchorDigest, found[0]!.digest, "the contract that came over the wire names it");
    assert.equal(named(s.order), found[0]!.text, "what the worker hands its process");
    const record = (await c.remote.placement(c.owner, s.attemptId))!;
    assert.equal(record.contract?.digest, s.order.contract?.digest, "the placement holds the contract whose digest covers the anchor's");
    assert.ok(record.contract?.launched !== undefined, "and the worker confirmed it");
    const rec = (await c.current.get(c.owner, s.attemptId))!;
    assert.deepEqual(rec.anchors?.map((a) => a.digest), [found[0]!.digest], "the attempt records it");
    // A move to another host is a new placement with its own offer: the anchor travels again with it, and the new host confirms that contract.
    await s.attempt.putCheckpoint(1, { turn: 1 });
    const moved = await c.remote.relocate(c.owner, { commandId: `mv-${s.attemptId.slice(-4)}`, attemptId: s.attemptId, toHostId: r2.id, reason: "r1 is being retired" });
    assert.equal(moved.placement, s.placement + 1);
    assert.deepEqual((await c.tick()).started, [s.attemptId]);
    const offer = (await r2.client.offers()).find((o) => o.order.attemptId === s.attemptId)!;
    assert.ok(offer, "the new host was offered the attempt");
    assert.equal(offer.placement, moved.placement);
    const again = findAnchors(offer.order.content);
    assert.equal(again.length, 1, "still exactly one block");
    assert.equal(again[0]!.at, 0);
    assert.equal(offer.order.contract?.anchorDigest, again[0]!.digest);
    assert.equal(again[0]!.text, found[0]!.text, "the same records give the same block");
    const next = r2.client.attempt(s.attemptId, offer.placement);
    await next.accept();
    assert.deepEqual(await next.honorContract(offer.order, FULL_ABILITIES, c.clock.now()), { ok: true });
    assert.equal(named(offer.order), again[0]!.text);
  }, { anchor: on, policy: open });

  suite("with the owner's switch off the offer carries no anchor and the contract names none, so the worker starts its process as before (W12 follow-up)", async (c) => {
    const r1 = await c.host("r1");
    const s = await c.started(r1, "Order seeds");
    assert.deepEqual(findAnchors(s.order.content), []);
    assert.equal(s.order.contract?.anchorDigest, undefined);
    assert.equal(named(s.order), undefined);
    assert.ok(s.order.content.startsWith("Order seeds"));
  }, { anchor: off });
}

