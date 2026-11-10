import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { TRANSFER_STATE_FOLDER, directorySecrets, formatErrors, loadConfig, resolveSecrets, transferOptionsFromConfig } from "@nimblenewt/config";
import { requestId } from "@nimblenewt/contracts";
import { ScriptedInterpreter, SqliteStorage, readAuthority, startController, type EnvironmentFacts, type FilesystemDetector } from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";
import { PiAdapter, missingCheckpoints } from "@nimblenewt/pi-adapter";

// Card F04l: a start from a configuration FILE, done the way a host does it (load the file, resolve its secrets from the secret store, give the controller the
// storage and the transfer options the configuration names, and the Pi adapter's checkpoint answer), moves the controller database from chat. The host below is
// test glue only; the launcher that does this for an installation is card U14.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const at = "2026-10-31T10:00:00.000Z";

let pgServer: Promise<harness.TestServer> | undefined;
const pg = (): Promise<harness.TestServer> => (pgServer ??= harness.startTestServer());
after(async () => { if (pgServer !== undefined) await (await pgServer).stop(); });

/** A private configuration with no model provider that needs a key, so the only secret it names is what a test adds. */
function configDocument(dataDir: string, storage: unknown, targets: unknown[]): unknown {
  return {
    configVersion: 1, profile: "private",
    installation: { name: "f04l-test", dataDir, workspaces: {} },
    controller: { storage, databaseTransfer: { targets } },
    execution: { isolation: "strong" },
    models: { providers: { local: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:9/v1", enabled: true, paid: false, models: ["m"] } }, difficulty: { simple: ["local/m"] } },
    api: { remoteExposure: false },
    approvals: { preset: "strict", grants: [] },
  };
}

interface Host { readonly printed: string[]; readonly say: Record<string, unknown[]> }

/** What a host does with a configuration file: everything the controller is given about storage and transfers comes from the file and the secret store. */
async function startFromConfiguration(file: string, secretsDir: string, adapter: PiAdapter, host: Host) {
  const loaded = loadConfig(readFileSync(file, "utf8"));
  if (!loaded.ok) throw new Error(formatErrors(loaded.errors));
  const config = loaded.config;
  const resolver = directorySecrets(secretsDir);
  const resolved = await resolveSecrets(config, resolver);
  if (!resolved.ok) throw new Error(`missing secrets: ${resolved.missing.map((m) => `${m.name} (${m.usedBy})`).join(", ")}`);
  const s = config.controller.storage;
  const storage = s.kind === "sqlite" ? { kind: "sqlite", path: s.path } : { kind: "postgres", url: resolved.secrets.get(s.url.secret)!.reveal(), maxConnections: s.maxConnections, ...(s.schema === undefined ? {} : { schema: s.schema }) };
  return startController({ storage, argv: [], env: {}, print: (line: string) => { host.printed.push(line); }, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: { schedule: () => () => undefined }, tickMs: 3_600_000 },
    chat: { interpreter: new ScriptedInterpreter((input) => host.say[input.text] ?? []) },
    transfer: { targets: [], ...transferOptionsFromConfig(config, resolver), references: { checkpoints: (points: readonly { id: string; attemptId: string; checkpoint: string }[]) => missingCheckpoints(adapter, points) } } } as never);
}

async function piAdapter() {
  const models = createModels();
  const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("answer one")]);
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models, model: { provider: "offline", modelId: "scripted" } });
  const conversation = adapter.root();
  await (await conversation.submit({ kind: "input", requestId: requestId("t1"), content: "first request" })).result();
  const real = await conversation.checkpoint();
  return { adapter, stored: { conversationId: real.conversationId, at: real.at, digest: real.digest, runtime: real.runtime, format: real.format } };
}

async function seedRecoveryPoint(dbPath: string, checkpoint: unknown): Promise<void> {
  const s = await SqliteStorage.open({ path: dbPath });
  const { epoch } = await s.acquireEpoch({ holder: "seed", at });
  await s.applyOperation({ operationId: "seed-1", epoch, actor: "owner:rob", correlationId: "c-seed", at, audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], changes: [
    { type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }, { type: "create", ref: { kind: "attempt", id: "att-1" }, body: { taskId: "task-a" } },
    { type: "create", ref: { kind: "artifact", id: "art-aaaaaaaaaaaaaaaaaaaa" }, body: { entries: [{ digest: "sha256:" + "d".repeat(64) }] } },
    { type: "create", ref: { kind: "recovery-point", id: "rp-1" }, body: { attemptId: "att-1", taskId: "task-a", artifactId: "art-aaaaaaaaaaaaaaaaaaaa", checkpoint } },
  ] } as never);
  await s.close();
}

/** Every file's text in a folder and its subfolders (the transfer state folder holds the journal, the authority file and a lock). */
const filesUnder = (dir: string): string => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : readFileSync(join(dir, e.name), "utf8"))).join("\n") : "");

test("a start from a configuration file moves the controller database from chat to a PostgreSQL destination the file names by secret; the room is read from the server; the address appears in no chat answer, print line, journal or authority file; the file then points at the moved database and it starts (card F04l)", async () => {
  const server = await pg();
  const url = server.url();
  const password = decodeURIComponent(new URL(url).password);
  const schema = `cf_${process.pid}_${Math.random().toString(36).slice(2, 7)}`, small = `${schema}_s`;
  const d = mkdtempSync(join(tmpdir(), "nn-f04l-cfg-"));
  const dataDir = join(d, "data"), secretsDir = join(d, "secrets"), file = join(d, "nimblenewt.json");
  mkdirSync(dataDir); mkdirSync(secretsDir);
  writeFileSync(join(secretsDir, "transfer.pg-url"), `${url}\n`);
  const sizeNow = async (): Promise<number> => harness.withClient(url, async (client) => Number((await client.query("SELECT pg_database_size(current_database())::text AS n")).rows[0].n));
  const base = await sizeNow();
  const targets = [
    { name: "big-pg", kind: "postgres", url: { secret: "transfer.pg-url" }, schema, maxBytes: 900_000_000 },
    // A cap just over what the server already holds: only a room that subtracts the server's own figure is too small for the copy.
    { name: "small-pg", kind: "postgres", url: { secret: "transfer.pg-url" }, schema: small, maxBytes: base + 2_000 },
  ];
  writeFileSync(file, JSON.stringify(configDocument(dataDir, { kind: "sqlite", path: join(dataDir, "controller.sqlite") }, targets), null, 2));
  assert.ok(!readFileSync(file, "utf8").includes(url), "the configuration file holds only the secret's name");
  const { adapter } = await piAdapter();
  const host: Host = { printed: [], say: {} };
  let seen = "";
  try {
    let c = await startFromConfiguration(file, secretsDir, adapter, host);
    let token = "";
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      token = boot.token;
      await c.api.handle(token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Garden" } } as never);
      // Too little room: the cap less what the server reports is below what the copy needs, so the move is refused and says the room.
      const tooSmall = "move the controller database over to small-pg please";
      host.say[tooSmall] = [{ kind: "command", op: "database.transfer.apply", args: { target: "small-pg" }, evidence: tooSmall, basis: "owner" }];
      const refused = (await c.chat!.submit(token, { messageId: "m0", text: tooSmall })).outcomes;
      assert.equal(refused[0]!.status, "refused", JSON.stringify(refused));
      assert.match(JSON.stringify(refused), /not enough room at the destination: about \d+ bytes are needed .* and \d+ are free/);
      seen += JSON.stringify(refused);
      // Enough room: the proposal shows the server-read room, the owner confirms, the database moves.
      const text = "I'd like the controller's data on big-pg from now on";
      host.say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "big-pg" }, evidence: text, basis: "owner" }];
      const shown = (await c.chat!.submit(token, { messageId: "m1", text })).outcomes;
      assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
      const room = /room: about (\d+) bytes needed, (\d+) free at the destination/.exec(JSON.stringify(shown));
      assert.ok(room !== null, JSON.stringify(shown));
      const sizeAfter = await sizeNow();
      assert.ok(Math.abs(Number(room[2]) - (900_000_000 - sizeAfter)) <= 1_048_576 && Number(room[2]) < 900_000_000, `free ${room[2]} against the server's ${sizeAfter}`);
      seen += JSON.stringify(shown);
      const done = await c.chat!.applyProposal(token, { commandId: "ap-1", proposalId: (shown[0] as { proposalId: string }).proposalId });
      assert.equal(done.applied, true, JSON.stringify(done));
      seen += JSON.stringify(done);
    } finally { await c.close().catch(() => undefined); }
    const stateDir = join(dataDir, TRANSFER_STATE_FOLDER);
    assert.equal((await readAuthority(stateDir))?.active.name, "big-pg", "the journal and authority file are in the folder the configuration gives");
    // The same file, unchanged, now names a database that was moved away from: the start is refused and says where to point it.
    const stale = await startFromConfiguration(file, secretsDir, adapter, host).then(async (x) => { await x.close(); return undefined; }, (e: Error) => e.message);
    assert.match(stale ?? "", /moved to big-pg .* Point controller\.storage at big-pg/);
    seen += stale;
    for (const [where, text] of [["chat", seen], ["print", host.printed.join("\n")], ["state files", filesUnder(stateDir)]] as const) {
      for (const leak of [...(password === "" ? [] : [password]), url, "postgres://", "postgresql://"]) assert.ok(!text.includes(leak), `${where} holds part of the address (${leak === password ? "the password" : leak.slice(0, 11)})`);
    }
    // The owner points the file at the moved database (address still a secret reference, with the destination's schema) and gives a way back to a file.
    writeFileSync(file, JSON.stringify(configDocument(dataDir, { kind: "postgres", url: { secret: "transfer.pg-url" }, maxConnections: 4, schema }, [{ name: "back-file", kind: "sqlite", path: join(dataDir, "back.sqlite") }]), null, 2));
    c = await startFromConfiguration(file, secretsDir, adapter, host);
    try {
      assert.ok(JSON.stringify(await c.api.handle(token, { v: 1, op: "project.list", args: {} } as never)).includes("Garden"), "the data moved");
      assert.match(JSON.stringify(await c.api.handle(token, { v: 1, op: "database.transfer.status", args: {} } as never)), /"name":"back-file","kind":"sqlite","direction":"postgres to sqlite"/);
    } finally { await c.close().catch(() => undefined); }
  } finally {
    await adapter.close();
    await harness.withClient(url, async (client) => { for (const s of [schema, small]) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); }).catch(() => undefined);
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a start from a configuration file refuses a move when a recovery point's conversation checkpoint does not hold in the Pi store, and moves once it does (card F04l)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-f04l-cfk-"));
  const dataDir = join(d, "data"), file = join(d, "nimblenewt.json");
  mkdirSync(dataDir);
  const dbPath = join(dataDir, "controller.sqlite");
  writeFileSync(file, JSON.stringify(configDocument(dataDir, { kind: "sqlite", path: dbPath }, [{ name: "moved", kind: "sqlite", path: join(dataDir, "moved.sqlite") }]), null, 2));
  const { adapter, stored } = await piAdapter();
  const host: Host = { printed: [], say: {} };
  const ask = async (messageId: string) => {
    const c = await startFromConfiguration(file, join(d, "no-secrets"), adapter, host);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" }).catch(() => undefined);
      assert.ok(boot !== undefined, "owner exists");
      const text = "could you put the database on moved";
      host.say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "moved" }, evidence: text, basis: "owner" }];
      return (await c.chat!.submit(boot.token, { messageId, text })).outcomes[0] as { status: string };
    } finally { await c.close().catch(() => undefined); }
  };
  try {
    await seedRecoveryPoint(dbPath, { ...stored, digest: `v1:sha256:${"2".repeat(64)}` });
    const refused = await ask("m1");
    assert.equal(refused.status, "refused", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /checkpoint of recovery point rp-1 is not in the conversation store, or does not match it/);
    assert.equal(await readAuthority(join(dataDir, TRANSFER_STATE_FOLDER)), undefined, "nothing was moved");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    await seedRecoveryPoint(dbPath, stored);
    assert.equal((await ask("m2")).status, "proposed");
  } finally { await adapter.close(); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
