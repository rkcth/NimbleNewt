import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WHOLE, engines, partName, share } from "./g04-fixture.js";

// The G04 sweeps divided among files (g04-kill-*-part2, g04-tool-*-not-again) must together run exactly the points one file ran before: none lost, none twice.
test("the parts of a divided sweep are together exactly its points, each in one part, each spread over the whole list", () => {
  for (const count of [0, 1, 2, 3, 38, 127]) {
    const points = Array.from({ length: count }, (_, i) => i * 3 + 1);
    assert.deepEqual(share(points, WHOLE), points, "one part is the whole sweep");
    for (const of of [2, 3, 5]) {
      const parts = Array.from({ length: of }, (_, k) => share(points, { index: k + 1, of }));
      assert.deepEqual(parts.flat().sort((a, b) => a - b), points, `${count} points in ${of} parts: every point once`);
      for (const p of parts) assert.ok(p.length >= Math.floor(count / of) && p.length <= Math.ceil(count / of), `${count} in ${of}: about equal parts`);
      if (count >= of * 2) for (const p of parts) assert.ok(p[0]! < points[of]! && p.at(-1)! > points[count - of - 1]!, "each part reaches both ends of the path");
    }
  }
  for (const bad of [{ index: 0, of: 2 }, { index: 3, of: 2 }, { index: 1, of: 0 }, { index: 1.5, of: 2 }]) assert.throws(() => share([1, 2], bad), /invalid part/);
  assert.equal(partName(WHOLE), "");
  assert.equal(partName({ index: 2, of: 2 }), " (part 2 of 2)");
});

// `share` alone does not show that the files ask for the right parts: two kill files both asking for part 1 of 2, or two tool files for the same sweep,
// would leave half the boundaries (or a whole sweep) run nowhere and pass. Each g04-kill-* and g04-tool-* source file is read here: it must hold exactly one
// call, and for each engine the kill files must be the parts 1..n of one n, each once, and the tool files one "both" or the two sweeps, each once.
test("the divided G04 kill and tool files together ask for every part and every sweep of each engine exactly once", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(src).filter((f) => /^g04-(kill|tool)-.*\.test\.ts$/.test(f)).sort();
  const kill = new Map<string, { index: number; of: number; heavy: string; file: string }[]>();
  const tool = new Map<string, { sweeps: string; heavy: string; file: string }[]>();
  for (const file of files) {
    const text = readFileSync(src + file, "utf8");
    const kills = [...text.matchAll(/defineKillTests\(\s*"([^"]+)"\s*,\s*(true|false)\s*,\s*\{\s*index:\s*(\d+)\s*,\s*of:\s*(\d+)\s*\}\s*\)/g)];
    const tools = [...text.matchAll(/defineToolKillTests\(\s*"([^"]+)"\s*,\s*(true|false)\s*,\s*"([^"]+)"\s*\)/g)];
    const calls = (text.match(/define(Tool)?KillTests\(/g) ?? []).length;
    assert.equal(kills.length + tools.length, 1, `${file}: one call naming the engine, heavy and the part or sweep`);
    assert.equal(calls, 1, `${file}: no other call`);
    for (const m of kills) kill.set(m[1]!, [...(kill.get(m[1]!) ?? []), { index: Number(m[3]), of: Number(m[4]), heavy: m[2]!, file }]);
    for (const m of tools) tool.set(m[1]!, [...(tool.get(m[1]!) ?? []), { sweeps: m[3]!, heavy: m[2]!, file }]);
  }
  const names = engines.map((e) => e.name).sort();
  assert.deepEqual([...kill.keys()].sort(), names, "every engine has kill files, and no file names an unknown engine");
  assert.deepEqual([...tool.keys()].sort(), names, "every engine has tool files, and no file names an unknown engine");
  for (const [engine, parts] of kill) {
    const of = parts[0]!.of;
    assert.ok(parts.every((p) => p.of === of), `${engine}: the kill files divide the sweep the same way`);
    assert.deepEqual(parts.map((p) => p.index).sort((a, b) => a - b), Array.from({ length: of }, (_, i) => i + 1), `${engine}: each of the ${of} kill parts in exactly one file`);
    assert.equal(new Set(parts.map((p) => p.heavy)).size, 1, `${engine}: the kill parts are all heavy or all not`);
  }
  for (const [engine, runs] of tool) {
    const sweeps = runs.map((r) => r.sweeps).sort();
    assert.ok(JSON.stringify(sweeps) === JSON.stringify(["both"]) || JSON.stringify(sweeps) === JSON.stringify(["not presented again", "presented again"]), `${engine}: the tool files run each sweep exactly once (${sweeps.join(", ")})`);
    assert.equal(new Set(runs.map((r) => r.heavy)).size, 1, `${engine}: the tool files are all heavy or all not`);
  }
  // The worker-thread variant is the heavy one (skipped by default), as before the division.
  for (const map of [kill, tool]) for (const [engine, runs] of map) assert.equal(runs[0]!.heavy, String(engine === "SQLite on a worker thread"), `${engine}: heavy as before`);
});
