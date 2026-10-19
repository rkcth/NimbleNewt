import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const packages = fileURLToPath(new URL("../packages/", import.meta.url));
for (const entry of readdirSync(packages, { withFileTypes: true })) {
  if (entry.isDirectory()) rmSync(join(packages, entry.name, "dist"), { recursive: true, force: true });
}
