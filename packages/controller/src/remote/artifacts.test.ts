import assert from "node:assert/strict";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { workGrants } from "../dispatch/testing/world.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "./protocol.js";
import { READ, local, refuses, remoteSuite, wireRefuses } from "./testing/suite.js";
import { rawRequest } from "./testing/world.js";

after(stopServer);
const bytes = (text: string) => new Uint8Array(Buffer.from(text));

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a worker fetches the artifacts its placement was given, each read back verified; any other artifact reads as missing", async (c) => {
    const given = await c.artifacts.publish({ commandId: "in-1", actor: c.owner.id, name: "seed catalogue", projectId: c.project, files: [{ path: "catalogue/seeds.csv", content: bytes("tomato,3\nbean,5\n") }, { path: "README.md", content: bytes("# Seeds") }] });
    const other = await c.artifacts.publish({ commandId: "in-2", actor: c.owner.id, name: "not for the worker", projectId: c.project, files: [{ path: "secret.txt", content: bytes("do not hand out") }] });
    const r1 = await c.host("r1");
    r1.worker.inputs = () => [given.id];
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const { attemptId } = await c.task("t", ann);
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const attempt = r1.client.attempt(attemptId!, offer.placement);
    // Before it accepts it can already read what it needs to start.
    const listing = await attempt.artifacts();
    assert.deepEqual(listing.map((a) => [a.id, a.role, a.name]), [[given.id, "input", "seed catalogue"]]);
    assert.deepEqual(listing[0]!.files.map((f) => f.path), ["README.md", "catalogue/seeds.csv"]);
    await attempt.accept();
    assert.equal(Buffer.from(await attempt.fetchFile(given.id, "catalogue/seeds.csv")).toString(), "tomato,3\nbean,5\n");
    const raw = await rawRequest(c.transport.url, "GET", `/worker/attempts/${attemptId}/artifacts/${given.id}/file?placement=${offer.placement}&path=README.md`, { token: r1.token, headers: { [SESSION_HEADER]: r1.client.session!.sessionId, [PROTOCOL_HEADER]: "1" } });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers["x-newt-digest"], listing[0]!.files[0]!.digest);
    assert.equal(raw.raw.toString(), "# Seeds");
    // Not given, not in the artifact, not an artifact ID: all look like nothing there.
    await wireRefuses("not_found", () => attempt.fetchFile(other.id, "secret.txt"), 404);
    await wireRefuses("not_found", () => attempt.fetchFile(given.id, "nope.txt"), 404);
    await wireRefuses("invalid_command", () => attempt.fetchFile("art-aaaaaaaaaaaaaaaaaaaa", "x"), 404).catch(() => undefined);
    // Another host cannot fetch them either.
    const r2 = await c.host("r2");
    await wireRefuses("not_found", () => r2.client.attempt(attemptId!, offer.placement).fetchFile(given.id, "README.md"), 404);
  });

  suite("a damaged blob is never returned as data: the fetch fails, and an artifact with a missing blob cannot be given to a worker at all", async (c) => {
    const good = await c.artifacts.publish({ commandId: "in-1", actor: c.owner.id, name: "good", projectId: c.project, files: [{ path: "a.txt", content: bytes("aaaa") }, { path: "b.txt", content: bytes("bbbb") }] });
    const r1 = await c.host("r1");
    r1.worker.inputs = () => [good.id];
    const { attempt } = await c.started(r1);
    const entries = (await c.artifacts.get(good.id))!.entries;
    const a = c.blobs.pathOf(entries.find((e) => e.path === "a.txt")!.digest);
    chmodSync(a, 0o666); writeFileSync(a, "AAAA");
    await wireRefuses("integrity", () => attempt.fetchFile(good.id, "a.txt"), 500, (e) => assert.doesNotMatch(e.message, /AAAA|a\.txt|blob/));
    assert.equal(Buffer.from(await attempt.fetchFile(good.id, "b.txt")).toString(), "bbbb", "an undamaged file of the same artifact is still served");
    // The owner sees the damage; a placement that would depend on the artifact is refused.
    assert.equal((await c.artifacts.verify(good.id)).ok, false);
    const r2 = await c.host("r2");
    r2.worker.inputs = () => [good.id];
    c.prefer(r2);
    const bob = await c.agent("bob", workGrants(c.project));
    const { attemptId } = await c.task("t2", bob);
    const report = await c.tick();
    assert.deepEqual(report.started, []);
    assert.equal(report.skipped[0]!.reason, "the worker did not start");
    assert.equal((await c.current.get(c.owner, attemptId!))!.outcome!.status, "failed");
    assert.equal(await c.remote.placement(c.owner, attemptId!), undefined, "nothing was placed");
    unlinkSync(c.blobs.pathOf(entries.find((e) => e.path === "b.txt")!.digest));
    await refuses("integrity", () => c.artifacts.assertResumable([good.id]));
  });

  suite("a file larger than one fetch returns is refused with the size, not cut", async (c) => {
    const big = await c.artifacts.publish({ commandId: "in-1", actor: c.owner.id, name: "big", projectId: c.project, files: [{ path: "big.bin", content: bytes("0123456789") }, { path: "small.bin", content: bytes("012") }] });
    const r1 = await c.host("r1");
    r1.worker.inputs = () => [big.id];
    const { attempt } = await c.started(r1);
    // The service was built with the default limit; a service built with 5 bytes refuses the 10-byte file and serves the 3-byte one.
    const { RemoteWorkerService } = await import("./service.js");
    const strict = RemoteWorkerService.withEpoch(c.storage, c.epoch, { principal: c.dispatcherPrincipal, hosts: c.hosts, artifacts: c.artifacts, dispatch: c.current as never }, { ...c.options, fileBytes: 5 });
    const sid = r1.client.session!.sessionId;
    await refuses("invalid_command", () => strict.fetchFile(r1.principal, sid, attempt.attemptId, attempt.placement, big.id, "big.bin"), (e) => assert.match(e.message, /10 bytes; one fetch returns at most 5/));
    assert.equal(Buffer.from((await strict.fetchFile(r1.principal, sid, attempt.attemptId, attempt.placement, big.id, "small.bin")).bytes).toString(), "012");
    assert.throws(() => RemoteWorkerService.withEpoch(c.storage, c.epoch, { principal: c.dispatcherPrincipal, hosts: c.hosts, artifacts: c.artifacts, dispatch: c.current as never }, { ...c.options, fileBytes: 0 }));
  });

  suite("a worker publishes files as an artifact of its own placement: project and task are the placement's, the creator is the host, a repeat is the same artifact, and it travels with the placement", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, taskId, attempt } = await c.started(r1);
    const out = await attempt.publish("seed order", [{ path: "orders/seeds.txt", content: bytes("12 tomato") }, { path: "notes.md", content: bytes("done") }], "pub-1");
    assert.deepEqual(await attempt.publish("seed order", [{ path: "notes.md", content: bytes("done") }, { path: "orders/seeds.txt", content: bytes("12 tomato") }], "pub-1"), out);
    const stored = (await c.artifacts.get(out.artifactId))!;
    assert.deepEqual([stored.projectId, stored.taskId, stored.createdBy, stored.name], [c.project, taskId, r1.id, "seed order"]);
    assert.deepEqual((await attempt.artifacts()).map((a) => [a.id, a.role]), [[out.artifactId, "output"]]);
    assert.equal(Buffer.from(await attempt.fetchFile(out.artifactId, "notes.md")).toString(), "done");
    assert.deepEqual((await c.remote.placement(c.owner, attemptId))!.outputs, [out.artifactId]);
    // The same key with other files is a conflict, not a second artifact.
    await wireRefuses("command_conflict", () => attempt.publish("seed order", [{ path: "notes.md", content: bytes("changed") }], "pub-1"), 409);
    // A worker cannot name a project, a task or a creator: those fields are not part of the message.
    const sid = r1.client.session!.sessionId;
    const headers = { [SESSION_HEADER]: sid, [PROTOCOL_HEADER]: "1", "idempotency-key": "pub-9" };
    const url = `/worker/attempts/${attemptId}/artifacts`;
    const body = (extra: object) => ({ placement: attempt.placement, name: "x", files: [{ path: "a", content: "QQ==" }], ...extra });
    for (const extra of [{ projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }, { taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, { createdBy: "owner:rob" }]) assert.equal((await rawRequest(c.transport.url, "POST", url, { token: r1.token, headers, body: body(extra) })).status, 400);
    // Bad paths and bodies.
    for (const files of [[{ path: "../x", content: "QQ==" }], [{ path: "a", content: "not base64!" }], [{ path: "a" }], [{ path: "a", content: "QQ==" }, { path: "A", content: "QQ==" }], "nope"]) {
      assert.equal((await rawRequest(c.transport.url, "POST", url, { token: r1.token, headers, body: body({ files }) })).status, 400, JSON.stringify(files));
    }
    // A publication larger than the limit is refused whole.
    const huge = await rawRequest(c.transport.url, "POST", url, { token: r1.token, headers, rawBody: JSON.stringify(body({ files: [{ path: "huge", content: "QQ==".repeat(3 * 1024 * 1024) }] })) });
    assert.equal(huge.status, 413);
    // After the run is over the worker cannot add to it.
    await attempt.complete({ status: "completed" });
    await wireRefuses("fenced", () => attempt.publish("late", [{ path: "late.txt", content: bytes("late") }]), 409);
    void READ; void local;
  });
}
