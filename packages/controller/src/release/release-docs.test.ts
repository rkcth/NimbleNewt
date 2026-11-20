import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { ReleaseService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-20T10:00:00.000Z", pause: async () => undefined };
const h = (c: string): string => c.repeat(64);
const manifest = (commit: string) => ({ sourceCommit: commit.repeat(40), suiteRevision: "s1", artifacts: { "a.tgz": h("1") }, dependencyLocks: { lock: h("2") }, matrix: [{ os: "linux", arch: "x64" }] });
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: a release candidate may name the project whose documents it carries and its version; both are part of the command, not the candidate (card Q03, next slice)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
      const release = ReleaseService.withEpoch(world.storage, projects.epoch, options);

      // Both or neither; the project must exist (nothing is recorded otherwise).
      await refuses("invalid_command", () => release.submit(owner, { commandId: "x1", manifest: manifest("a"), projectId: project } as never), /projectId and version go together/);
      await refuses("invalid_command", () => release.submit(owner, { commandId: "x2", manifest: manifest("a"), version: "2.0" } as never), /projectId and version go together/);
      await refuses("invalid_command", () => release.submit(owner, { commandId: "x3", manifest: manifest("a"), projectId: "not a project", version: "2.0" }));
      await refuses("not_found", () => release.submit(owner, { commandId: "x4", manifest: manifest("a"), projectId: "proj-aaaaaaaaaaaaaaaaaaaa", version: "2.0" }), /no such project/);
      assert.equal((await release.candidates(owner, { limit: 10 })).candidates.length, 0, "a refused submission records no candidate");

      const one = await release.submit(owner, { commandId: "s1", manifest: manifest("a"), projectId: project, version: "2.0" });
      assert.deepEqual([one.replayed, one.docs], [false, { projectId: project, version: "2.0" }]);
      // The candidate is the manifest's: the same manifest without a project is the same candidate.
      const plain = await release.submit(owner, { commandId: "s2", manifest: manifest("a") });
      assert.equal(plain.candidateId, one.candidateId);
      assert.equal(plain.docs, undefined);
      // The same command again is a repeat; the same command ID with another version or project is not the same command.
      const again = await release.submit(owner, { commandId: "s1", manifest: manifest("a"), projectId: project, version: "2.0" });
      assert.deepEqual([again.replayed, again.docs], [true, { projectId: project, version: "2.0" }]);
      await refuses("command_conflict", () => release.submit(owner, { commandId: "s1", manifest: manifest("a"), projectId: project, version: "2.1" }));
      await refuses("command_conflict", () => release.submit(owner, { commandId: "s2", manifest: manifest("a"), projectId: project, version: "2.0" }));
      // Only the owner submits.
      await principals.enroll(owner, { commandId: "e1", kind: "agent", name: "ann", grants: [] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      await refuses("forbidden", () => release.submit(ann, { commandId: "s3", manifest: manifest("b"), projectId: project, version: "2.0" }));
    } finally {
      await world.close();
    }
  });
}
