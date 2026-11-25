// The shape of .github/workflows/ci.yml (the typical tier, card X11): five parallel parts and a gate that keeps the job name the status checks use. No YAML library is needed:
// the file's own layout is fixed enough to read with patterns, and a change that breaks the layout fails here rather than in a cancelled run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tierSteps } from "./test-changed.mjs";

const text = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
const jobBlock = (name) => { const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, "m").exec(text); assert.ok(m !== null, `job ${name}`); return m[1]; };

test("every action is pinned to a commit and the token is read-only", () => {
  const uses = [...text.matchAll(/^\s*- uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@[0-9a-f]{40}$/, u);
  assert.match(text, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(text, /^\s*(?:contents|id-token|pull-requests|actions|packages): write/m);
  assert.match(text, /node-version: "22\.19\.0"/, "the minimum supported Node, which the environment test looks for");
});

test("the parts: one job per part, the matrix is exactly the part count the script is given, each part has a limit below the old one and the tests run with the network disabled", () => {
  const parts = jobBlock("parts");
  const count = /SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(parts);
  assert.ok(count !== null);
  const n = Number(count[1]);
  assert.deepEqual(JSON.parse(/shard: (\[[\d, ]+\])/.exec(parts)[1]), Array.from({ length: n }, (_, i) => i + 1));
  assert.match(parts, /fail-fast: false/, "one failing part must not hide the others");
  assert.match(parts, /timeout-minutes: (\d+)/);
  assert.ok(Number(/timeout-minutes: (\d+)/.exec(parts)[1]) <= 30);
  assert.match(parts, /unshare --net/);
  assert.match(parts, /node scripts\/test-changed\.mjs "\$5" "--shard=\$6"/);
  assert.match(parts, /fetch-depth: 0/, "the diff against the push's base needs history");
  assert.match(parts, /NIMBLENEWT_REQUIRE_SANDBOX=1/);
  // every part has something to run when everything is selected, and the root checks run in exactly one of them
  const packages = ["api", "config", "contracts", "controller", "integration", "pi-adapter", "registry", "ui", "worker"];
  const steps = Array.from({ length: n }, (_, i) => tierSteps("all", packages, i + 1, n));
  for (const [i, s] of steps.entries()) assert.ok(s.length > 0, `part ${i + 1} has work`);
  assert.equal(steps.filter((s) => s.some((x) => x.npm?.[1] === "check:deps")).length, 1);
});

test("the gate keeps the name the status checks use, waits for every part and fails unless all of them passed", () => {
  assert.match(text, /^    name: typical tier \(ubuntu \/ node 22\)$/m);
  const gate = jobBlock("test");
  assert.match(gate, /needs: parts/);
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/, "it must also run (and fail) when a part failed or was cancelled");
  assert.match(gate, /PARTS: \$\{\{ needs\.parts\.result \}\}/);
  assert.match(gate, /\[ "\$PARTS" = "success" \]/);
  assert.match(gate, /generate_task_plan\.py && git diff --exit-code docs\//);
  assert.match(text, /^  parts:\n/m);
});
