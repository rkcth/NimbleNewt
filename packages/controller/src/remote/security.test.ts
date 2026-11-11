import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { workGrants } from "../dispatch/testing/world.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { READ, local, remoteSuite, wireRefuses } from "./testing/suite.js";

after(stopServer);

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("U11d: a host that names an attempt it never held is told to the security detectors (the refusal is unchanged, a former holder is routine, and the same pair is one signal key)", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const { attemptId } = await c.task("t", ann);
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const theirs = r2.client.attempt(attemptId!, offer.placement);
    await wireRefuses("not_found", () => theirs.begin(READ("c1")), 404);
    await wireRefuses("not_found", () => theirs.accept(), 404);
    assert.equal(c.security.detected.length, 2, JSON.stringify(c.security.detected));
    assert.ok(c.security.detected.every((d) => d.source === "host-channel" && d.event.kind === "credential-misused"));
    assert.equal(new Set(c.security.detected.map((d) => d.event.key)).size, 1, "the same host and attempt are the same key");
    assert.match(c.security.detected[0]!.event.key, /^host:.+>attempt:/);
    assert.doesNotMatch(JSON.stringify(c.security.detected), /token|secret|bearer/i);
    // The rightful host is not a signal.
    await r1.client.attempt(attemptId!, offer.placement).accept();
    assert.equal(c.security.detected.length, 2);
    // An attempt that does not exist at all is not a signal either (nothing was named that belongs to another).
    await wireRefuses("not_found", () => r2.client.attempt("att-aaaaaaaaaaaaaaaaaaaa", 1).accept(), 404);
    assert.equal(c.security.detected.length, 2);
  });

  suite("U11d: a host sends its own security report over the host channel; it is reported as that host, an unknown field and a bad shape are refused", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const a = await r1.client.reportSecurity({ kind: "protected-path-touched", key: "ws:landing:abc" }, "k1");
    assert.deepEqual(a, { itemId: "ntf-test", held: false });
    await r2.client.reportSecurity({ kind: "sandbox-escape-attempt", key: "x", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }, "k2");
    assert.deepEqual(c.security.reports.map((r) => [r.by, r.event.kind]), [[r1.id, "protected-path-touched"], [r2.id, "sandbox-escape-attempt"]], "each is reported as the host that sent it, never as another");
    await wireRefuses("invalid_command", () => r1.client.reportSecurity({ kind: "integrity-check-failed", key: "k", as: "host:r2" } as never), 400);
    await wireRefuses("invalid_command", () => r1.client.send("POST", "/worker/session/security", { body: { event: "nope" }, key: "k3", session: true }), 400);
    assert.equal(c.security.reports.length, 2);
  });

  suite("U11d (A08): a stored file that no longer hashes to its record is told to the detectors by artifact (no path, no content) while the fetch is refused as before; an undamaged file is silent", async (c) => {
    const bytes = (t: string) => new TextEncoder().encode(t);
    const good = await c.artifacts.publish({ commandId: "in-1", actor: c.owner.id, name: "good", projectId: c.project, files: [{ path: "a.txt", content: bytes("aaaa") }, { path: "b.txt", content: bytes("bbbb") }] });
    const r1 = await c.host("r1");
    r1.worker.inputs = () => [good.id];
    const { attempt } = await c.started(r1);
    assert.equal(Buffer.from(await attempt.fetchFile(good.id, "b.txt")).toString(), "bbbb");
    assert.equal(c.security.detected.length, 0, "an undamaged file is silent");
    const a = c.blobs.pathOf((await c.artifacts.get(good.id))!.entries.find((e) => e.path === "a.txt")!.digest);
    chmodSync(a, 0o666); writeFileSync(a, "AAAA");
    await wireRefuses("integrity", () => attempt.fetchFile(good.id, "a.txt"), 500);
    await wireRefuses("integrity", () => attempt.fetchFile(good.id, "a.txt"), 500);
    assert.equal(c.security.detected.length, 2);
    assert.ok(c.security.detected.every((d) => d.source === "artifact-store" && d.event.kind === "integrity-check-failed" && d.event.key === `artifact:${good.id}`), JSON.stringify(c.security.detected));
    assert.doesNotMatch(JSON.stringify(c.security.detected), /a\.txt|AAAA/);
  });

  suite("U11d (A08): a worker whose fetched file does not hash to the controller's digest refuses it and reports the failed check as itself, once per artifact and file, with a key that holds neither path nor bytes", async (c) => {
    const good = await c.artifacts.publish({ commandId: "in-1", actor: c.owner.id, name: "good", projectId: c.project, files: [{ path: "a.txt", content: new TextEncoder().encode("aaaa") }] });
    const r1 = await c.host("r1");
    r1.worker.inputs = () => [good.id];
    const { attempt } = await c.started(r1);
    const send = r1.client.send.bind(r1.client);
    r1.client.send = (async (method: string, path: string, call?: never) => { const r = await send(method, path, call); return path.includes("/file") ? { ...r, raw: Buffer.from("evil bytes") } : r; }) as typeof r1.client.send;
    await wireRefuses("integrity", () => attempt.fetchFile(good.id, "a.txt"));
    await wireRefuses("integrity", () => attempt.fetchFile(good.id, "a.txt"));
    // The report is sent without waiting, so it arrives a moment after the refusal (longer under load).
    for (let i = 0; i < 250 && c.security.reports.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(c.security.reports.length >= 1 && c.security.reports.length <= 2, `reported ${c.security.reports.length} times; the controller's watch tells one event once by its key`);
    assert.ok(c.security.reports.every((r) => r.by === r1.id && r.event.kind === "integrity-check-failed" && /^fetch:art-[a-z2-7]+:[0-9a-f]{24}$/.test(r.event.key)), JSON.stringify(c.security.reports));
    assert.equal(new Set(c.security.reports.map((r) => r.event.key)).size, 1);
    assert.doesNotMatch(JSON.stringify(c.security.reports), /a\.txt|evil/);
  });
}
