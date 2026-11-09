// Loading and checking the pinned task set (card W01).
import { readFileSync } from "node:fs";
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
    return {
      ...t,
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
