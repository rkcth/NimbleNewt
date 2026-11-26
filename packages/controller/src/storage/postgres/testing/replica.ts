import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOnce, writeOwnerRecord } from "./orphans.js";
import { embeddedPostgresBinaries, withClient } from "./server.js";

/**
 * A real PostgreSQL primary with a real streaming standby, both disposable embedded servers on loopback (card K04). The standby is a physical replica made by
 * copying the stopped primary's data folder (the embedded binaries have no `pg_basebackup`) and starting it with `standby.signal`: PostgreSQL's own streaming
 * replication, no custom protocol. Each node lives in its own `nn-test-pg-*` folder with an owner record, so a killed test run's servers are swept like any other.
 */

const PASSWORD = "nn-test-password";
const USER = "nn";
export const STANDBY_NAME = "nn_standby";
export const DATABASE = "nimblenewt_test";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
}

export interface ReplicaNode {
  readonly name: "primary" | "standby";
  readonly port: number;
  url(database?: string): string;
  isRunning(): boolean;
  /** `fast` waits for a clean shutdown; `immediate` is a crash (no checkpoint, the replication connections are cut where they are). */
  stop(mode?: "fast" | "immediate"): void;
  start(): void;
}

export interface ReplicaPair {
  readonly primary: ReplicaNode;
  readonly standby: ReplicaNode;
  /** Waits until the standby has replayed everything the primary has written (the primary's current WAL position), or throws after `timeoutMs`. */
  waitForCatchUp(timeoutMs?: number): Promise<void>;
  /** Waits until the standby's WAL receiver is streaming from the primary and the primary lists it. */
  waitForStreaming(timeoutMs?: number): Promise<void>;
  /** Sets `synchronous_standby_names` on the primary and reloads (an empty list turns synchronous replication off). */
  setSynchronous(names: readonly string[]): Promise<void>;
  /** Stops both nodes and removes their folders. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Nodes started by `pg_ctl` are daemons: nothing ties them to this process. A test that times out (node:test abandons it, so its `finally` never runs) or a process that exits early
 * would leave them running until the next run's sweep, and the sweep does not run on Windows. So every node still running when this process exits is stopped here (immediate).
 */
const running = new Set<ReplicaNode>();
let exitHook = false;
function stopAtExit(node: ReplicaNode): void {
  running.add(node);
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => { for (const n of running) { try { n.stop("immediate"); } catch { /* best effort */ } } });
}

function makeNode(name: "primary" | "standby", directory: string, port: number): ReplicaNode {
  const { exe } = embeddedPostgresBinaries();
  const data = join(directory, "data");
  const logFile = join(directory, "server.log");
  const output = join(directory, "pg_ctl.out");
  // pg_ctl's output goes to a file we open, never to pipes (on Windows the long-running server would inherit the pipe handles and the parent would wait for ever).
  const ctl = (args: string[], allowFailure = false): void => {
    const fd = openSync(output, "w");
    let run;
    try { run = spawnSync(exe("pg_ctl"), args, { stdio: ["ignore", fd, fd], timeout: 120_000 }); } finally { closeSync(fd); }
    if (!allowFailure && (run.error !== undefined || run.status !== 0)) {
      let said = ""; let tail = "";
      try { said = readFileSync(output, "utf8").trim().split(/\r?\n/).slice(-6).join(" | "); } catch { /* nothing */ }
      try { tail = readFileSync(logFile, "utf8").split(/\r?\n/).slice(-15).join("\n"); } catch { /* nothing */ }
      throw new Error(`pg_ctl ${args[0]} (${name}) failed: ${run.error?.message ?? `exit ${String(run.status)}`}: ${said}\nserver log:\n${tail}`);
    }
  };
  return {
    name, port,
    url: (database = DATABASE) => `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`,
    isRunning: () => existsSync(join(data, "postmaster.pid")) && spawnSync(exe("pg_ctl"), ["status", "-D", data], { stdio: "ignore", timeout: 30_000 }).status === 0,
    stop(mode = "fast") { ctl(["stop", "-D", data, "-m", mode, "-w", "-t", "60"], true); running.delete(this); },
    start() { stopAtExit(this); ctl(["start", "-D", data, "-w", "-t", "60", "-l", logFile]); },
  };
}

/** Starts the pair. `synchronous` makes every commit on the primary wait for the standby (`synchronous_standby_names`), as an installation that chose synchronous replication would. */
export async function startReplicaPair(options: { readonly synchronous?: boolean; readonly baseDirectory?: string } = {}): Promise<ReplicaPair> {
  const base = options.baseDirectory ?? tmpdir();
  const { exe } = embeddedPostgresBinaries();
  await sweepOnce(base);
  const folders: string[] = [];
  const nodes: ReplicaNode[] = [];
  const cleanup = async (): Promise<void> => {
    for (const node of nodes) { try { node.stop("immediate"); } catch { /* already down */ } }
    for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  };
  try {
    const primaryDir = mkdtempSync(join(base, "nn-test-pg-")); folders.push(primaryDir); writeOwnerRecord(primaryDir);
    const standbyDir = mkdtempSync(join(base, "nn-test-pg-")); folders.push(standbyDir); writeOwnerRecord(standbyDir);
    const primaryPort = await freePort();
    let standbyPort = await freePort();
    while (standbyPort === primaryPort) standbyPort = await freePort();
    const primaryData = join(primaryDir, "data");
    const standbyData = join(standbyDir, "data");
    const passwordFile = join(primaryDir, "pw.txt");
    writeFileSync(passwordFile, PASSWORD, { mode: 0o600 });
    const init = spawnSync(exe("initdb"), ["-D", primaryData, "-U", USER, `--pwfile=${passwordFile}`, "--auth=password", "--encoding=UTF8", "--locale=C", "--no-sync"], { encoding: "utf8", timeout: 120_000 });
    rmSync(passwordFile, { force: true });
    if (init.error !== undefined || init.status !== 0) throw new Error(`initdb failed: ${init.error?.message ?? String(init.status)} ${init.stderr}`);
    const common = ["listen_addresses = '127.0.0.1'", "unix_socket_directories = ''", "wal_level = replica", "max_wal_senders = 5", "hot_standby = on", "wal_keep_size = '64MB'", "log_min_messages = warning"];
    appendFileSync(join(primaryData, "postgresql.auto.conf"), `${common.join("\n")}\nport = ${primaryPort}\n`);
    const primary = makeNode("primary", primaryDir, primaryPort);
    nodes.push(primary);
    primary.start();
    await withClient(primary.url("postgres"), async (c) => { await c.query(`CREATE DATABASE "${DATABASE}"`); });
    primary.stop("fast");
    // the cold copy: the stopped primary's whole folder
    cpSync(primaryData, standbyData, { recursive: true });
    chmodSync(standbyData, 0o700); // the server refuses a data folder open to others; a copy takes the umask
    rmSync(join(standbyData, "postmaster.pid"), { force: true });
    writeFileSync(join(standbyData, "standby.signal"), "");
    const auto = join(standbyData, "postgresql.auto.conf");
    const kept = readFileSync(auto, "utf8").split(/\r?\n/).filter((line) => !/^port\s*=/.test(line)).join("\n");
    writeFileSync(auto, `${kept}\nport = ${standbyPort}\nprimary_conninfo = 'host=127.0.0.1 port=${primaryPort} user=${USER} password=${PASSWORD} application_name=${STANDBY_NAME}'\n`);
    const standby = makeNode("standby", standbyDir, standbyPort);
    nodes.push(standby);
    primary.start();
    standby.start();
    const pair: ReplicaPair = {
      primary, standby,
      waitForStreaming: async (timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          try {
            const rows = (await withClient(primary.url("postgres"), async (c) => c.query("SELECT state FROM pg_stat_replication WHERE application_name = $1", [STANDBY_NAME]))).rows;
            if (rows.some((r) => r.state === "streaming")) return;
          } catch { /* the primary may be coming up */ }
          if (Date.now() > deadline) throw new Error(`the standby did not start streaming within ${timeoutMs} ms`);
          await sleep(50);
        }
      },
      waitForCatchUp: async (timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        const target = (await withClient(primary.url("postgres"), async (c) => c.query("SELECT pg_current_wal_lsn()::text AS lsn"))).rows[0]!.lsn as string;
        for (;;) {
          try {
            const caught = (await withClient(standby.url("postgres"), async (c) => c.query("SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS ok", [target]))).rows[0]?.ok === true;
            if (caught) return;
          } catch { /* the standby may be restarting */ }
          if (Date.now() > deadline) throw new Error(`the standby did not replay to ${target} within ${timeoutMs} ms`);
          await sleep(25);
        }
      },
      setSynchronous: async (names) => {
        await withClient(primary.url("postgres"), async (c) => {
          await c.query(names.length === 0 ? "ALTER SYSTEM RESET synchronous_standby_names" : `ALTER SYSTEM SET synchronous_standby_names = '${names.length > 1 ? `FIRST 1 (${names.join(", ")})` : names[0]!}'`);
          await c.query("SELECT pg_reload_conf()");
        });
      },
      stop: cleanup,
    };
    await pair.waitForStreaming();
    if (options.synchronous === true) await pair.setSynchronous([STANDBY_NAME]);
    return pair;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
