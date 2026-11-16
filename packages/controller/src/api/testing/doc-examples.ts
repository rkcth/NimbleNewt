import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads the worked examples out of a guide (card D02) so a test can run them against a real controller. In a guide an example is two fenced blocks in a row, the request and then
 * the answer, written as `json` (a state API or MCP message) or `http` (a request line, headers, a blank line, a body; the answer is a status line and a body). A line
 * `<!-- as: NAME -->` just before a request says whose credential sends it (default: the owner). The answer may leave fields out (it is matched as a subset) and may write
 * a value as `prefix-...`, which stands for any ID or text that begins with `prefix-` and, in a request, for the latest ID with that prefix an earlier answer showed.
 */
export interface Example {
  readonly as: string;
  readonly kind: "json" | "http";
  readonly request: { readonly method?: string; readonly path?: string; readonly headers: Readonly<Record<string, string>>; readonly body?: unknown };
  readonly response: { readonly status?: number; readonly body?: unknown };
  readonly line: number;
}

export function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package-lock.json")) && existsSync(join(dir, "docs", "nimblenewt"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("the repository root was not found");
    dir = up;
  }
}

function parseHttp(text: string): { first: string; headers: Record<string, string>; body?: unknown } {
  const lines = text.replace(/\r/g, "").split("\n");
  const first = (lines.shift() ?? "").trim();
  const headers: Record<string, string> = {};
  while (lines.length > 0 && lines[0]!.trim() !== "") {
    const line = lines.shift()!;
    const i = line.indexOf(":");
    if (i < 1) throw new Error(`not a header line: ${line}`);
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const rest = lines.join("\n").trim();
  return { first, headers, ...(rest === "" ? {} : { body: JSON.parse(rest) as unknown }) };
}

export function readExamples(file: string): Example[] {
  const text = readFileSync(join(repositoryRoot(), file), "utf8");
  const blocks: { lang: string; text: string; as?: string; line: number }[] = [];
  const re = /(?:<!-- as: (\w+) -->\s*\n)?```(json|http)\n([\s\S]*?)```/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    blocks.push({ lang: m[2]!, text: m[3]!, ...(m[1] === undefined ? {} : { as: m[1] }), line: text.slice(0, m.index).split("\n").length });
  }
  if (blocks.length % 2 !== 0) throw new Error(`${file}: the example blocks do not pair up (${blocks.length})`);
  const out: Example[] = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const q = blocks[i]!; const a = blocks[i + 1]!;
    if (q.lang !== a.lang) throw new Error(`${file}:${q.line}: the request and its answer are written in different languages`);
    if (a.as !== undefined) throw new Error(`${file}:${a.line}: an answer cannot say who sends it`);
    if (q.lang === "json") out.push({ as: q.as ?? "owner", kind: "json", request: { headers: {}, body: JSON.parse(q.text) }, response: { body: JSON.parse(a.text) }, line: q.line });
    else {
      const r = parseHttp(q.text); const s = parseHttp(a.text);
      const [method, path] = r.first.split(/\s+/);
      if (method === undefined || path === undefined) throw new Error(`${file}:${q.line}: no request line`);
      out.push({ as: q.as ?? "owner", kind: "http", request: { method, path, headers: r.headers, ...(r.body === undefined ? {} : { body: r.body }) }, response: { status: Number(s.first), ...(s.body === undefined ? {} : { body: s.body }) }, line: q.line });
    }
  }
  return out;
}

/** The IDs the answers showed so far, by prefix, newest wins. */
export class Ids {
  readonly #latest = new Map<string, string>();
  seed(id: string): void { this.learn(id); }
  learn(value: unknown): void {
    if (typeof value === "string") {
      const m = /^([a-z]+)-[a-z0-9]+$/.exec(value);
      if (m !== null) this.#latest.set(m[1]!, value);
    } else if (Array.isArray(value)) for (const v of value) this.learn(v);
    else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) this.learn(v);
  }
  /** A request with every `prefix-...` replaced by the latest ID of that prefix. */
  fill<T>(value: T): T {
    if (typeof value === "string") {
      return value.replace(/\b([a-z]+)-\.\.\.(?![.\w])/g, (_all, prefix: string) => {
        const id = this.#latest.get(prefix);
        if (id === undefined) throw new Error(`no earlier answer showed an ID starting ${prefix}-`);
        return id;
      }) as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.fill(v)) as T;
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.fill(v)])) as T;
    return value;
  }
}

/** Why `actual` does not match what the guide shows, or undefined when it does. */
export function mismatch(expected: unknown, actual: unknown, path = "$"): string | undefined {
  if (typeof expected === "string") {
    if (typeof actual !== "string") return `${path}: the guide shows ${JSON.stringify(expected)}, the controller gave ${JSON.stringify(actual)}`;
    if (!expected.includes("...")) return expected === actual ? undefined : `${path}: the guide shows ${JSON.stringify(expected)}, the controller gave ${JSON.stringify(actual)}`;
    const pattern = new RegExp(`^${expected.split("...").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`);
    return pattern.test(actual) ? undefined : `${path}: the guide shows ${JSON.stringify(expected)}, the controller gave ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${path}: the guide shows a list of ${expected.length}, the controller gave ${JSON.stringify(actual)?.slice(0, 200)}`;
    for (let i = 0; i < expected.length; i++) { const bad = mismatch(expected[i], actual[i], `${path}[${i}]`); if (bad !== undefined) return bad; }
    return undefined;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return `${path}: the guide shows an object, the controller gave ${JSON.stringify(actual)?.slice(0, 200)}`;
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in actual)) return `${path}.${k}: the guide shows it, the controller's answer has no such field`;
      const bad = mismatch(v, (actual as Record<string, unknown>)[k], `${path}.${k}`);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  return expected === actual ? undefined : `${path}: the guide shows ${JSON.stringify(expected)}, the controller gave ${JSON.stringify(actual)}`;
}
