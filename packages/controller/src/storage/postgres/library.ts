/** Whether the PostgreSQL client library (`pg`) is installed and exposes the pool the adapter uses (card F04j). Lives here because only the storage folders may touch a database driver. */
export async function probePostgresLibrary(): Promise<{ status: "present" } | { status: "missing"; detail: string }> {
  try {
    const mod = (await import("pg")) as { default?: { Pool?: unknown }; Pool?: unknown };
    const pool = mod.default?.Pool ?? mod.Pool;
    return typeof pool === "function" ? { status: "present" } : { status: "missing", detail: "the pg package does not provide Pool" };
  } catch (error) {
    return { status: "missing", detail: `pg could not be loaded (${error instanceof Error ? error.message.slice(0, 150) : "unknown"})` };
  }
}
