// G07: the task manifest is validated on every `npm test`: a well-formed acyclic DAG whose statuses are consistent, and a
// requirement-coverage matrix that names every accepted design area and only real cards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
const plan = JSON.parse(read("docs/nimblenewt/implementation-plan/task-plan.json"));
const cards = new Map(plan.tasks.map((t) => [t.id, t]));
const DONE = new Set(["implemented", "implemented-awaiting-signoff"]);

test("card IDs and parents are unique and well formed, and every card says what it delivers and how it is accepted", () => {
  assert.equal(cards.size, plan.tasks.length, "duplicate card ID");
  for (const t of plan.tasks) {
    assert.match(t.id, /^[A-Z]\d{1,2}[a-z]?$/, t.id);
    assert.match(t.parent, /^N\d{2}[a-z]?$/, `${t.id} parent`);
    assert.match(t.existing_issue, /^AII-\d+$/, `${t.id} issue`);
    assert.ok(t.title.trim() && t.deliverable.trim() && t.acceptance_and_verification.trim(), `${t.id} is missing text`);
    assert.ok(["planned", "implemented", "implemented-awaiting-signoff"].includes(t.status), `${t.id} has unknown status ${t.status}`);
  }
});

test("every dependency exists, none is on itself, and the graph has no cycle", () => {
  for (const t of plan.tasks) {
    assert.equal(new Set(t.depends_on).size, t.depends_on.length, `${t.id} lists a dependency twice`);
    for (const d of t.depends_on) { assert.ok(cards.has(d), `${t.id} depends on unknown card ${d}`); assert.notEqual(d, t.id, `${t.id} depends on itself`); }
  }
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2) return;
    assert.notEqual(state.get(id), 1, `dependency cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, 1);
    for (const d of cards.get(id).depends_on) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const id of cards.keys()) visit(id, []);
});

test("the plan has one root and one leaf, as recorded in G07", () => {
  const dependedOn = new Set(plan.tasks.flatMap((t) => t.depends_on));
  assert.deepEqual(plan.tasks.filter((t) => t.depends_on.length === 0).map((t) => t.id), ["G01"]);
  assert.deepEqual(plan.tasks.filter((t) => !dependedOn.has(t.id)).map((t) => t.id), ["D04"]);
});

test("a card marked implemented has every blocker implemented (or awaiting only sign-off), and carries evidence", () => {
  for (const t of plan.tasks.filter((x) => x.status !== "planned")) {
    for (const d of t.depends_on) assert.ok(DONE.has(cards.get(d).status), `${t.id} is marked ${t.status} but its blocker ${d} is ${cards.get(d).status}`);
    assert.ok(t.progress && typeof t.progress.reviewed_by === "string" && t.progress.reviewed_by.includes("not a human review"), `${t.id} must say its review was not a human review`);
    assert.ok((t.progress.commits ?? []).length > 0 || t.progress.pending_commit === true, `${t.id} records no commit`);
  }
});

const record = read("docs/nimblenewt/implementation-plan/g07-architecture-and-coverage.md");
const tableRows = (text) => text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Area") && !l.startsWith("| ---")).map((l) => l.split("|").map((c) => c.trim()).slice(1, -1));

test("the coverage matrix names every accepted design area exactly once, and only real cards", () => {
  const register = read("docs/nimblenewt/design-decisions.md");
  const accepted = register.slice(register.indexOf("## Accepted direction"), register.indexOf("## October 16 implementation baseline"));
  const areas = tableRows(accepted).map((r) => r[0]);
  const matrix = record.slice(record.indexOf("## Requirement coverage"), record.indexOf("### Areas the plan covers"));
  const rows = tableRows(matrix);
  assert.ok(areas.length >= 30, "the register's accepted-direction table was not found");
  assert.deepEqual(rows.map((r) => r[0]).sort(), [...areas].sort());
  for (const [area, list] of rows) {
    const ids = list.split(",").map((x) => x.trim());
    assert.ok(ids.length > 0 && ids.every(Boolean), `${area} lists no cards`);
    for (const id of ids) assert.ok(cards.has(id), `${area} names unknown card ${id}`);
  }
});

test("the architecture record's numbers match the manifest", () => {
  const level = new Map();
  const phase = (id) => { if (!level.has(id)) level.set(id, 1 + Math.max(0, ...cards.get(id).depends_on.map(phase))); return level.get(id); };
  for (const id of cards.keys()) phase(id);
  const parents = new Set(plan.tasks.map((t) => t.parent));
  assert.ok(record.includes(`${plan.tasks.length} cards under ${parents.size} workstream parents`), "card/parent counts are stale");
  assert.ok(record.includes(`${Math.max(...level.values())} dependency phases`), "phase count is stale");
});
