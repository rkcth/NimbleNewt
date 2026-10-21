// The fast tier of the test suite: the full build and checks, then every package's tests except the long qualification and workload
// files listed in scripts/slow-tests.json. For the edit-and-check loop; release and QA evidence come from the full `npm test`.
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["test"], { stdio: "inherit", env: { ...process.env, NIMBLENEWT_FAST: "1" }, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
