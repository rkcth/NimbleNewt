import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
  const keep = (message: unknown) => { log.push(String(message).trim()); if (log.length > 60) log.shift(); };
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
  try {
    await step("initdb", 120_000, () => server.initialise());
    await step("starting the server", 60_000, () => server.start());
    // Create the database ourselves, by address: the library connects to the name "localhost", which resolves differently on different platforms and Node versions.
    await step("creating the test database", 30_000, async () => { await withClient(url("postgres"), async (c) => { await c.query('CREATE DATABASE "nimblenewt_test"'); }); });
  } catch (error) {
    await server.stop().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
  return {
    kind: "embedded",
    url,
    version: async () => (await withClient(url(), async (c) => String((await c.query("SHOW server_version")).rows[0]!.server_version))),
    stop: async () => {
      try { await server.stop(); } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    },
    crashAndRestart: async () => {
      const pgCtl = join(binariesDir(join(embeddedDir, "..")), "native", "bin", process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
      const stopped = spawnSync(pgCtl, ["stop", "-D", join(directory, "data"), "-m", "immediate", "-w", "-t", "60"], { encoding: "utf8", timeout: 90_000 });
      if (stopped.status !== 0) throw new Error(`pg_ctl stop -m immediate failed (${stopped.error?.message ?? `exit ${stopped.status}`}): ${stopped.stdout ?? ""}${stopped.stderr ?? ""}`);
      server = new EmbeddedPostgres(settings);
      await step("restarting the server after the crash", 60_000, () => server.start()); // runs crash recovery from the write-ahead log
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
