import assert from "node:assert/strict";
import { test } from "node:test";
import { summarise } from "./coverage.mjs";

const report = [
  "# start of coverage report",
  "# file        | line % | branch % | funcs % | uncovered lines",
  "#  a          |        |          |         | ",
  "#   x.js      |  95.00 |    90.00 |  100.00 | 3",
  "#   y.js      |  40.00 |    50.00 |   25.00 | 1-9",
  "# all files   |  70.00 |    70.00 |   60.00 | ",
  "# end of coverage report",
].join("\n");

test("summarise reads the overall row and lists files under the bar", () => {
  const s = summarise(report, 80);
  assert.deepEqual(s.all, { line: 70, branch: 70, funcs: 60 });
  assert.deepEqual(s.low, [{ file: "y.js", line: 40, branch: 50, funcs: 25 }]);
  assert.equal(summarise("nothing", 80).all, undefined);
});
