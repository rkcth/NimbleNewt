// Writes docs/nimblenewt/api-v1.md from the operation table (the controller's test fails if the file is out of date).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderApiDocs } from "../packages/controller/dist/api/docs.js";

const target = fileURLToPath(new URL("../docs/nimblenewt/api-v1.md", import.meta.url));
if (process.argv.includes("--write")) {
  writeFileSync(target, renderApiDocs());
  console.log(`wrote ${target}`);
} else {
  process.stdout.write(renderApiDocs());
}
