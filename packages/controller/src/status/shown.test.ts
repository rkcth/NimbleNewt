import assert from "node:assert/strict";
import { test } from "node:test";
import { quoted, shown } from "./explain.js";

// Card U09 review, round 3: record text shown unquoted (titles, names, reasons) is checked against C0 controls when it is recorded, but not against C1 controls,
// bidirectional overrides or zero-width characters; `shown` writes those as escapes so they cannot reorder a status line or reach a terminal.

test("shown: plain text is unchanged, folded and cut as before", () => {
  assert.equal(shown("Fix  the\nlogin page"), "Fix the login page");
  assert.equal(shown("a".repeat(200)), "a".repeat(200));
  assert.equal(shown("a".repeat(201)), `${"a".repeat(197)}...`);
  assert.equal(shown(`${"a".repeat(196)}\u{1F600}b`), `${"a".repeat(196)}\u{1F600}b`, "a pair fits whole");
  assert.equal(shown(`${"a".repeat(196)}\u{1F600}${"b".repeat(9)}`), `${"a".repeat(196)}...`, "a pair at the cut is left out whole, not split");
  assert.equal(shown("Grüße, 界, emoji \u{1F600}"), "Grüße, 界, emoji \u{1F600}");
  assert.equal(shown(undefined), "");
});

test("shown: controls, C1 controls, bidirectional overrides, zero-width and other format characters, and half a pair are written as escapes", () => {
  assert.equal(shown("Deploy ‮gnp.exe"), "Deploy \\u202egnp.exe");
  assert.equal(shown("a\u009b31mb"), "a\\u009b31mb", "a C1 CSI");
  assert.equal(shown("a\u001b[31mb"), "a\\u001b[31mb", "an ESC");
  assert.equal(shown("a\u007fb\u0085c"), "a\\u007fb\\u0085c");
  assert.equal(shown("zero​width⁦iso⁩"), "zero\\u200bwidth\\u2066iso\\u2069");
  assert.equal(shown("tag \u{E0041}"), "tag \\udb40\\udc41");
  assert.equal(shown("lone \ud800 half"), "lone \\ud800 half");
  const hostile = "x‮\u0085​\u001b".repeat(100);
  for (let max = 4; max <= 120; max++) {
    const s = shown(hostile, max);
    assert.ok(s.length <= max, `bound ${max}: ${s.length}`);
    assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u);
    assert.doesNotMatch(s, /\\u[0-9a-f]{0,3}\.\.\.$/, "an escape is never cut");
  }
  assert.equal(shown("​".repeat(500), 20), `${"\\u200b".repeat(2)}...`);
});

test("shown and quoted escape the same invisible characters", () => {
  for (const c of ["‮", "\u0085", "​", "⁦", "­", "﻿"]) assert.equal(`"${shown(`a${c}b`)}"`, quoted(`a${c}b`), JSON.stringify(c));
});
