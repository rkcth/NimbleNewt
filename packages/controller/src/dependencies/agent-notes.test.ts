import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { entriesLook } from "../continuation/resume-observer.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EventService } from "../events/events.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { DependencyNotes, DependencyService, RecentTexts, keptText, type ManifestBody, type ResourceReading } from "./index.js";

// Card L04g: an agent names what its work relied on and the controller looks and fills in what it saw (a file's hash and text, a folder's names, a search's digest, a record's hash, an external
// resource's hash and ETag), checking anything the agent gives against what it finds; what the controller cannot look at is recorded only with the agent's own word.

after(stopServer);
const options = { clock: () => "2026-11-17T09:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const H = (s: string): string => createHash("sha256").update(s).digest("hex");
const SECRET = ["s", "k", "-", "live", "-"].join("") + "Q7w9".repeat(8);
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, message?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (message !== undefined) assert.match(error.message, message); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: the controller looks at what the agent names and records it as it is; a wrong hash, a missing file and a caller without the right are refused before anything is looked at or recorded`, async () => {
    const world = await backend.open();
    const root = mkdtempSync(join(tmpdir(), "nn-note-"));
    const dir = join(root, "checkout");
    mkdirSync(join(dir, "beds"), { recursive: true });
    writeFileSync(join(dir, "guide.md"), `# Guide\nkey=${SECRET}\n`, "utf8");
    writeFileSync(join(dir, "beds", "north"), "lettuce", "utf8");
    writeFileSync(join(root, "outside.txt"), "not yours", "utf8");
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
      const agent = async (nm: string, g: Grant[]): Promise<Principal> => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
      const ann = await agent("ann", [{ action: "attempt.work", project: a }, { action: "desk.write", project: a }, { action: "desk.read", project: a }]);
      const eve = await agent("eve", [{ action: "desk.read", project: a }]);
      const desks = DeskService.withEpoch(world.storage, epoch, options);
      const retrieval = RetrievalService.withEpoch(world.storage, epoch, desks, HistoryService.withEpoch(world.storage, epoch, options), options);
      const events = EventService.withEpoch(world.storage, epoch, options);
      const deps = DependencyService.withEpoch(world.storage, epoch, { ...options, searches: {
        reader: (id) => principals.current(id),
        digest: async (reader, projectId, query) => (await retrieval.searchDigest(reader, { projectId, query })).hash,
        position: async (projectId) => { const at = await events.since(`project:${projectId}`, Number.MAX_SAFE_INTEGER, 1); return { next: at.head, floor: at.floor }; },
      } });
      const recent = new RecentTexts();
      let looks = 0; let reads = 0;
      const look = entriesLook({ manifest: async () => undefined, placedHostOf: async () => undefined, remoteHostIds: new Set(), binding: async () => ({ root: dir, paths: [] }), keep: (t, e, bytes) => recent.set(t, e, keptText(bytes), H(Buffer.from(bytes).toString("utf8"))) });
      // The stand-in for the owner-allowed read of external resources: one URL answers, one is not allowed.
      const resources = async (manifest: ManifestBody): Promise<ResourceReading> => {
        reads++;
        const out: ResourceReading = { observations: {}, texts: {}, protocols: {} };
        for (const e of manifest.entries) {
          if (e.key === "https://docs.example.com/frost") { out.observations[e.id] = { exists: true, hash: H("Plant after the last frost."), etag: "\"v1\"" }; out.texts[e.id] = "Plant after the last frost."; } else out.observations[e.id] = { unread: "the owner has not allowed a resume check to read external or MCP resources (setting resume.externalReads)" };
        }
        return out;
      };
      const notes = new DependencyNotes({ dependencies: deps, look: async (t, e) => { looks++; return await look(t, e); }, textAt: (t, e, h) => recent.at(t, e, h), resources: async (m) => await resources(m) });
      const note = (by: Principal, dependencies: unknown[]) => notes.note(by, { commandId: cid("n"), taskId: task, dependencies: dependencies as never });
      const record = (await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "Soil", body: "needs lime", visibility: "shared", status: "accepted" } as never)).id;

      // Someone who may not work the task: refused, and nothing was looked at or read for them.
      await refuses("forbidden", () => note(eve, [{ kind: "file", key: "guide.md" }, { kind: "external", key: "https://docs.example.com/frost" }]));
      assert.deepEqual([looks, reads], [0, 0]);

      const done = await note(ann, [
        { kind: "file", key: "guide.md" }, { kind: "directory", key: "beds" }, { kind: "record", key: record }, { kind: "search", key: "soil lime", query: "lime" },
        { kind: "external", key: "https://docs.example.com/frost" }, { kind: "external", key: "https://other.example.com/x", etag: "\"o1\"" },
      ]);
      assert.equal(done.recorded, 6);
      assert.deepEqual(done.entries.map((e) => [e.kind, e.checkedBy]), [["file", "controller"], ["directory", "controller"], ["record", "controller"], ["search", "controller"], ["external", "controller"], ["external", "recorder"]]);
      assert.match(done.entries[5]!.why!, /owner has not allowed/);
      const m = (await deps.get(owner, task))!;
      const by = (kind: string, key: string) => m.entries.find((e) => e.kind === kind && e.key === key)!;
      assert.equal(by("file", "guide.md").hash, H(`# Guide\nkey=${SECRET}\n`), "the controller's own hash of the file");
      assert.deepEqual(by("directory", "beds").members, ["north"]);
      assert.equal(by("record", record).hash, H("needs lime"));
      assert.equal(by("search", "soil lime").scope?.query, "lime");
      assert.deepEqual([by("external", "https://docs.example.com/frost").hash, by("external", "https://docs.example.com/frost").etag, by("external", "https://docs.example.com/frost").freshness], [H("Plant after the last frost."), "\"v1\"", "conditional-read"]);
      assert.deepEqual([by("external", "https://other.example.com/x").etag, by("external", "https://other.example.com/x").hash], ["\"o1\"", undefined], "the recorder's word when the controller could not read it");
      // The text the controller read is kept beside the entry, redacted; none for what it did not read.
      const kept = await deps.textOf(task, by("file", "guide.md"));
      assert.ok(kept !== undefined && kept.startsWith("# Guide\nkey="), String(kept));
      assert.equal(kept!.includes(SECRET), false, "a secret in the file is not kept");
      assert.equal(await deps.textOf(task, by("external", "https://docs.example.com/frost")), "Plant after the last frost.");
      assert.equal(await deps.textOf(task, by("external", "https://other.example.com/x")), undefined);
      // A text kept for an older hash is not the entry's once it is recorded again with another.
      writeFileSync(join(dir, "guide.md"), "# Guide v2\n", "utf8");
      await note(ann, [{ kind: "file", key: "guide.md" }]);
      assert.equal(await deps.textOf(task, (await deps.get(owner, task))!.entries.find((e) => e.key === "guide.md")!), "# Guide v2\n");

      // What the agent gives must be what the controller finds; a wrong hash refuses the whole note and records nothing of it.
      const count = (await deps.get(owner, task))!.entries.length;
      await refuses("invalid_command", () => note(ann, [{ kind: "file", key: "beds/north" }, { kind: "file", key: "guide.md", hash: H("something else") }]), /is not what the file holds now/);
      await refuses("invalid_command", () => note(ann, [{ kind: "record", key: record, hash: H("old text") }]), /not the record's content/);
      await refuses("invalid_command", () => note(ann, [{ kind: "directory", key: "beds", members: ["south"] }]), /are not what the folder holds/);
      await refuses("invalid_command", () => note(ann, [{ kind: "file", key: "nothing-here.md" }]), /there is no nothing-here\.md/);
      await refuses("invalid_command", () => note(ann, [{ kind: "external", key: "https://docs.example.com/frost", hash: H("older") }]), /is not what the resource holds now/);
      // Outside the checkout the controller does not look: without a hash it is refused, with one it is the agent's word.
      await refuses("invalid_command", () => note(ann, [{ kind: "file", key: "../outside.txt" }]), /could not look at that file/);
      await refuses("invalid_command", () => note(ann, [{ kind: "external", key: "https://other.example.com/y" }]), /did not read it .*give its hash or ETag/);
      assert.equal((await deps.get(owner, task))!.entries.length, count, "nothing of a refused note was recorded");
      const word = await note(ann, [{ kind: "file", key: "../outside.txt", hash: H("not yours") }]);
      assert.equal(word.entries[0]!.checkedBy, "recorder");
      assert.equal(await deps.textOf(task, (await deps.get(owner, task))!.entries.find((e) => e.key === "../outside.txt")!), undefined, "no text is kept for what the controller did not read");
      // The same note sent again (a retried call with its command ID) records once: the manifest and the kept text stay as the first recorded them, even when the file changed in between;
      // the same command ID for a different note is a conflict.
      writeFileSync(join(dir, "beds", "north"), "lettuce", "utf8");
      const again = { commandId: cid("n-again"), taskId: task, dependencies: [{ kind: "file", key: "beds/north" }] as never };
      assert.equal((await notes.note(ann, again)).recorded, 1);
      const first = (await deps.get(owner, task))!.entries.find((e) => e.key === "beds/north")!;
      writeFileSync(join(dir, "beds", "north"), "lettuce and kale", "utf8");
      assert.equal((await notes.note(ann, again)).recorded, 1);
      const second = (await deps.get(owner, task))!.entries.find((e) => e.key === "beds/north")!;
      assert.deepEqual([second.hash, second.observedAt], [first.hash, first.observedAt], "a replay records nothing new");
      assert.equal(await deps.textOf(task, second), "lettuce");
      await refuses("command_conflict", () => notes.note(ann, { ...again, dependencies: [{ kind: "file", key: "guide.md" }] as never }));
      // Bounds and shapes.
      await refuses("invalid_command", () => note(ann, Array.from({ length: 21 }, (_, i) => ({ kind: "file", key: `f${i}` }))), /1 to 20/);
      await refuses("invalid_command", () => note(ann, [{ kind: "tool-version", key: "x" }]), /must be one of/);
      await refuses("invalid_command", () => note(ann, [{ kind: "file", key: "a", extra: 1 }]));
    } finally { rmSync(root, { recursive: true, force: true }); await world.close(); }
  });
}
