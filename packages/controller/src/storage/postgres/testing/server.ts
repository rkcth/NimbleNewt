import { spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { sweepOnce, writeOwnerRecord } from "./orphans.js";

/** A PostgreSQL server for tests. Either one the caller supplies, or a real one started from the `embedded-postgres` binaries. */
/**
 * Deletes a test server's folder. On Windows the folder can stay locked for a while after the server stops (the server's last handles, the
 * antivirus scanner, the indexer): that is retried for about ten seconds, and if it still cannot be removed it is reported and left for the
 * operating system's temp cleanup. A leftover temp folder is not a test failure (an owner's Windows run failed a whole test file on `EBUSY: rmdir`).
 */
function removeTree(directory: string): void {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only a lock is tolerated, and only if the server is really gone (a running server keeps its pid file); anything else is a real failure.
    const serverStillThere = existsSync(join(directory, "data", "postmaster.pid"));
    if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || serverStillThere) throw error;
    console.warn(`# could not remove the temporary test server folder ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface TestServer {
  readonly kind: "embedded" | "external";
  /** A connection string for the named database on this server. */
  url(database?: string): string;
  /** The server's version string, for reports. */
  version(): Promise<string>;
  stop(): Promise<void>;
  /** Embedded servers only: stop the server with an immediate shutdown (no clean checkpoint, like a crash), then start it again on the same data and port. */
  crashAndRestart?(): Promise<void>;
  /** Embedded servers started by the library only: kill the server outright (SIGKILL), as an outside cause would; `stop()` must still return. For the harness's own tests. */
  kill?(): void;
}

const PASSWORD = "nn-test-password";
const USER = "nn";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The repository installs with lifecycle scripts disabled, so the embedded binaries' own postinstall step (which recreates the
 * shared-library symlinks that npm cannot store) never runs. This does the same thing: it reads the package's list of symlinks
 * and creates the missing ones. Nothing outside the package directory is touched; on Windows the list is empty.
 */
function binariesDir(embeddedDir: string): string {
  const platform = ({ linux: "linux", darwin: "darwin", win32: "windows" } as Record<string, string>)[process.platform];
  if (platform === undefined) throw new Error(`no embedded PostgreSQL binaries exist for ${process.platform}`);
  return join(dirname(embeddedDir), "@embedded-postgres", `${platform}-${process.arch}`);
}

function hydrateSymlinks(embeddedDir: string): void {
  const packageDir = binariesDir(embeddedDir);
  const list = join(packageDir, "native", "pg-symlinks.json");
  if (!existsSync(list)) return;
  const root = resolve(packageDir) + sep;
  for (const { source, target } of JSON.parse(readFileSync(list, "utf8")) as { source: string; target: string }[]) {
    const link = resolve(packageDir, target);
    // The list comes from a package we do not control: never create or follow anything outside the package directory.
    if (!link.startsWith(root) || isAbsolute(source) || isAbsolute(target) || basename(source) !== source.split(/[\\/]/).pop()) continue;
    if (!existsSync(link)) {
      try { symlinkSync(basename(source), link); } catch { /* another process created it first */ }
    }
  }
}

const hex = (code: number): string => `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

/** Describes a process exit as decimal and 32-bit hex: on Windows a process that dies at once usually exits with an NTSTATUS code (0xC0000135 = a DLL was not found). */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return `exit code ${code === null ? "none" : `${code} (${hex(code)})`}, signal ${signal ?? "none"}`;
}

/**
 * The library does not say why a server that exits at once exited, and assigns its child process some moments after start()
 * begins. Look for the handle every millisecond for a while, report an exit that has already happened, and listen for the rest.
 */
function watchProcess(getProcess: () => ChildProcess | undefined, note: (line: string) => void): void {
  let tries = 0;
  const timer = setInterval(() => {
    const proc = getProcess();
    if (proc === undefined) { if (++tries > 400) { clearInterval(timer); note("no postgres process handle appeared within 400 ms of start()"); } return; }
    clearInterval(timer);
    note(`postgres process started, pid ${proc.pid ?? "none"}`);
    if (proc.exitCode !== null || proc.signalCode !== null) note(`postgres process had already ended: ${describeExit(proc.exitCode, proc.signalCode)}`);
    proc.on("exit", (code, signal) => note(`postgres process exited: ${describeExit(code, signal)}`));
    proc.on("close", (code, signal) => note(`postgres process stdio closed: ${describeExit(code, signal)}`));
    proc.on("error", (error) => note(`postgres process error: ${error.message}`));
  }, 1);
  timer.unref();
}

/** Facts gathered only when the server fails to start, to tell a missing library from a bad environment from a bad data directory. */
function diagnoseStartFailure(embeddedPackageDir: string, dataDirectory: string, port: number): string[] {
  const lines: string[] = [];
  const binDir = join(binariesDir(embeddedPackageDir), "native", "bin");
  const executable = join(binDir, process.platform === "win32" ? "postgres.exe" : "postgres");
  const run = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 20_000 });
  lines.push(`diagnosis: postgres --version -> ${run.error !== undefined ? `spawn error ${run.error.message}` : `${describeExit(run.status, run.signal)}; stdout ${JSON.stringify(run.stdout?.trim() ?? "")}; stderr ${JSON.stringify(run.stderr?.trim() ?? "")}`}`);
  try { lines.push(`diagnosis: bin directory ${binDir}: ${readdirSync(binDir).join(", ")}`); } catch (error) { lines.push(`diagnosis: cannot list ${binDir}: ${error instanceof Error ? error.message : String(error)}`); }
  const path = process.env.PATH ?? process.env.Path ?? "";
  lines.push(`diagnosis: cwd ${process.cwd()}; PATH length ${path.length}; PATH contains the bin directory: ${path.toLowerCase().includes(binDir.toLowerCase())}; port ${port}; node ${process.version}`);
  try { lines.push(`diagnosis: data directory ${dataDirectory}: ${readdirSync(dataDirectory).slice(0, 40).join(", ")}`); } catch (error) { lines.push(`diagnosis: cannot list data directory: ${error instanceof Error ? error.message : String(error)}`); }
  for (const file of ["postmaster.pid", "postmaster.opts"]) {
    try { lines.push(`diagnosis: ${file}: ${JSON.stringify(readFileSync(join(dataDirectory, file), "utf8").slice(0, 300))}`); } catch { /* not there */ }
  }
  return lines;
}

/** Starts a real PostgreSQL server on a free loopback port in a temporary directory. `flags` are extra `postgres` options. */
export async function startEmbeddedServer(flags: readonly string[] = [], baseDirectory: string = tmpdir(), testing: { readonly firstPort?: number } = {}): Promise<TestServer> {
  // NIMBLENEWT_TEST_POSTGRES_DIR names a directory with its own node_modules holding a different `embedded-postgres` (another PostgreSQL
  // major version); scripts/postgres-versions.mjs sets it for the version verification (card F04g). Unset, the repository's own is used.
  const alternate = process.env["NIMBLENEWT_TEST_POSTGRES_DIR"];
  const require = createRequire(alternate === undefined || alternate === "" ? import.meta.url : join(resolve(alternate), "package.json"));
  const entry = require.resolve("embedded-postgres");
  const embeddedDir = dirname(entry);
  hydrateSymlinks(join(embeddedDir, ".."));
  type Embedded = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(name: string): Promise<void> };
  const { default: EmbeddedPostgres } = (await import(pathToFileURL(entry).href)) as { default: new (options: Record<string, unknown>) => Embedded };
  // Servers and folders left by test processes that were killed (their recorded owner is gone) are stopped and removed first; then this
  // server's folder records its own owner, so a later start can tell when it was left behind the same way (follow-up of card 19).
  await sweepOnce(baseDirectory);
  const directory = mkdtempSync(join(baseDirectory, "nn-test-pg-"));
  try { writeOwnerRecord(directory); } catch (error) { removeTree(directory); throw error; }
  // A free port is only free when it was probed: another test process's server, or any outgoing connection on this machine, can take it before this
  // server binds it (initdb takes seconds on a loaded machine). A server that cannot bind is started again on a new port (card 19).
  let port = testing.firstPort ?? await freePort();
  // Keep what the server and initdb say: when startup stalls, this is the only evidence there is.
  const log: string[] = [];
  // Also echoed as it happens, prefixed so a CI annotation can show the server's last words even when the process running the tests
  // ends before any test can report them.
  let echo = false; // initdb is chatty and almost never the problem; echo from the moment the server is started
  const keep = (message: unknown) => {
    const line = String(message).trim();
    log.push(line);
    if (log.length > 60) log.shift();
    if (echo) for (const part of line.split(/\r?\n/).slice(0, 6)) process.stderr.write(`[embedded-postgres] server: ${part.slice(0, 300)}\n`);
  };
  // The cluster is UTF8 with the C locale on every platform: initdb on Windows would otherwise pick the legacy code page WIN1252, which
  // cannot store the JSON text the controller keeps. Bind to the IPv4 loopback only: nothing outside this machine can reach the test server, and no name resolution is involved.
  // No Unix-domain socket (the tests connect by TCP only): otherwise every test server puts its socket and lock file in /tmp under its port number, where a
  // lock file left by a killed server whose process number was reused blocks that port for any later server (card 19).
  const settings = { databaseDir: join(directory, "data"), port, user: USER, password: PASSWORD, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=", ...flags], onLog: keep, onError: keep };
  let server = new EmbeddedPostgres(settings);
  const url = (database = "nimblenewt_test") => `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`;
  // The library's own steps have no timeouts and reject with nothing when the server exits early; give each a deadline and the log.
  const started = Date.now();
  const timeline: string[] = [];
  const mark = (event: string): void => { const line = `+${Date.now() - started} ms ${event}`; timeline.push(line); process.stderr.write(`[embedded-postgres] ${line}\n`); };
  const step = async <T>(what: string, ms: number, work: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    mark(`${what}: begin`);
    try {
      const result = await Promise.race([
        work().catch((error: unknown) => { throw error instanceof Error ? error : new Error(`${what} failed without a reason`); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); }),
      ]);
      mark(`${what}: done`);
      return result;
    } catch (error) {
      mark(`${what}: FAILED`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nnode ${process.version} ${process.platform}/${process.arch}; data ${directory}; port ${port}; flags ${JSON.stringify(settings.postgresFlags)}\ntimeline:\n${timeline.join("\n")}\nembedded PostgreSQL log (last lines):\n${log.join("\n")}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };
  // On Windows the server must not be started by running postgres.exe directly: it refuses to run with administrative permissions,
  // and the GitHub-hosted Windows runners run jobs as an administrator. pg_ctl is PostgreSQL's own launcher for this: it starts the
  // server with a restricted token. (Everywhere else the library starts and stops the process itself.)
  const viaPgCtl = process.platform === "win32" || process.env.NIMBLENEWT_TEST_POSTGRES_VIA_PG_CTL === "1"; // the variable lets other platforms exercise the Windows path
  const dataDirectory = join(directory, "data");
  const serverLog = join(directory, "server.log");
  const pgCtlPath = join(binariesDir(join(embeddedDir, "..")), "native", "bin", process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  // pg_ctl's own output goes to a file we open, never to pipes: on Windows `pg_ctl start` leaves a long-running server that can inherit
  // the pipe handles, and Node would then wait for an end-of-file that never comes.
  const pgCtlOutput = join(directory, "pg_ctl.out");
  const pgCtl = (args: string[]): void => {
    const fd = openSync(pgCtlOutput, "w");
    let run;
    try { run = spawnSync(pgCtlPath, args, { stdio: ["ignore", fd, fd], timeout: 120_000 }); } finally { closeSync(fd); }
    let said = "";
    try { said = readFileSync(pgCtlOutput, "utf8").trim().split(/\r?\n/).slice(-6).join(" | "); } catch { /* nothing written */ }
    keep(`pg_ctl ${args[0]}: ${run.error !== undefined ? `spawn error ${run.error.message}` : describeExit(run.status, run.signal)} ${said}`);
    if (run.error !== undefined || run.status !== 0) {
      let tail = "";
      try { tail = readFileSync(serverLog, "utf8").split(/\r?\n/).slice(-15).join("\n"); } catch { /* no log yet */ }
      throw new Error(`pg_ctl ${args[0]} failed (${run.error !== undefined ? run.error.message : describeExit(run.status, run.signal)}): ${said}\nserver log:\n${tail}`);
    }
  };
  const launcher = {
    start: async (): Promise<void> => {
      if (!viaPgCtl) return server.start();
      pgCtl(["start", "-D", dataDirectory, "-w", "-t", "60", "-l", serverLog, "-o", ["-p", String(port), ...settings.postgresFlags].join(" ")]);
      try { for (const line of readFileSync(serverLog, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").slice(-12)) keep(line); } catch { /* the log is only for evidence */ }
    },
    stop: async (mode: "fast" | "immediate" = "fast"): Promise<void> => {
      if (!viaPgCtl) return mode === "fast" ? stopChild() : undefined;
      pgCtl(["stop", "-D", dataDirectory, "-m", mode, "-w", "-t", "60"]);
    },
  };
  /**
   * The library's stop() listens for the server's exit only after signalling it, so for a server that has already ended (crashed, killed) it waits for an event
   * that never comes, with nothing left to keep the event loop alive: node:test then reports "Promise resolution is still pending but the event loop has
   * already resolved" and cancels whatever was still pending (card 19). An ended server is not stopped again, and a stop is bounded: a fast shutdown
   * (it waits for a checkpoint, slow on a loaded machine) becomes an immediate one after 60 s, and a kill 30 s after that.
   */
  const stopChild = async (): Promise<void> => {
    const proc = (server as unknown as { process?: ChildProcess }).process;
    if (proc === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => { proc.once("exit", () => resolve()); });
    const within = async (ms: number): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timer); }
    };
    void server.stop().catch(() => undefined);
    if (await within(60_000)) return;
    keep("fast shutdown did not finish within 60 s: immediate shutdown");
    proc.kill("SIGQUIT");
    if (await within(30_000)) return;
    keep("immediate shutdown did not finish within 30 s: killed");
    proc.kill("SIGKILL");
    await within(10_000);
  };
  if (viaPgCtl) process.once("exit", () => { spawnSync(pgCtlPath, ["stop", "-D", dataDirectory, "-m", "immediate"], { stdio: "ignore", timeout: 30_000 }); });
  try {
    await step("initdb", 120_000, () => server.initialise());
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await step("starting the server", 60_000, () => {
            echo = true;
            const starting = launcher.start();
            if (!viaPgCtl) watchProcess(() => (server as unknown as { process?: ChildProcess }).process, keep);
            return starting;
          });
          break;
        } catch (error) {
          // Only a port someone else took is retried, on a new port; any other failure is reported as it is.
          const said = `${error instanceof Error ? error.message : String(error)}\n${log.join("\n")}`;
          if (attempt >= 5 || !/could not bind|Address already in use|could not create any TCP\/IP sockets/i.test(said)) throw error;
          await launcher.stop().catch(() => undefined);
          const taken = port;
          port = await freePort();
          settings.port = port;
          server = new EmbeddedPostgres(settings);
          mark(`port ${taken} was taken before the server could bind it; starting again on port ${port}`);
        }
      }
    } catch (error) {
      const facts = diagnoseStartFailure(join(embeddedDir, ".."), join(directory, "data"), port);
      for (const line of facts) keep(line);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${facts.join("\n")}`, { cause: error });
    }
    // Create the database ourselves, by address: the library connects to the name "localhost", which resolves differently on different platforms and Node versions.
    await step("creating the test database", 30_000, async () => { await withClient(url("postgres"), async (c) => { await c.query('CREATE DATABASE "nimblenewt_test"'); }); });
  } catch (error) {
    await launcher.stop().catch(() => undefined);
    removeTree(directory);
    throw error;
  }
  return {
    kind: "embedded",
    url,
    version: async () => (await withClient(url(), async (c) => String((await c.query("SHOW server_version")).rows[0]!.server_version))),
    stop: async () => {
      try { await launcher.stop(); } finally { removeTree(directory); }
    },
    ...(viaPgCtl ? {} : { kill: () => { (server as unknown as { process?: ChildProcess }).process?.kill("SIGKILL"); } }),
    crashAndRestart: async () => {
      pgCtl(["stop", "-D", dataDirectory, "-m", "immediate", "-w", "-t", "60"]);
      server = new EmbeddedPostgres(settings);
      await step("restarting the server after the crash", 60_000, () => launcher.start()); // runs crash recovery from the write-ahead log
    },
  };
}

/**
 * The server the PostgreSQL tests use: `NIMBLENEWT_TEST_POSTGRES_URL` (a postgres:// URL of a database the tests may create
 * schemas in) if set, otherwise a real embedded server. Tests never use the embedded binaries' default port.
 */
export async function startTestServer(): Promise<TestServer> {
  const external = process.env.NIMBLENEWT_TEST_POSTGRES_URL;
  if (external !== undefined && external !== "") {
    return {
      kind: "external", url: () => external, version: async () => withClient(external, async (c) => String((await c.query("SHOW server_version")).rows[0]!.server_version)), stop: async () => undefined,
    };
  }
  return startEmbeddedServer();
}

async function withClient<T>(url: string, fn: (client: import("pg").Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/**
 * Runs `statements` in a transaction that is left open while `start()` runs, waits until a session of `application` is blocked on a lock in a statement
 * beginning with `waiterPrefix` (blocked by that transaction), then commits and returns what `start()` settles to. For tests of a race between two sessions.
 */
async function commitWhileWaiting<T>(url: string, statements: readonly string[], application: string, waiterPrefix: string, start: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  return withClient(url, async (owner) => {
    await owner.query("BEGIN");
    for (const statement of statements) await owner.query(statement);
    const started = start();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const waiting = Number((await withClient(url, async (c) => c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND starts_with(query, $2)", [application, waiterPrefix]))).rows[0]?.n);
      if (waiting > 0) break;
      if (Date.now() > deadline) { await owner.query("ROLLBACK"); await started.catch(() => undefined); throw new Error(`no ${application} session waited on "${waiterPrefix}" within ${timeoutMs} ms`); }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await owner.query("COMMIT");
    return started;
  });
}

export { commitWhileWaiting, withClient };
