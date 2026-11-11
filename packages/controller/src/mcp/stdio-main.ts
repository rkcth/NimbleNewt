import { redactText } from "../security/redact.js";
import { runStdioBridge } from "./stdio-bridge.js";

// The program a local MCP client starts for stdio (card T05b): `node dist/mcp/stdio-main.js [door-url]`, with the controller's door address in NIMBLENEWT_MCP_URL (or the first argument) and the
// credential in NIMBLENEWT_TOKEN. Standard output carries protocol messages only.
const url = process.env["NIMBLENEWT_MCP_URL"] ?? process.argv[2];
const token = process.env["NIMBLENEWT_TOKEN"];
// Taken out of the environment at once, so nothing started from here and no crash report carries it.
delete process.env["NIMBLENEWT_TOKEN"];
try {
  await runStdioBridge({ url: url ?? "", token: token ?? "", input: process.stdin, output: process.stdout, error: process.stderr });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? redactText(error.message) : "the bridge stopped"}\n`);
  process.exitCode = 2;
}
