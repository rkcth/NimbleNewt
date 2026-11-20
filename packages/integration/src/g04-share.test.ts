import assert from "node:assert/strict";
import { test } from "node:test";
import { WHOLE, partName, share } from "./g04-fixture.js";

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
