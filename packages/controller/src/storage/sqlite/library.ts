/**
 * Whether the SQLite library this controller uses (`node:sqlite`, part of Node.js) is there and works, found by opening an in-memory database and asking for its version (card F04j).
 * Lives here because only the storage folders may touch a database driver.
 */
export async function probeSqliteLibrary(): Promise<{ status: "present"; version: string } | { status: "missing"; detail: string }> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      const row = db.prepare("select sqlite_version() as v").get() as { v?: string } | undefined;
      return { status: "present", version: row?.v ?? "0" };
    } finally { db.close(); }
  } catch (error) {
    return { status: "missing", detail: `node:sqlite could not be loaded (${error instanceof Error ? error.message.slice(0, 150) : "unknown"})` };
  }
}
