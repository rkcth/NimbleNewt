import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { PostgresStorage } from "../postgres/index.js";
import { startEmbeddedServer, withClient } from "../postgres/testing/server.js";
import { SqliteStorage } from "../sqlite/index.js";
import { SCENARIOS, assertInvariants, runWorkload, type WorkloadResult, type WorkloadSpec } from "./workload.js";

/**
 * Produces the storage workload report: `node dist/storage/qualification/report.js out.json [--seconds N]`. Runs every scenario
 * on SQLite and on a real PostgreSQL server (started from the embedded binaries on a free loopback port) on this machine, and
 * writes the measurements with a description of the machine. It makes no claim about real-agent capacity: the load is synthetic
 * and storage-only, and the numbers are specific to the hardware and settings recorded alongside them.
 */
/** The file system a directory lives on, from the Linux mount table (longest matching mount point), or "unknown". */
export function filesystemOf(directory: string): string {
  try {
    let best: { mount: string; type: string } | undefined;
    for (const line of readFileSync("/proc/self/mounts", "utf8").split("\n")) {
      const [, mount, type] = line.split(" ");
      if (mount === undefined || type === undefined) continue;
      if ((directory === mount || directory.startsWith(mount.endsWith("/") ? mount : `${mount}/`)) && (best === undefined || mount.length >= best.mount.length)) best = { mount, type };
    }
    return best?.type ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface Report {
  readonly generatedAt: string;
  readonly machine: { readonly platform: string; readonly release: string; readonly arch: string; readonly cpus: number; readonly cpuModel: string; readonly memoryGiB: number; readonly loadAverage: number[]; readonly node: string; readonly dataDirectory: string; readonly dataFilesystem: string };
  /** Present when the numbers cannot be trusted to reflect the cost of durable writes. */
  readonly warning?: string;
  readonly backends: Record<string, { readonly settings: unknown; readonly results: WorkloadResult[] }>;
}

export async function buildReport(scenarios: readonly WorkloadSpec[], baseDirectory: string = os.tmpdir()): Promise<Report> {
  mkdirSync(baseDirectory, { recursive: true });
  const dataFilesystem = filesystemOf(baseDirectory);
  const machine = {
    platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? "unknown",
    memoryGiB: Math.round(os.totalmem() / 2 ** 30), loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100), node: process.version, dataDirectory: baseDirectory, dataFilesystem,
  };
  const backends: Report["backends"] = {};

  const dir = mkdtempSync(join(baseDirectory, "nn-report-"));
  try {
    const sqlite = await SqliteStorage.open({ path: join(dir, "controller.sqlite") });
    const results: WorkloadResult[] = [];
    for (const [i, spec] of scenarios.entries()) {
      const fresh = i === 0 ? sqlite : await SqliteStorage.open({ path: join(dir, `controller-${i}.sqlite`) });
      const result = await runWorkload(fresh, spec);
      assertInvariants(result);
      results.push(result);
      if (i > 0) await fresh.close();
    }
    backends.sqlite = { settings: sqlite.settings(), results };
    await sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  const server = await startEmbeddedServer([], baseDirectory);
  try {
    const results: WorkloadResult[] = [];
    let settings: unknown;
    for (const [i, spec] of scenarios.entries()) {
      const schema = `report_${i}`;
      const storage = await PostgresStorage.open({ connectionString: server.url(), schema, maxConnections: 10 });
      settings = await storage.settings();
      const result = await runWorkload(storage, spec, { poolStats: () => storage.poolStats() });
      assertInvariants(result);
      results.push(result);
      await storage.close();
      await withClient(server.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
    }
    backends.postgres = { settings, results };
  } finally {
    await server.stop();
  }
  const volatile = ["tmpfs", "ramfs"].includes(dataFilesystem);
  return { generatedAt: new Date().toISOString(), machine, backends, ...(volatile ? { warning: `The data directory is on ${dataFilesystem}, which is memory: flushing to disk costs nothing there, so these numbers say nothing about the cost of durable commits. Rerun with --dir on a real disk.` } : {}) };
}

export function summarize(report: Report): string {
  const lines: string[] = [...(report.warning === undefined ? [] : [`WARNING: ${report.warning}\n`]), `data: ${report.machine.dataDirectory} on ${report.machine.dataFilesystem}`, `machine: ${report.machine.platform} ${report.machine.release}, ${report.machine.cpus} x ${report.machine.cpuModel}, ${report.machine.memoryGiB} GiB, ${report.machine.node}, load ${report.machine.loadAverage.join("/")}`];
  for (const [backend, data] of Object.entries(report.backends)) {
    for (const r of data.results) {
      lines.push(`\n${backend} | ${r.spec.name}`);
      for (const [kind, s] of Object.entries(r.latency)) lines.push(`  ${kind.padEnd(14)} ${String(s.count).padStart(6)} calls  ${String(s.perSecond).padStart(8)}/s  p50 ${s.p50}  p95 ${s.p95}  p99 ${s.p99}  max ${s.max} ms`);
      lines.push(`  event loop delay p50 ${r.eventLoopDelayMs.p50} p99 ${r.eventLoopDelayMs.p99} max ${r.eventLoopDelayMs.max} ms; caller-retried conflicts ${r.conflictsRetriedByCaller}${r.pool ? `; pool peak ${r.pool.maxTotal} connections, ${r.pool.maxWaiting} waiting` : ""}`);
      const refused = Object.entries(r.calls).flatMap(([m, o]) => Object.entries(o).filter(([k]) => k !== "ok").map(([k, n]) => `${m}:${k}=${n}`));
      lines.push(`  refused raw calls: ${refused.length === 0 ? "none" : refused.join(", ")}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const out = process.argv[2];
  const dirFlag = process.argv.indexOf("--dir");
  const baseDirectory = dirFlag > 0 ? process.argv[dirFlag + 1] : undefined;
  const secondsFlag = process.argv.indexOf("--seconds");
  const seconds = secondsFlag > 0 ? Number(process.argv[secondsFlag + 1]) : undefined;
  const scenarios = seconds === undefined ? SCENARIOS : SCENARIOS.map((s) => ({ ...s, durationMs: seconds * 1000 }));
  const report = await buildReport(scenarios, baseDirectory);
  if (out !== undefined && !out.startsWith("--")) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(summarize(report));
}

if (process.argv[1]?.endsWith("report.js")) await main();
