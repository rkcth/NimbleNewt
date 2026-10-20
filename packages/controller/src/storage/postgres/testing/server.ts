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
function hydrateSymlinks(embeddedDir: string): void {
  const platform = ({ linux: "linux", darwin: "darwin", win32: "windows" } as Record<string, string>)[process.platform];
  if (platform === undefined) throw new Error(`no embedded PostgreSQL binaries exist for ${process.platform}`);
  const packageDir = join(dirname(embeddedDir), "@embedded-postgres", `${platform}-${process.arch}`);
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
export async function startEmbeddedServer(flags: readonly string[] = []): Promise<TestServer> {
  const require = createRequire(import.meta.url);
  const embeddedDir = dirname(require.resolve("embedded-postgres"));
  hydrateSymlinks(join(embeddedDir, ".."));
  const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (options: Record<string, unknown>) => { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(name: string): Promise<void> } };
  const directory = mkdtempSync(join(tmpdir(), "nn-test-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: join(directory, "data"), port, user: USER, password: PASSWORD, persistent: true, postgresFlags: [...flags], onLog: () => undefined, onError: () => undefined,
  });
  try {
    await server.initialise();
    await server.start();
    await server.createDatabase("nimblenewt_test");
  } catch (error) {
    await server.stop().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
  const url = (database = "nimblenewt_test") => `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`;
  return {
    kind: "embedded",
    url,
    version: async () => (await withClient(url(), async (c) => String((await c.query("SHOW server_version")).rows[0]!.server_version))),
    stop: async () => {
      try { await server.stop(); } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
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
