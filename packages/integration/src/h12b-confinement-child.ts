import { confined, silentModel } from "./h12b-confinement-support.js";

// Fixture for h12b-confinement.test.ts: starts a confined worker with a silent model, prints where it is, and waits to be killed.
const model = await silentModel();
const c = await confined(model, undefined, false);
if ("unusable" in c) { process.stdout.write(`UNUSABLE ${c.unusable}\n`); process.exit(0); }
await c.begin();
process.stdout.write(`READY ${c.directory}\n`);
setInterval(() => undefined, 1000);
