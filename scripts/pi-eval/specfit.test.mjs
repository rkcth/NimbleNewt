// Tests for the spec-fit check: what an acceptance test's assertions demand, and which of it the agent could not know.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDemands, extractDemands, specFit, tokenize } from "./lib/specfit.mjs";

const SRC = `import assert from "node:assert/strict";
import { test } from "node:test";
import { LANDING_MEANS, describe as describeOp, type Row } from "./commands.js";
import { helper } from "../testing/helper.js";
const owner = "Ship it\\u2028now";
const ratio = total / 2 / count;
test("a landing is explained", () => {
  const r: Row = describeOp({ op: "integration.set", landing: "main-automatic" });
  assert.match(r.line, /main by itself/, "the line says what happens: a message, not a demand");
  assert.equal(r.status, "proposed");
  assert.deepEqual(r.fields, { project: "proj-a", gate: [\`tests on \${owner}\`] });
  assert.ok(r.preview.some((l: string) => l.includes("Ship it now")), \`a template message \${r.line}\`);
  assert.throws(() => describeOp(null as never), /needs an operation/);
});
`;

test("the tokenizer tells a regex from a division, reads template parts and decodes escapes", () => {
  const toks = tokenize('const a = b / c / d; const r = /x\\/y[/]z/gi; const t = `p${q + `in${r}`}s`; const s = "a\\u0041\\n";');
  assert.deepEqual(toks.filter((t) => t.t === "re").map((t) => t.v), ["/x\\/y[/]z/gi"]);
  const tpl = toks.find((t) => t.t === "tpl");
  assert.deepEqual(tpl.parts, ["p", "s"]);
  assert.equal(toks.find((t) => t.t === "str").v, "aA\n");
});

test("demands are read from inside assertions only, without their messages; imports of relative modules are demands", () => {
  const { items, fixtureText } = extractDemands("x.test.ts", SRC);
  const keys = items.map((i) => i.key);
  for (const k of ["{LANDING_MEANS}", "{describe}", "{Row}", "{helper}", "/main by itself/", '"proposed"', ".status", ".fields", ".project", ".gate", '"proj-a"', '"tests on "', '"Ship it now"', "/needs an operation/", ".line", ".preview"]) assert.ok(keys.includes(k), `${k} in ${keys.join(" ")}`);
  for (const k of ['"the line says what happens: a message, not a demand"', '"a template message "', '"a landing is explained"', '"main-automatic"', '"integration.set"']) assert.ok(!keys.includes(k), `${k} is not a demand`);
  assert.ok(!keys.some((k) => k.includes("node:")), "a package import is not the agent's to provide");
  assert.ok(fixtureText.includes("Ship it\u2028now"), "fixtures are known as the text the test feeds in");
  assert.match(fixtureText, /integration\.set/);
});

test("a demand is known when the prompt, the base source or the test's own fixtures show it; regexes are matched, not compared", () => {
  const demands = [
    { kind: "string", value: "proposed", key: '"proposed"' },
    { kind: "regex", value: "/main by itself/", key: "/main by itself/" },
    { kind: "regex", value: "/no human step/i", key: "/no human step/i" },
    { kind: "property", value: "landingMeans", key: ".landingMeans" },
    { kind: "import", value: "LANDING_MEANS", key: "{LANDING_MEANS}" },
    { kind: "string", value: "Ship it now", key: '"Ship it now"' },
    { kind: "string", value: "ok", key: '"ok"' },
  ];
  const flagged = checkDemands(demands, { prompt: "Export LANDING_MEANS. The sentence says main by itself and No Human Step.", corpus: "status: 'proposed'", fixtures: "", allow: {} });
  assert.deepEqual(flagged.map((f) => f.key), [".landingMeans", '"Ship it now"']);
  assert.deepEqual(checkDemands(demands, { prompt: "", corpus: "", fixtures: "x.landingMeans; Ship it now LANDING_MEANS main by itself no human step proposed" }), []);
});

test("spec fit passes only when every flagged item has a reason; unused allowlist entries are reported as stale", () => {
  const files = [{ name: "x.test.ts", text: SRC }];
  const prompt = "CONTRACT: LANDING_MEANS, describe, Row; result fields line, status (proposed), fields, preview; main by itself; tests on.";
  const corpus = "project gate helper some includes throws needs an operation proj-a";
  const bad = specFit({ files, prompt, corpus });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unjustified.map((u) => u.key), ['"Ship it now"']);
  const good = specFit({ files, prompt, corpus, allow: { '"Ship it now"': "the fixture name with its line separator shown as a space, as the CONTRACT says", "/gone/": "old" } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.stale, ["/gone/"]);
  assert.equal(specFit({ files, prompt, corpus, allow: { '"Ship it now"': " " } }).ok, false, "an empty reason is no reason");
});
