// Command-line entry: `node packages/controller/dist/backup/cli-main.js <list|verify|restore> …` (card K01f). The logic is in `cli.ts`.
import { runBackupCli } from "./cli.js";

process.exitCode = await runBackupCli(process.argv.slice(2), (line) => { console.log(line); });
