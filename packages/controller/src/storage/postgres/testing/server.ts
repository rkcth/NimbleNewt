import { spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** A PostgreSQL server for tests. Either one the caller supplies, or a real one started from the `embedded-postgres` binaries. */
export interface TestServer {
  readonly kind: "embedded" | "external";
  /** A connection string for the named database on this server. */
  url(database?: string): string;
  /** The server's version string, for reports. */
  version(): Promise<string>;
  stop(): Promise<void>;
  /** Embedded servers only: stop the server with an immediate shutdown (no clean checkpoint, like a crash), then start it again on the same data and port. */
  crashAndRestart?(): Promise<void>;
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
export async function startEmbeddedServer(flags: readonly string[] = [], baseDirectory: string = tmpdir()): Promise<TestServer> {
  const require = createRequire(import.meta.url);
  const embeddedDir = dirname(require.resolve("embedded-postgres"));
  hydrateSymlinks(join(embeddedDir, ".."));
  type Embedded = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(name: string): Promise<void> };
  const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (options: Record<string, unknown>) => Embedded };
  const directory = mkdtempSync(join(baseDirectory, "nn-test-pg-"));
  const port = await freePort();
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
  // Bind to the IPv4 loopback only: nothing outside this machine can reach the test server, and no name resolution is involved.
  const settings = { databaseDir: join(directory, "data"), port, user: USER, password: PASSWORD, persistent: true, postgresFlags: ["-c", "listen_addresses=127.0.0.1", ...flags], onLog: keep, onError: keep };
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
      if (!viaPgCtl) return mode === "fast" ? server.stop() : undefined;
      pgCtl(["stop", "-D", dataDirectory, "-m", mode, "-w", "-t", "60"]);
    },
  };
  if (viaPgCtl) process.once("exit", () => { spawnSync(pgCtlPath, ["stop", "-D", dataDirectory, "-m", "immediate"], { stdio: "ignore", timeout: 30_000 }); });
  try {
    await step("initdb", 120_000, () => server.initialise());
    try {
      await step("starting the server", 60_000, () => {
        echo = true;
        const starting = launcher.start();
        if (!viaPgCtl) watchProcess(() => (server as unknown as { process?: ChildProcess }).process, keep);
        return starting;
      });
    } catch (error) {
      const facts = diagnoseStartFailure(join(embeddedDir, ".."), join(directory, "data"), port);
      for (const line of facts) keep(line);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${facts.join("\n")}`, { cause: error });
    }
    // Create the database ourselves, by address: the library connects to the name "localhost", which resolves differently on different platforms and Node versions.
    await step("creating the test database", 30_000, async () => { await withClient(url("postgres"), async (c) => { await c.query('CREATE DATABASE "nimblenewt_test"'); }); });
  } catch (error) {
    await launcher.stop().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
  return {
    kind: "embedded",
    url,
    version: async () => (await withClient(url(), async (c) => String((await c.query("SHOW server_version")).rows[0]!.server_version))),
    stop: async () => {
      try { await launcher.stop(); } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    },
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

export { withClient };
