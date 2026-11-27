import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleUserFromOutput, windowsConsoleUser } from "./windows-console.js";

// The console-user lookup redaction uses (windows-console.ts). Pure reading of the probe's output; the probe itself runs only on Windows.
test("the probe's output is an account name only when it is one plain line; anything else is no name (redaction then keeps its general rules)", async () => {
  assert.equal(consoleUserFromOutput("PC\\robert"), "PC\\robert");
  assert.equal(consoleUserFromOutput("  AzureAD\\RobertH \r\n"), "AzureAD\\RobertH");
  assert.equal(consoleUserFromOutput("robert"), "robert");
  for (const none of ["", "   ", "\r\n", "PC\\a\nPC\\b", "PC\\a\0b", "x".repeat(201)]) assert.equal(consoleUserFromOutput(none), undefined, JSON.stringify(none.slice(0, 20)));
  if (process.platform !== "win32") assert.equal(await windowsConsoleUser(), undefined);
});
