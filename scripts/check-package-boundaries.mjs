import { fileURLToPath } from "node:url";
import { checkBoundaries } from "./package-boundaries.mjs";

const errors = checkBoundaries(fileURLToPath(new URL("../packages/", import.meta.url)));
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log("package boundaries ok");
