import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyRoadmap, phases, renderRoadmap } from "./roadmap.mjs";

const card = (id, depends_on = [], status = "planned", progress) => ({ id, title: `Card ${id}`, depends_on, status, ...(progress ? { progress } : {}) });

test("a card's phase is one more than the latest phase among its blockers", () => {
  const level = phases([card("A"), card("B", ["A"]), card("C", ["A"]), card("D", ["B", "C"]), card("E", ["D", "A"])]);
  assert.deepEqual([...level.entries()], [["A", 1], ["B", 2], ["C", 2], ["D", 3], ["E", 4]]);
});

test("the roadmap marks done, in-review and not-started cards, counts them, and lists blockers", () => {
  const text = renderRoadmap({ execution_note: "Work began on the owner's instruction.", tasks: [card("G01", [], "implemented"), card("G07", ["G01"], "implemented-awaiting-signoff", { roadmap_note: "needs QA" }), card("F01", ["G07"]), card("N00")] });
  assert.match(text, /Progress: \*\*1 of 3 tasks implemented\*\*, 1 awaiting sign-off\./);
  assert.match(text, /- \[x\] \*\*G01\*\* Card G01\n/);
  assert.match(text, /- \[~\] \*\*G07\*\* Card G07 _\(needs G01\)_ — needs QA\n/);
  assert.match(text, /- \[ \] \*\*F01\*\* Card F01 _\(needs G07\)_\n/);
  assert.ok(!text.includes("N00"), "the activation gate is not a roadmap task");
  assert.match(text, /> Work began on the owner's instruction\./);
  assert.match(text, /This section is generated from `task-plan.json`/);
  assert.ok(!text.includes("_Note: F01 started"), "the note about unclosed planning records goes away once G01 and G07 are done");
});

test("only the roadmap section of the README is replaced", () => {
  const readme = "# Title\n\n## Roadmap\n\nold\n\n## More detail\n\nkeep me\n";
  assert.equal(applyRoadmap(readme, "## Roadmap\n\nnew\n"), "# Title\n\n## Roadmap\n\nnew\n\n## More detail\n\nkeep me\n");
  assert.throws(() => applyRoadmap("# no roadmap here\n", "x"), /no Roadmap section/);
});

test("the README roadmap matches task-plan.json (run npm run roadmap:write after changing a card's status)", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const plan = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/nimblenewt/implementation-plan/task-plan.json", import.meta.url)), "utf8"));
  assert.equal(applyRoadmap(readme, renderRoadmap(plan)), readme);
});

test("every card in the plan is on the roadmap exactly once", () => {
  const plan = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/nimblenewt/implementation-plan/task-plan.json", import.meta.url)), "utf8"));
  const text = renderRoadmap(plan);
  for (const t of plan.tasks.filter((x) => x.id !== "N00")) assert.equal(text.split(`**${t.id}** `).length - 1, 1, `${t.id} should appear once`);
});
