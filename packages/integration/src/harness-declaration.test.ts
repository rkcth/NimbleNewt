import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessDeclaration as ContractDeclaration, RecoveryRequirement as ContractRequirement } from "@nimblenewt/contracts";
import { HarnessCatalog, declarationProblems, durableSupport, type HarnessDeclaration, type RecoveryRequirement } from "@nimblenewt/controller";
import { PI_DECLARATION } from "@nimblenewt/pi-adapter";

// The controller does not import the contracts, so the declaration the Pi adapter ships is held to the controller's checks here, where both meet.
test("the Pi adapter's declaration is sound by the controller's checks and is what the catalog admits durable tasks on", () => {
  assert.deepEqual(declarationProblems(PI_DECLARATION), []);
  assert.equal(durableSupport(PI_DECLARATION).supported, true);
  const catalog = HarnessCatalog.of([PI_DECLARATION]);
  assert.equal(catalog.check("native-continuation", "pi"), undefined);
  assert.match(catalog.check("portable-reconstruction", "pi")!, /no portable history export/);
});

// The two copies of the structure must stay the same: each type is assignable to the other, so a field added to one and not the other fails the build.
const toController = (d: ContractDeclaration): HarnessDeclaration => d;
const toContract = (d: HarnessDeclaration): ContractDeclaration => d;
const requirementToController = (r: ContractRequirement): RecoveryRequirement => r;
const requirementToContract = (r: RecoveryRequirement): ContractRequirement => r;

test("the controller's copy of the declaration structure is the contracts' structure", () => {
  assert.deepEqual(toContract(toController(PI_DECLARATION)), PI_DECLARATION);
  assert.equal(requirementToContract(requirementToController("none")), "none");
});
