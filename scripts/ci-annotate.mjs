// Emits the tail of a log file as one GitHub Actions error annotation (readable without log access).
import { readFileSync } from "node:fs";

const lines = readFileSync(process.argv[2], "utf8").split(/\r?\n/);
const tail = lines.slice(-80).join("\n");
const escaped = tail.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
console.log(`::error title=Test output (last 80 lines)::${escaped}`);
