#!/usr/bin/env node
// The NimbleNewt launcher (card U14). On a clean machine:
//   node scripts/nimblenewt.mjs init --model-endpoint http://127.0.0.1:8000/v1 --model my-model --backup-endpoint https://example.org/v1 --backup-model free-model
//   node scripts/nimblenewt.mjs start
// `init` writes a configuration file (no secret in it); `start` loads it, starts the controller, makes the owner the first time (the owner's credential goes into the operating
// system's secret store, never into a file you have to guard) and opens the chat in the terminal. `secret set NAME` reads a key from the terminal or standard input into the secret store.
// Everything else is done by talking to the chat in your own words. Needs `npx tsc --build` first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { environmentsRequested, localHostBuilder } from "./local-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (pkg) => import(pathToFileURL(join(root, "packages", pkg, "dist", "index.js")).href);

const HELP = `NimbleNewt launcher

  init    [--data DIR] [--model-endpoint URL --model NAME [--model-key-secret NAME] [--model-paid]]
          [--backup-endpoint URL --backup-model NAME [--backup-key-secret NAME] [--backup-paid]] [--postgres-secret NAME]
          Writes DIR/nimblenewt.config.json (default DIR: ~/.nimblenewt, or NIMBLENEWT_DATA). Keeps nothing secret in it.
  start   [--data DIR | --config FILE] [--serve] [--allow-unsupported-environment] [--local-host-environments]
          --local-host-environments (or NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS=1; off by default) lets the worker host on this computer install approved package changes into agents' environments.
          Starts the controller, makes you the owner the first time and opens the chat. Without a configuration file it writes a starter one.
  status  [--data DIR | --config FILE]   Starts, prints what is set up and what is missing, and stops.
  secret set NAME [--data DIR]           Puts a secret (a model key, a database address) into the secret store. The value is read from the terminal without echo, or from standard input.
`;

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const eq = k.indexOf("=");
      if (eq >= 0) out.flags[k.slice(0, eq)] = k.slice(eq + 1);
      else if (["serve", "model-paid", "backup-paid", "allow-unsupported-environment", "local-host-environments", "help"].includes(k)) out.flags[k] = true;
      else { out.flags[k] = argv[i + 1]; i++; }
    } else out._.push(a);
  }
  return out;
}

const dataDirOf = (flags, env) => resolve(flags.data ?? env.NIMBLENEWT_DATA ?? join(homedir(), ".nimblenewt"));
const configPathOf = (flags, env) => (flags.config === undefined ? join(dataDirOf(flags, env), "nimblenewt.config.json") : resolve(flags.config));

/** The starter configuration: SQLite in the data directory, strong isolation, strict approvals, remote exposure off, the providers given (none otherwise). */
/** A model server's address as the configuration may hold it: no user name, password, query or fragment, where a key would be written into the file in the clear. The value is never echoed. */
function plainAddress(url, flag) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`--${flag} must be an address such as http://127.0.0.1:8000/v1`); }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || /[?#@]/.test(url)) throw new Error(`--${flag} must be a plain http:// or https:// address with no user name, password, query or fragment: a key there would be written into the configuration file. Name the key's secret instead (--model-key-secret NAME or --backup-key-secret NAME) and put the key in with: secret set NAME`);
  return url;
}

export function starterConfig(dataDir, flags) {
  const providers = {};
  const add = (name, endpoint, model, keySecret, paid) => {
    plainAddress(endpoint, name === "primary" ? "model-endpoint" : "backup-endpoint");
    providers[name] = { adapter: "openai-compatible", endpoint, ...(keySecret === undefined ? {} : { credential: { secret: keySecret } }), enabled: true, paid, models: [model] };
  };
  if (flags["model-endpoint"] !== undefined) {
    if (flags.model === undefined) throw new Error("--model-endpoint needs --model (the model's name on that server)");
    add("primary", flags["model-endpoint"], flags.model, flags["model-key-secret"], flags["model-paid"] === true);
  }
  if (flags["backup-endpoint"] !== undefined) {
    if (flags["backup-model"] === undefined) throw new Error("--backup-endpoint needs --backup-model");
    add("backup", flags["backup-endpoint"], flags["backup-model"], flags["backup-key-secret"], flags["backup-paid"] === true);
  }
  return {
    configVersion: 1, profile: "private",
    installation: { name: "my-newt", dataDir, workspaces: {} },
    controller: { storage: flags["postgres-secret"] === undefined ? { kind: "sqlite", path: join(dataDir, "controller.sqlite") } : { kind: "postgres", url: { secret: flags["postgres-secret"] }, maxConnections: 10 } },
    limits: { productiveAttempts: 4, perHost: 2, inquirySlots: 2 },
    execution: { isolation: "strong" },
    models: { providers, difficulty: {} },
    api: { remoteExposure: false },
    approvals: { preset: "strict", grants: [] },
  };
}

async function readConfig(file) {
  const { loadConfig, formatErrors } = await load("config");
  const loaded = loadConfig(readFileSync(file, "utf8"));
  if (!loaded.ok) throw new Error(`the configuration ${file} is not valid:\n${formatErrors(loaded.errors)}`);
  return loaded.config;
}

async function secretStoreFor(config) {
  const { chooseSecretStore } = await load("config");
  const { store, reason } = await chooseSecretStore({ dataDir: config.installation.dataDir });
  return { store, reason };
}

/** Reads one line from the terminal without echoing it, or all of standard input when it is not a terminal. */
async function readSecretValue(io) {
  if (!io.stdin.isTTY) { let t = ""; for await (const c of io.stdin) t += c; return t.replace(/\r?\n$/, ""); }
  io.stdout.write("Value (typing is hidden): ");
  return new Promise((done) => {
    let value = "";
    io.stdin.setRawMode(true); io.stdin.resume(); io.stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") { io.stdin.setRawMode(false); io.stdin.pause(); io.stdin.off("data", onData); io.stdout.write("\n"); return done(value); }
        if (c === "\u0003") { io.stdin.setRawMode(false); process.exit(130); }
        if (c === "\u007f") value = value.slice(0, -1); else value += c;
      }
    };
    io.stdin.on("data", onData);
  });
}

export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  const args = parseArgs(argv);
  const [cmd, sub] = args._;
  const out = (t) => io.stdout.write(t.endsWith("\n") ? t : `${t}\n`);
  if (cmd === undefined || args.flags.help === true || cmd === "help") { out(HELP); return cmd === undefined ? 1 : 0; }
  const dataDir = dataDirOf(args.flags, io.env);

  if (cmd === "init") {
    const file = configPathOf(args.flags, io.env);
    if (existsSync(file)) { out(`${file} already exists and was left as it is. Edit it, or remove it to start over.`); return 1; }
    const config = starterConfig(dataDir, args.flags);
    const { loadConfig, formatErrors } = await load("config");
    const checked = loadConfig(config);
    if (!checked.ok) throw new Error(`the starter configuration is not valid:\n${formatErrors(checked.errors)}`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    out(`Wrote ${file}. It holds no secret.`);
    for (const [name, p] of Object.entries(config.models.providers)) if (p.credential !== undefined) out(`Provider ${name} needs its key in the secret store: node scripts/nimblenewt.mjs secret set ${p.credential.secret}`);
    if (config.controller.storage.kind === "postgres") out(`The database address goes in the secret store: node scripts/nimblenewt.mjs secret set ${config.controller.storage.url.secret}`);
    out("Next: node scripts/nimblenewt.mjs start");
    return 0;
  }

  if (cmd === "secret") {
    if (sub !== "set" || args._[2] === undefined) { out("usage: secret set NAME"); return 1; }
    const file = configPathOf(args.flags, io.env);
    const config = existsSync(file) ? await readConfig(file) : { installation: { dataDir } };
    const { store, reason } = await secretStoreFor(config);
    const value = await readSecretValue(io);
    if (value === "") { out("No value was given; nothing was stored."); return 1; }
    await store.set(args._[2], value);
    out(`Stored "${args._[2]}" in the secret store (${reason}).`);
    return 0;
  }

  if (cmd === "start" || cmd === "status") {
    const file = configPathOf(args.flags, io.env);
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify(starterConfig(dataDir, {}), null, 2)}\n`, { flag: "wx", mode: 0o600 });
      out(`No configuration was found, so a starter one was written to ${file}. It holds no secret and no model provider yet.`);
    }
    const config = await readConfig(file);
    const { store, reason } = await secretStoreFor(config);
    const { launch, runTerminalChat, setupGreeting } = await load("controller");
    const passthrough = [...(args.flags["allow-unsupported-environment"] === true ? ["--allow-unsupported-environment"] : [])];
    const launched = await launch({ config, secrets: store, argv: passthrough, env: io.env, print: (l) => io.stderr.write(`${l}\n`), localHost: localHostBuilder({ root, load, environments: environmentsRequested(args.flags["local-host-environments"], io.env.NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS) }), ...(args.flags.serve === true ? { serve: {} } : {}) });
    try {
      out(`Secrets are kept in: ${reason}.`);
      for (const n of launched.notes) out(n);
      out(await setupGreeting(launched.controller, launched.ownerToken));
      if (cmd === "status") return 0;
      if (launched.controller.conversationUrl !== undefined) out(`The conversation listener is at ${launched.controller.conversationUrl} (this computer only).`);
      const rl = createInterface({ input: io.stdin, output: io.stdout, prompt: "you> " });
      rl.prompt();
      const lines = (async function* () { for await (const l of rl) { yield l; rl.prompt(); } })();
      return await runTerminalChat({ controller: launched.controller, ownerToken: launched.ownerToken, input: lines, write: (t) => io.stdout.write(t) });
    } finally { await launched.close(); }
  }

  out(HELP);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { if (error?.name !== "UnsupportedEnvironmentError") process.stderr.write(`${String(error?.message ?? error)}\n`); process.exitCode = 1; });
}
