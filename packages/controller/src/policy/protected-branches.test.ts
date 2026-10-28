import assert from "node:assert/strict";
import { test } from "node:test";
import { branchesNamedIn, isProtectedBy, normalBranch } from "./protected-branches.js";

test("branch names are read the way git reads them, and what has no single reading is protected (card A07f)", () => {
  const list = ["main", "release/*"];
  for (const name of ["main", "refs/heads/main", "Main", "MAIN", "refs/heads/Release/1.0", "release/x"]) assert.equal(isProtectedBy(list, name), true, name);
  for (const name of ["heads/main", "main/", "/main", "refs/tags/v1", "refs/remotes/origin/main", "release//x", "a/../main", "", "HEAD", "@", "main@{0}", "-main", "x.lock", "a b", "a:b"]) assert.equal(isProtectedBy(list, name), true, `${name} has no single reading`);
  for (const name of ["feature-x", "mainline", "releases", "refs/heads/feature/main"]) assert.equal(isProtectedBy(list, name), false, name);
  assert.equal(normalBranch("refs/heads/Feature/X"), "feature/x");
});

test("the branches a call's arguments name are found, a refspec by its destination", () => {
  assert.deepEqual(branchesNamedIn({ branch: "a", ref: "HEAD:main", refspec: ["x:y", "z"] }).sort(), ["a", "main", "y", "z"]);
  assert.deepEqual(branchesNamedIn({ options: { into: "main" }, argv: ["push", "origin", "main"] }), ["main", "push", "origin", "main"], "any key, any depth");
  assert.deepEqual(branchesNamedIn(7), []);
});
