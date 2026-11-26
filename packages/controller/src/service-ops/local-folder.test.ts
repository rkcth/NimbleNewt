import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { EffectRejected } from "../domain/effects.js";
import { serviceOpLine, serviceOpOf } from "../status/status.js";
import { EffectService } from "../domain/effects.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { LOCAL_FOLDER_KEYS, LOCAL_FOLDER_LIMITS, LocalFolderServices, ServiceOperations, type ServiceAction, type ServiceRef, type ServiceTarget } from "./index.js";

// Card P03b: a ServiceTarget for a real kind of system, the files of one folder on this computer. An effect is confirmed only by reading the file back from the disk; nothing outside the bound folder
// is read or written (links, hard links and names that leave the folder are refused); a neighbour that cannot be read, or a folder with more files than the neighbour check covers, refuses the action
// before anything is written; a file that cannot be read back afterwards ends uncertain. The ledger, the scope and the outcome rules are the ones every target goes through (`ServiceOperations`).

after(stopServer);

// The connector refuses to bind on Windows (its link and mode checks are made and tested on Linux and macOS only), so its tests run there only; the refusal itself is tested everywhere.
const posixOnly = process.platform === "win32" ? "the folder connector refuses to bind on Windows" : false;

let now = Date.parse("2026-11-26T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const digestOf = (path: string): string => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)}`;

/** Everything under a folder (names, kinds, contents, link targets), so a test can say nothing changed. The connector's own keys folder is left out when asked. */
function tree(dir: string, skipKeys = false): string {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (skipKeys && rel === "" && name === LOCAL_FOLDER_KEYS) continue;
      const p = join(d, name), s = lstatSync(p), r = `${rel}/${name}`;
      if (s.isSymbolicLink()) out.push(`${r} -> link`);
      else if (s.isDirectory()) { out.push(`${r}/`); walk(p, r); } else out.push(`${r} = ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return out.join("\n");
}

/** A bound folder with a `billing` service (a JSON settings file, a text file, a note) and, beside the bound folder, an `outside` folder the connector must never touch. */
function folders(): { base: string; root: string; outside: string; billing: string } {
  const base = mkdtempSync(join(tmpdir(), "nn-p03b-folder-"));
  const root = join(base, "services"), outside = join(base, "outside"), billing = join(root, "billing");
  mkdirSync(billing, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(billing, "settings.json"), `${JSON.stringify({ replicas: 1, mode: "slow" }, null, 2)}\n`);
  writeFileSync(join(billing, "motd.txt"), "Back soon.\n");
  writeFileSync(join(billing, "notes.txt"), "keep me\n");
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  return { base, root, outside, billing };
}

/** A target that does what the connector does and then something to the disk (a link swapped in, a neighbour changed, a lost answer), to show how the ledger settles each. */
function after_(inner: ServiceTarget, then: (ref: ServiceRef) => void | "lose"): ServiceTarget & { armed: boolean } {
  const t = {
    armed: true,
    observe: (r: ServiceRef) => inner.observe(r), affects: (r: ServiceRef, a: ServiceAction) => inner.affects(r, a), neighbours: (r: ServiceRef) => inner.neighbours(r),
    applied: (k: string) => inner.applied(k), verify: (r: ServiceRef, a: ServiceAction, b: Parameters<ServiceTarget["verify"]>[2], x: Parameters<ServiceTarget["verify"]>[3]) => inner.verify(r, a, b, x),
    apply: async (k: string, r: ServiceRef, a: ServiceAction, c?: JsonObject) => {
      await inner.apply(k, r, a, c);
      if (!t.armed) return;
      t.armed = false;
      if (then(r) === "lose") throw new Error("the connection dropped before the answer arrived");
    },
  };
  return t;
}

async function world(backend: (typeof backends)[number], target: ServiceTarget) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Tune billing" })).id;
  const effects = EffectService.withEpoch(w.storage, projects.epoch, undefined, { ...options, holder: "service-ops" });
  const ops = ServiceOperations.withEpoch(w.storage, projects.epoch, { effects, target, fenceOf: async () => undefined }, options);
  const op = (resource: string, action: ServiceAction, commandId = cid("op"), service = "billing") => ops.operate(owner, { commandId, taskId: task, service, resource, action });
  return { w, owner, task, ops, op, effects };
}

test("the connector reads a file back as the disk holds it and refuses names, links and hard links that leave the bound folder, without following them (card P03b)", { skip: posixOnly }, async () => {
  const f = folders();
  try {
    const t = await LocalFolderServices.open(f.root);
    const seen = await t.observe({ service: "billing", resource: "settings.json" });
    assert.equal(seen?.systemVersion, digestOf(join(f.billing, "settings.json")), "the version is the digest of the bytes on the disk");
    assert.deepEqual(seen?.state["fields"], { replicas: 1, mode: "slow" });
    assert.equal(await t.observe({ service: "billing", resource: "nothing" }), undefined, "a missing file is absent");
    assert.equal(await t.observe({ service: "nobody", resource: "x" }), undefined, "a missing service is absent");
    // Names that are not plain names never reach the disk.
    for (const ref of [{ service: "..", resource: "outside" }, { service: "billing", resource: "../../outside/secret.txt" }, { service: "billing", resource: ".hidden" }, { service: "Billing", resource: "x" }]) {
      await assert.rejects(t.observe(ref), /not a plain service and resource name/, JSON.stringify(ref));
      await assert.rejects(t.apply(cid("k"), ref, { type: "write", params: { text: "x" } }), /not a plain service and resource name/, JSON.stringify(ref));
    }
    // A link (to a file or a folder outside) and a hard link are reported unreadable, with a version that never matches another reading: never followed, never hidden as absent.
    symlinkSync(join(f.outside, "secret.txt"), join(f.billing, "link"));
    symlinkSync(f.outside, join(f.root, "evil"));
    linkSync(join(f.outside, "secret.txt"), join(f.billing, "hard"));
    for (const ref of [{ service: "billing", resource: "link" }, { service: "evil", resource: "secret.txt" }, { service: "billing", resource: "hard" }]) {
      const a = await t.observe(ref), b = await t.observe(ref);
      assert.match(String(a?.state["unreadable"]), /link|outside|not followed/, JSON.stringify(ref));
      assert.equal(a?.state["text"], undefined, "nothing of the outside file is read");
      assert.notEqual(a?.systemVersion, b?.systemVersion, "an unreadable resource never reads the same twice");
    }
    // The neighbour list is the rest of the same service folder, plain names only, at most the bound.
    assert.deepEqual((await t.neighbours({ service: "billing", resource: "settings.json" })).map((r) => r.resource), ["hard", "link", "motd.txt", "notes.txt"]);
    assert.deepEqual(await t.neighbours({ service: "evil", resource: "secret.txt" }), [], "a linked service folder has no neighbours: it is not listed");
    // The bound folder itself must be a real folder.
    await assert.rejects(LocalFolderServices.open(join(f.root, "evil")), /not a folder/);
    await assert.rejects(LocalFolderServices.open(join(f.base, "missing")), /not a folder/);
    assert.equal(readFileSync(join(f.outside, "secret.txt"), "utf8"), "not yours\n");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

for (const backend of backends) {
  test(`${backend.name}: an operation on a folder service is confirmed only by reading the file back, applies once per command and is named as a verified outcome (card P03b)`, { skip: posixOnly }, async () => {
    const f = folders();
    const target = await LocalFolderServices.open(f.root, { clock: options.clock });
    const w = await world(backend, target);
    try {
      const notesBefore = readFileSync(join(f.billing, "notes.txt"), "utf8");
      const set = await w.op("settings.json", { type: "set", params: { fields: { replicas: 3 } } }, "set-1");
      assert.equal(set.status, "confirmed", JSON.stringify(set));
      assert.deepEqual(JSON.parse(readFileSync(join(f.billing, "settings.json"), "utf8")), { replicas: 3, mode: "slow" }, "the file holds the merged fields");
      assert.equal(set.outcome?.systemVersion, digestOf(join(f.billing, "settings.json")), "the version named is the one read back from the disk");
      assert.equal(set.evidence?.["verified"], true);
      assert.equal(set.evidence?.["collateralChecked"], 2, "the other two files of the service were compared before and after");
      await w.ops.checkOutcome(w.task, set.outcome!);
      // The same command again applies nothing again: the file is not rewritten (same inode) and one key is recorded.
      const inode = lstatSync(join(f.billing, "settings.json")).ino;
      const again = await w.op("settings.json", { type: "set", params: { fields: { replicas: 3 } } }, "set-1");
      assert.equal(again.effectId, set.effectId);
      assert.equal(lstatSync(join(f.billing, "settings.json")).ino, inode, "not written a second time");
      assert.equal(readdirSync(join(f.root, LOCAL_FOLDER_KEYS)).length, 1);
      // A whole new text.
      const write = await w.op("motd.txt", { type: "write", params: { text: "We are open.\n" } }, "write-1");
      assert.equal(write.status, "confirmed", JSON.stringify(write));
      assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "We are open.\n");
      assert.equal(readFileSync(join(f.billing, "notes.txt"), "utf8"), notesBefore, "the neighbour was not touched");
      // Through service.observe the agent and the owner read what the disk holds.
      const read = await w.ops.observe(w.owner, { taskId: w.task, service: "billing", resource: "motd.txt" });
      assert.equal(read.state["text"], "We are open.\n");
      // A lost answer is settled by asking the connector and reading the file back, never by writing again.
      const lossy = after_(target, () => "lose");
      const w2 = await world(backend, lossy);
      try {
        const lost = await w2.op("motd.txt", { type: "write", params: { text: "Closed.\n" } }, "lost-1");
        assert.equal(lost.status, "confirmed", JSON.stringify(lost));
        assert.equal(lost.evidence?.["verified"], true);
        assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "Closed.\n");
      } finally { await w2.w.close(); }
    } finally { await w.w.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test(`${backend.name}: a folder service refuses before writing anything when the file, a neighbour or the folder cannot be checked, and an unreadable read-back is never confirmed (card P03b)`, { skip: posixOnly }, async () => {
    const f = folders();
    const target = await LocalFolderServices.open(f.root, { clock: options.clock });
    const w = await world(backend, target);
    try {
      symlinkSync(join(f.outside, "secret.txt"), join(f.billing, "link"));
      mkdirSync(join(f.root, "shop"));
      writeFileSync(join(f.root, "shop", "cart.json"), "{}\n");
      linkSync(join(f.outside, "secret.txt"), join(f.root, "shop", "hard"));
      symlinkSync(f.outside, join(f.root, "evil"));
      const outside = tree(f.outside);
      // Each refused before the disk is written: `failed`, the reason in the service's words, nothing changed anywhere.
      const refusedCases: [string, string, ServiceAction, RegExp][] = [
        ["billing", "link", { type: "write", params: { text: "pwned" } }, /link, which is not followed/],
        ["evil", "secret.txt", { type: "write", params: { text: "pwned" } }, /service folder is a link/],
        ["shop", "hard", { type: "write", params: { text: "pwned" } }, /hard link/],
        // A neighbour that cannot be read (a hard link) would hide a change to it: refused.
        ["shop", "cart.json", { type: "set", params: { fields: { items: 1 } } }, /neighbour shop\/hard cannot be read/],
        ["billing", "motd.txt", { type: "set", params: { fields: { a: 1 } } }, /does not hold a JSON object/],
        ["billing", "motd.txt", { type: "delete" }, /not known to a folder service/],
        ["billing", "motd.txt", { type: "write", params: { text: "x".repeat(LOCAL_FOLDER_LIMITS.fileBytes + 1) } }, /larger than/],
      ];
      // billing has the link as a neighbour too: take it away for the plain cases after the first one.
      for (const [i, [service, resource, action, why]] of refusedCases.entries()) {
        if (i === 1) unlinkSync(join(f.billing, "link"));
        const before = tree(f.root, true);
        const r = await w.op(resource, action, cid("refused"), service);
        assert.equal(r.status, "failed", `${service}/${resource}: ${JSON.stringify(r)}`);
        assert.match(String(r.evidence?.["reason"]), why, `${service}/${resource}`);
        assert.match(String(r.evidence?.["reason"]), /nothing was changed/);
        assert.equal(tree(f.root, true), before, `${service}/${resource}: nothing in the bound folder changed`);
        assert.equal(tree(f.outside), outside, `${service}/${resource}: nothing outside changed`);
      }
      // A folder with more files than the neighbour check covers: refused, nothing written.
      mkdirSync(join(f.root, "crowd"));
      for (let i = 0; i <= LOCAL_FOLDER_LIMITS.neighbours + 1; i++) writeFileSync(join(f.root, "crowd", `f${String(i).padStart(3, "0")}`), "{}");
      const crowdBefore = tree(join(f.root, "crowd"));
      const crowded = await w.op("f000", { type: "write", params: { text: "{\"a\":1}" } }, cid("crowd"), "crowd");
      assert.equal(crowded.status, "failed");
      assert.match(String(crowded.evidence?.["reason"]), /holds 51 other files, more than the 50 the neighbour check covers/);
      assert.equal(tree(join(f.root, "crowd")), crowdBefore);

      // After the change: the file swapped for a link, the file gone, a neighbour changed. None is confirmed; each is uncertain with the reason, never retried.
      const swaps: [string, (ref: ServiceRef) => void, RegExp][] = [
        ["link", (r) => { const p = join(f.root, r.service, r.resource); unlinkSync(p); symlinkSync(join(f.outside, "secret.txt"), p); }, /cannot be read back: the file is a link/],
        ["gone", (r) => unlinkSync(join(f.root, r.service, r.resource)), /cannot be read back/],
        ["rewritten", (r) => writeFileSync(join(f.root, r.service, r.resource), "someone else's text\n"), /reads 20 bytes that are not the text written/],
        ["neighbour", () => writeFileSync(join(f.billing, "notes.txt"), "someone else\n"), /outside the scope changed: billing\/notes.txt/],
        ["unreadable", (r) => chmodSync(join(f.root, r.service, r.resource), 0o000), /cannot be read back: the file cannot be read/],
      ];
      for (const [label, swap, why] of swaps) {
        if (label === "unreadable" && process.getuid?.() === 0) continue; // root reads a file whatever its mode
        writeFileSync(join(f.billing, `${label}.txt`), "before\n");
        const wrapped = await world(backend, after_(target, swap));
        try {
          const r = await wrapped.op(`${label}.txt`, { type: "write", params: { text: "after\n" } }, `swap-${label}`);
          assert.equal(r.status, "uncertain", `${label}: ${JSON.stringify(r)}`);
          assert.equal(r.outcome, undefined, `${label}: no outcome can be named`);
          assert.match(String(r.evidence?.["reason"] ?? r.note), why, `${label}: ${JSON.stringify(r)}`);
          await assert.rejects(wrapped.ops.checkOutcome(wrapped.task, { reference: r.effectId, systemVersion: "sha256:x", observedAt: "2026-11-26T10:00:00.000Z" }), (e: unknown) => e instanceof DomainError && /uncertain, not confirmed/.test(e.message));
          await assert.rejects(wrapped.op(`${label}.txt`, { type: "write", params: { text: "after\n" } }, `swap-${label}`), (e: unknown) => e instanceof DomainError && e.code === "effect_uncertain", `${label}: never retried blindly`);
          if (label === "rewritten") {
            // A person settles it as confirmed, with evidence that reads like a verification: it is still not a verified outcome, and the view says a person settled it.
            const fake = { verified: true, systemVersion: "sha256:0000000000000000", observedAt: "2026-11-26T10:00:00.000Z", checked: "by hand" };
            await wrapped.effects.resolve({ commandId: cid("resolve"), actor: wrapped.owner.id, effectId: r.effectId, outcome: "confirmed", evidence: fake });
            await assert.rejects(wrapped.ops.checkOutcome(wrapped.task, { reference: r.effectId, systemVersion: fake.systemVersion, observedAt: fake.observedAt }), /not verified against the target/);
            const settled = await wrapped.effects.get(r.effectId);
            const view = serviceOpOf(settled as never, settled?.evidence);
            assert.equal(view.verified, false);
            assert.match(serviceOpLine({ id: r.effectId, status: "confirmed", service: view }, "you"), /Settled by a person, not by reading the service back/);
          }
        } finally { await wrapped.w.close(); rmSync(join(f.billing, `${label}.txt`), { force: true }); }
      }
      assert.equal(tree(f.outside), outside, "nothing outside the bound folder was ever written");
    } finally { await w.w.close(); rmSync(f.base, { recursive: true, force: true }); }
  });
}

test("whether a key was applied is read from the connector's own record; an unreadable record is not taken for 'not applied' (card P03b)", { skip: posixOnly || (process.getuid?.() === 0 ? "root reads a file whatever its mode" : false) }, async () => {
  const f = folders();
  try {
    const t = await LocalFolderServices.open(f.root);
    const ref = { service: "billing", resource: "motd.txt" };
    assert.equal(await t.applied("k1"), false);
    await t.apply("k1", ref, { type: "write", params: { text: "one\n" } }, { baseline: { "billing/notes.txt": "sha256:x" } });
    assert.deepEqual(await t.applied("k1"), { applied: true, context: { baseline: { "billing/notes.txt": "sha256:x" } } });
    // The same key again writes nothing, whatever it asks.
    await t.apply("k1", ref, { type: "write", params: { text: "two\n" } });
    assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "one\n");
    const keys = join(f.root, LOCAL_FOLDER_KEYS);
    const record = join(keys, readdirSync(keys)[0]!);
    chmodSync(record, 0o000);
    await assert.rejects(t.applied("k1"), /cannot be read/, "unknown, so the ledger keeps the effect pending and asks again");
    await assert.rejects(t.apply("k1", ref, { type: "write", params: { text: "three\n" } }), /cannot be read/, "and nothing is applied while it is unknown");
    assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "one\n");
    chmodSync(record, 0o600);
    // A keys folder that is a link is refused before the file is replaced.
    rmSync(keys, { recursive: true });
    symlinkSync(f.outside, keys);
    await assert.rejects(t.apply("k2", ref, { type: "write", params: { text: "four\n" } }), /keys folder is not a real folder/);
    assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "one\n");
    assert.deepEqual(readdirSync(f.outside), ["secret.txt"], "nothing was written through the link");
    assert.deepEqual(readdirSync(f.billing).filter((x) => x.startsWith(".")), [], "the staged file was removed");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("the connector refuses to bind on Windows, where its link and mode checks are not made (card P03b review)", async () => {
  const base = mkdtempSync(join(tmpdir(), "nn-p03b-win-"));
  try {
    await assert.rejects(LocalFolderServices.open(base, { platform: "win32" }), /not available on Windows/);
    assert.deepEqual(readdirSync(base), [], "nothing was made");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a folder or file swapped in while a change is being made is never written into or moved, and two changes to one file run one after the other (card P03b review)", { skip: posixOnly }, async () => {
  const f = folders();
  try {
    const ref = { service: "billing", resource: "motd.txt" };
    const outside = tree(f.outside);
    const moved = join(f.root, "billing-moved");
    const swapFolder = (): void => { renameSync(f.billing, moved); mkdirSync(f.billing); cpSync(moved, f.billing, { recursive: true }); for (const n of readdirSync(f.billing)) if (n.startsWith(".")) rmSync(join(f.billing, n)); };
    const reset = (): void => { rmSync(f.billing, { recursive: true, force: true }); renameSync(moved, f.billing); for (const n of readdirSync(f.billing)) if (n.startsWith(".")) rmSync(join(f.billing, n)); };
    let at: "staged" | "recorded" | undefined, then: (() => void) | undefined;
    const t = await LocalFolderServices.open(f.root, { onStep: (step) => { if (step === at && then !== undefined) { const run = then; then = undefined; run(); } } });

    // The service folder swapped after the new text was staged: refused before the key is recorded; neither folder is changed.
    at = "staged"; then = swapFolder;
    await assert.rejects(t.apply("swap-staged", ref, { type: "write", params: { text: "changed\n" } }), (e: unknown) => e instanceof EffectRejected && /service folder was replaced/.test(e.message) && /nothing was changed/.test(e.message));
    assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "Back soon.\n");
    assert.equal(readFileSync(join(moved, "motd.txt"), "utf8"), "Back soon.\n");
    assert.equal(await t.applied("swap-staged"), false, "no key was recorded");
    reset();

    // The service folder swapped after the key was recorded: the new file is not put in place in either folder; the key over-reports (the read-back then decides), it never under-reports.
    at = "recorded"; then = swapFolder;
    await assert.rejects(t.apply("swap-recorded", ref, { type: "write", params: { text: "changed\n" } }), (e: unknown) => !(e instanceof EffectRejected) && /service folder was replaced/.test((e as Error).message));
    assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "Back soon.\n");
    assert.equal(readFileSync(join(moved, "motd.txt"), "utf8"), "Back soon.\n");
    assert.notEqual(await t.applied("swap-recorded"), false);
    const back = await t.observe(ref);
    assert.notEqual(t.verify(ref, { type: "write", params: { text: "changed\n" } }, back!, back!), undefined, "the read-back does not confirm it");
    reset();

    // The staged new text swapped for a link to a file outside: refused, the outside file is not moved in or changed.
    at = "staged"; then = () => { const tmp = readdirSync(f.billing).find((n) => n.startsWith(".nn-"))!; unlinkSync(join(f.billing, tmp)); symlinkSync(join(f.outside, "secret.txt"), join(f.billing, tmp)); };
    await assert.rejects(t.apply("swap-link", ref, { type: "write", params: { text: "changed\n" } }), /staged new text was replaced/);
    assert.equal(readFileSync(join(f.billing, "motd.txt"), "utf8"), "Back soon.\n");
    assert.equal(lstatSync(join(f.billing, "motd.txt")).isSymbolicLink(), false);
    assert.equal(tree(f.outside), outside);
    assert.deepEqual(readdirSync(f.billing).filter((n) => n.startsWith(".")), [], "the link put in its place was removed, not followed");

    // Two changes to one file at once: the second merges into what the first wrote (nothing is lost, neither is refused).
    at = undefined;
    const settings = { service: "billing", resource: "settings.json" };
    await Promise.all([t.apply("set-a", settings, { type: "set", params: { fields: { a: 1 } } }), t.apply("set-b", settings, { type: "set", params: { fields: { b: 2 } } })]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.billing, "settings.json"), "utf8")), { replicas: 1, mode: "slow", a: 1, b: 2 });

    // The bound folder itself replaced by another folder at the same path: nothing in it is read as a service, and nothing is written.
    renameSync(f.root, `${f.root}-old`); mkdirSync(join(f.root, "billing"), { recursive: true }); writeFileSync(join(f.root, "billing", "motd.txt"), "new root\n");
    const seen = await t.observe(ref);
    assert.match(String(seen?.state["unreadable"]), /no longer the folder bound at the start/);
    await assert.rejects(t.apply("new-root", ref, { type: "write", params: { text: "changed\n" } }), /no longer the folder bound at the start/);
    assert.equal(readFileSync(join(f.root, "billing", "motd.txt"), "utf8"), "new root\n");
    assert.deepEqual(readdirSync(f.root), ["billing"], "no keys folder was made in the new one");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
