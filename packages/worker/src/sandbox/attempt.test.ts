import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attemptSandbox } from "./attempt.js";
import { SandboxError } from "./errors.js";
import { normalizeRecipe } from "./recipe.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-attempt-")));
const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
const plan = () => ({ checkout: dir("agents/ann/work"), gitDir: dir("agents/ann/git"), home: dir("agents/ann/home"), scratch: dir("agents/ann/scratch") });

test("the sandbox of an attempt mounts the checkout only: the separate git directory is a protected path and no recipe can mount it", () => {
  const p = plan();
  const { recipe, protectedPaths } = attemptSandbox(p, { protectedPaths: [] });
  assert.ok(protectedPaths.includes(p.gitDir));
  const normalized = normalizeRecipe(recipe, protectedPaths);
  assert.equal(normalized.workdir, p.checkout);
  assert.deepEqual([...normalized.readOnly], []);
  assert.ok(![normalized.workdir, normalized.home, normalized.scratch].some((m) => m === p.gitDir || p.gitDir.startsWith(m + "/")));
  // A recipe that tries to mount it (as an input, or as the working directory) is refused by the launcher's own check, because it is a protected path.
  const refuse = (r: Parameters<typeof normalizeRecipe>[0]) => assert.throws(() => normalizeRecipe(r, protectedPaths), (e: unknown) => e instanceof SandboxError && /protected path/.test(e.message));
  refuse({ ...recipe, readOnly: [{ host: p.gitDir, guest: "/inputs/git" }] });
  refuse({ ...recipe, workdir: p.gitDir });
  refuse({ ...recipe, readOnly: [{ host: dir("agents/ann"), guest: "/inputs/agent" }] });
  // The checkout's .git pointer file stays a protected sub-path.
  writeFileSync(join(p.checkout, ".git"), `gitdir: ${p.gitDir}\n`);
  assert.deepEqual(normalizeRecipe(recipe, protectedPaths).protectedSubpaths, [".git"]);
});

test("a git directory the sandbox could reach is refused when the sandbox is planned", () => {
  const refuse = (p: ReturnType<typeof plan>, pattern: RegExp) => assert.throws(() => attemptSandbox(p, { protectedPaths: [] }), (e: unknown) => e instanceof SandboxError && pattern.test(e.message));
  const p = plan();
  refuse({ ...p, gitDir: join(p.checkout, ".git-data") }, /checkout/);
  refuse({ ...p, gitDir: p.home }, /home/);
  refuse({ ...p, gitDir: dir("agents/ann") }, /overlaps/);
  refuse({ ...p, gitDir: "relative/git" }, /absolute/);
  refuse({ ...p, readOnly: [{ host: p.gitDir, guest: "/inputs/g" }] } as never, /readOnly\[0\]/);
});
