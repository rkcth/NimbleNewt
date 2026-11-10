// Loading and checking the pinned task set (card W01).
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { SIZES } from "./stats.mjs";

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Reads taskset.json and fills each task from the defaults. Throws with every problem listed, so a bad set never starts a run. */
export function loadTaskset(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const root = dirname(file);
  const problems = [];
  const d = raw.defaults ?? {};
  if (!raw.agent || typeof raw.agent.provider !== "string" || typeof raw.agent.model !== "string") problems.push("agent.provider and agent.model are required");
  if (!raw.variants || typeof raw.variants !== "object") problems.push("variants is required");
  // A variant name is part of each run's checkout directory name, so it must be a plain name.
  for (const k of Object.keys(raw.variants ?? {})) if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,20}$/.test(k)) problems.push(`variant ${JSON.stringify(k)}: name must be letters, digits and dashes`);
  const seen = new Set();
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map((t, i) => {
    const where = `tasks[${i}] (${t?.id ?? "?"})`;
    if (!ID.test(String(t?.id))) problems.push(`${where}: id must match ${ID}`);
    if (seen.has(t?.id)) problems.push(`${where}: duplicate id`);
    seen.add(t?.id);
    if (!SIZES.includes(t?.size)) problems.push(`${where}: size must be one of ${SIZES.join(", ")}`);
    if (!SHA.test(String(t?.base))) problems.push(`${where}: base must be a full 40-character commit`);
    if (!SHA.test(String(t?.solution))) problems.push(`${where}: solution must be a full 40-character commit`);
    if (!Array.isArray(t?.hiddenFiles) || t.hiddenFiles.length === 0) problems.push(`${where}: hiddenFiles must list the held-back test files`);
    if (!Array.isArray(t?.testFiles) || t.testFiles.length === 0) problems.push(`${where}: testFiles must list the tests to run`);
    for (const f of [...(t?.hiddenFiles ?? []), ...(t?.testFiles ?? [])]) if (typeof f !== "string" || isAbsolute(f) || f.split(/[\\/]/).includes("..")) problems.push(`${where}: ${JSON.stringify(f)} must be a relative path inside the repository`);
    const timeoutMinutes = t?.timeoutMinutes ?? d.timeoutMinutes?.[t?.size];
    if (!(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0)) problems.push(`${where}: no timeout for size ${t?.size}`);
    const acceptance = loadAcceptance(root, t, where, problems);
    return {
      ...t,
      acceptance,
      // The card's own test files as merged: scored for information only when an acceptance suite exists.
      shipped: { hiddenFiles: t?.hiddenFiles ?? [], testFiles: t?.testFiles ?? [] },
      promptPath: join(root, String(t?.prompt ?? `tasks/${t?.id}.md`)),
      timeoutMinutes,
      copy: t?.copy ?? d.copy ?? [],
      setup: t?.setup ?? d.setup ?? null,
      test: t?.test ?? d.test,
    };
  });
  if (tasks.length === 0) problems.push("tasks is empty");
  if (problems.length > 0) throw new Error(`taskset ${file}:\n- ${problems.join("\n- ")}`);
  const variants = Object.fromEntries(Object.entries(raw.variants).map(([k, v]) => [k, { ...v, promptPath: v.prompt ? join(root, v.prompt) : null }]));
  return { ...raw, root, file, tasks, variants, repeats: d.repeats ?? 1 };
}

const relPath = (f) => typeof f === "string" && f !== "" && !isAbsolute(f) && !f.split(/[\\/]/).includes("..");

/**
 * A task's acceptance suite: bench-owned test files (in `acceptance/<id>/`, or `t.acceptance.dir`) written into the
 * checkout at fresh paths, plus optional `support` files taken from the solution commit, the dist files to run, optional
 * test-name patterns, and the spec-fit allowlist ({ "<item>": "<why the agent can know it>" }). Read from the task's
 * `acceptance` object or, when absent, from `acceptance/<id>/acceptance.json`. null when the task has none (then the
 * shipped test files are the score, as before).
 */
function loadAcceptance(root, t, where, problems) {
  const dir = join(root, String(t?.acceptance?.dir ?? `acceptance/${t?.id}`));
  let a = t?.acceptance ?? null;
  if (a === null && existsSync(join(dir, "acceptance.json"))) {
    try { a = JSON.parse(readFileSync(join(dir, "acceptance.json"), "utf8")); } catch (e) { problems.push(`${where}: acceptance.json: ${e.message}`); return null; }
  }
  if (a === null) return null;
  const files = Object.entries(a.files ?? {}).map(([dest, src]) => ({ dest, src: join(dir, String(src)) }));
  if (files.length === 0) problems.push(`${where}: acceptance.files must map at least one checkout path to a bench file`);
  for (const f of files) {
    if (!relPath(f.dest)) problems.push(`${where}: acceptance file ${JSON.stringify(f.dest)} must be a relative path inside the repository`);
    // A fresh, recognisable name, so it cannot be one of the agent's own test files.
    else if (!/(?:^|\/)w01-acceptance-[^/]*$/.test(f.dest)) problems.push(`${where}: acceptance file ${f.dest} must be named w01-acceptance-*`);
    if (!existsSync(f.src)) problems.push(`${where}: acceptance source ${f.src} is missing`);
  }
  const support = a.support ?? [];
  const testFiles = a.testFiles ?? [];
  if (!Array.isArray(testFiles) || testFiles.length === 0) problems.push(`${where}: acceptance.testFiles must list the files to run`);
  for (const f of [...support, ...testFiles]) if (!relPath(f)) problems.push(`${where}: ${JSON.stringify(f)} must be a relative path inside the repository`);
  const allow = a.allow ?? {};
  for (const [k, v] of Object.entries(allow)) if (typeof v !== "string" || v.trim() === "") problems.push(`${where}: acceptance.allow[${JSON.stringify(k)}] needs a reason`);
  return { dir, files, support, testFiles, testNamePatterns: a.testNamePatterns ?? [], allow };
}

/** Fills a prompt template. Only the named placeholders are replaced; the task text is inserted as it is. */
export function renderPrompt(template, { task, taskText, worktreeUrl }) {
  return template.replaceAll("{{TASK_ID}}", task.id).replaceAll("{{WORKTREE_URL}}", worktreeUrl).replace("{{TASK}}", () => taskText.trim());
}

/** Expands a command spec's placeholders: {{WORKTREE}}, {{WORKTREE_URL}} and {{TEST_FILES}} (which becomes several arguments). */
export function expandArgv(argv, { worktree, worktreeUrl, testFiles = [] }) {
  const out = [];
  for (const a of argv) {
    if (a === "{{TEST_FILES}}") { out.push(...testFiles); continue; }
    out.push(a.replaceAll("{{WORKTREE_URL}}", worktreeUrl).replaceAll("{{WORKTREE}}", worktree));
  }
  return out;
}
