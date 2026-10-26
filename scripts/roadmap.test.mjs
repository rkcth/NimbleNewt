import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PARTS, applyRoadmap, bar, phases, renderRoadmap } from "./roadmap.mjs";

const card = (id, depends_on = [], status = "planned", progress, parent = "N01") => ({ id, parent, title: `Card ${id}`, depends_on, status, ...(progress ? { progress } : {}) });

test("a card's phase is one more than the latest phase among its blockers", () => {
  const level = phases([card("A"), card("B", ["A"]), card("C", ["A"]), card("D", ["B", "C"]), card("E", ["D", "A"])]);
  assert.deepEqual([...level.entries()], [["A", 1], ["B", 2], ["C", 2], ["D", 3], ["E", 4]]);
});

test("the roadmap marks done, in-review and not-started cards, counts them, and lists blockers", () => {
  const text = renderRoadmap({ execution_note: "Work began on the owner's instruction.", tasks: [card("G01", [], "implemented"), card("G07", ["G01"], "implemented-awaiting-signoff", { roadmap_note: "needs QA" }), card("F01", ["G07"]), card("N00")] });
  assert.match(text, /Progress: \*\*1 of 3 tasks implemented\*\*, 1 awaiting sign-off\./);
  assert.match(text, /- \[x\] \*\*G01\*\* · P1 · Card G01\n/);
  assert.match(text, /- \[~\] \*\*G07\*\* · P2 · Card G07 _\(needs G01\)_ — needs QA\n/);
  assert.match(text, /- \[ \] \*\*F01\*\* · P3 · Card F01 _\(needs G07\)_\n/);
  assert.ok(!text.includes("N00"), "the activation gate is not a roadmap task");
  assert.match(text, /> Work began on the owner's instruction\./);
  assert.match(text, /This section is generated from `task-plan.json`/);
  assert.match(text, /_Note: F01 started.*G07 is still not fully closed\._/, "the note names the planning record that is still open");
  const closed = renderRoadmap({ tasks: [card("G01", [], "implemented"), card("G07", ["G01"], "implemented"), card("F01", ["G07"], "implemented")] });
  assert.ok(!closed.includes("_Note: F01 started"), "the note goes away once G01 and G07 are both fully implemented");
  const both = renderRoadmap({ tasks: [card("G01"), card("G07", ["G01"]), card("F01", ["G07"], "implemented")] });
  assert.match(both, /G01 and G07 are still not fully closed/);
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

test("each major part is one expandable block with its bar and its own cards, and the table above lists every part with its share", () => {
  const plan = { tasks: [card("A", [], "implemented"), card("B", ["A"], "implemented-awaiting-signoff"), card("C", ["B"]), card("D", [], "planned", undefined, "N02"), card("E", ["D"], "implemented", undefined, "N02")] };
  const text = renderRoadmap(plan);
  assert.match(text, /\| Scope and early proofs \| `[▓▒░]{12}` 33% \| 1 of 3 \|/);
  assert.match(text, /\| Foundation: storage, configuration and builds \| `[▓▒░]{12}` 50% \| 1 of 2 \|/);
  const blocks = text.split("<details>").slice(1);
  assert.equal(blocks.length, 2, "only parts that have cards get a block");
  assert.match(blocks[0], /<summary><strong>Scope and early proofs<\/strong> — [▓▒░]{12} 1 of 3<\/summary>/);
  assert.ok(blocks[0].includes("**A** ") && blocks[0].includes("**B** ") && blocks[0].includes("**C** ") && !blocks[0].includes("**D** "), "a part lists its own cards only");
  assert.ok(blocks[0].indexOf("**A** ") < blocks[0].indexOf("**C** "), "cards are in dependency order");
  assert.match(blocks[0], /<\/details>/);
  assert.ok(!text.includes("<summary>`"), "no markdown inside summaries: it would show as raw backticks");
});

test("the progress bar fills in proportion, shows sign-off cards as half cells and is always twelve cells", () => {
  assert.equal(bar(0, 0, 4), "░".repeat(12));
  assert.equal(bar(4, 0, 4), "▓".repeat(12));
  assert.equal(bar(2, 0, 4), "▓".repeat(6) + "░".repeat(6));
  assert.equal(bar(1, 1, 4), "▓".repeat(3) + "▒".repeat(3) + "░".repeat(6));
  assert.equal(bar(0, 0, 0), "░".repeat(12));
  assert.equal(bar(12, 0, 15), "▓".repeat(9) + "░".repeat(3), "no sign-off cards, no half cells");
  assert.equal(bar(1, 0, 15), "▓" + "░".repeat(11), "one finished card of fifteen is one filled cell, not empty and not awaiting sign-off");
  assert.ok(!bar(1, 0, 15).includes("▒"));
  assert.ok(bar(0, 1, 15).includes("▒"), "a single card awaiting sign-off is visible");
  for (const [d, r, n] of [[1, 0, 3], [2, 1, 7], [5, 5, 11], [0, 3, 3]]) assert.equal([...bar(d, r, n)].length, 12);
});

test("every workstream of the plan has a named part, and a card under an unnamed workstream is an error", () => {
  const plan = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/nimblenewt/implementation-plan/task-plan.json", import.meta.url)), "utf8"));
  const named = new Set(PARTS.map(([id]) => id));
  for (const t of plan.tasks.filter((x) => x.id !== "N00")) assert.ok(named.has(t.parent), `${t.id} is under ${t.parent}, which has no name in PARTS`);
  assert.equal(new Set(PARTS.map(([id]) => id)).size, PARTS.length, "no workstream is named twice");
  assert.throws(() => renderRoadmap({ tasks: [card("A", [], "planned", undefined, "N99")] }), /no name in PARTS: N99/);
});
