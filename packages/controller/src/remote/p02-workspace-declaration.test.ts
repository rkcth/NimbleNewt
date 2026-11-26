import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { declaredFolders, folderDigest, hostWorkspaceAdmission, workspaceDeclaration } from "./workspace-declaration.js";

// Card P02 (remote hosts, review): the product's reading of what a host declares, and of the folder admission's answer. Anything but a clear "admitted" is a refusal.
const P = "proj-abcdefghijklmnopqrst";
const Q = "proj-bcdefghijklmnopqrstu";
const call = (workspaces: readonly string[]) => ({ hostId: "host:r1", taskId: "task-abcdefghijklmnopqrst", projectId: P, workspaces });

test("a declaration is the digest of the folder as written; other projects' entries, other names and malformed entries are not read as this project's folder (card P02)", () => {
  assert.equal(folderDigest("/srv/a"), createHash("sha256").update("/srv/a", "utf8").digest("hex"));
  assert.equal(workspaceDeclaration(P, "/srv/a"), `repo:${P}:sha256:${folderDigest("/srv/a")}`);
  assert.equal(workspaceDeclaration("garden", "/srv/a"), undefined);
  assert.equal(workspaceDeclaration(P, ""), undefined);
  const d = folderDigest("/srv/a");
  assert.deepEqual(declaredFolders([`repo:${Q}:sha256:${d}`, "garden", `repo:${P}:sha256:${d.toUpperCase()}`, `repo:${P}:sha256:${d} `, `repo:${P}:sha256:${d}x`], P), []);
  assert.deepEqual(declaredFolders([workspaceDeclaration(P, "/srv/a")!, workspaceDeclaration(P, "/srv/a")!], P), [d], "the same folder twice is one folder");
  assert.deepEqual(declaredFolders(undefined, P), []);
});

test("an answer that is not a clear admission refuses, with a plain reason cut short; a throw is passed on for the caller to refuse on; none or two folders are refused without asking (card P02)", async () => {
  const one = [workspaceDeclaration(P, "/srv/a")!];
  for (const answer of [undefined, null, {}, { admitted: "yes" }, { admitted: 1 }, { admitted: false }]) {
    const reasons = await hostWorkspaceAdmission(async () => answer as never)(call(one));
    assert.equal(reasons.length, 1, JSON.stringify(answer));
    assert.match(reasons[0]!, /^host:r1 may not open this task's workspace: /);
  }
  const long = await hostWorkspaceAdmission(async () => ({ admitted: false, reason: "x".repeat(2000) }))(call(one));
  assert.ok(long[0]!.length <= 460, String(long[0]!.length));
  assert.deepEqual(await hostWorkspaceAdmission(async () => ({ admitted: true }))(call(one)), []);
  await assert.rejects(hostWorkspaceAdmission(async () => { throw new Error("unreadable"); })(call(one)), /unreadable/);
  let asked = 0;
  const counting = hostWorkspaceAdmission(async () => { asked++; return { admitted: true }; });
  assert.match((await counting(call([])))[0]!, /does not say which folder/);
  assert.match((await counting(call([workspaceDeclaration(P, "/srv/a")!, workspaceDeclaration(P, "/srv/b")!])))[0]!, /names more than one folder/);
  assert.equal(asked, 0);
});
