import assert from "node:assert/strict";
import { test } from "node:test";
import { declarationProblems, durableSupport, recoveryGap, type HarnessDeclaration } from "./declarations.js";

const reconstructing: HarnessDeclaration = { harness: "fake-rebuilder", nativeContinuation: false, portableReconstruction: true, checkpointExport: true, abort: "request" };
const nothing: HarnessDeclaration = { harness: "fake-nothing", nativeContinuation: false, portableReconstruction: false, checkpointExport: false, abort: "none" };
const native: HarnessDeclaration = { harness: "fake-native", nativeContinuation: true, portableReconstruction: false, checkpointExport: false, abort: "conversation" };

test("sound declarations pass the shared check, whatever they declare", () => {
  for (const d of [reconstructing, nothing, native]) assert.deepEqual(declarationProblems(d), [], d.harness);
});

test("a declaration that contradicts itself or is malformed is reported", () => {
  assert.match(declarationProblems({ ...reconstructing, checkpointExport: false }).join(), /needs checkpoint export/);
  assert.match(declarationProblems({ ...native, harness: "Bad Name" }).join(), /harness name/);
  assert.match(declarationProblems({ ...native, abort: "everything" as never }).join(), /abort/);
  assert.match(declarationProblems({ ...native, nativeContinuation: "yes" as never }).join(), /nativeContinuation/);
});

test("a harness that can neither continue nor rebuild is unsupported for durable tasks, and says why", () => {
  assert.equal(durableSupport(native).supported, true);
  assert.equal(durableSupport(reconstructing).supported, true);
  const none = durableSupport(nothing);
  assert.equal(none.supported, false);
  assert.match(none.reason!, /unsupported for durable tasks/);
});

test("a requirement is met only by a harness that has the capability, with a reason when not", () => {
  assert.equal(recoveryGap("none", nothing), undefined, "work that may be lost needs nothing");
  assert.equal(recoveryGap("native-continuation", native), undefined);
  assert.match(recoveryGap("native-continuation", reconstructing)!, /cannot continue a conversation from its own storage/);
  assert.equal(recoveryGap("portable-reconstruction", reconstructing), undefined);
  assert.match(recoveryGap("portable-reconstruction", native)!, /no portable history export/);
  assert.match(recoveryGap("native-continuation", nothing)!, /unsupported for durable tasks/);
});
