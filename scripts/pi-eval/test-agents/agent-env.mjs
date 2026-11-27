// The environment the bench's tests hand to an agent run (runner.test.mjs, isolation.test.mjs).
//
// Run under the offline guard (`node --import <checkout>/scripts/offline-guard.mjs --test ...`), the test process's
// NODE_OPTIONS names the guard's file (the guard adds itself there so child processes load it too), and the bench passes
// NODE_OPTIONS on to its agent. When the checkout lies in a place the sandbox hides (/srv/ai, the owner's home folder),
// the agent's Node cannot read that file and exits 1 before it does anything (README: "A NODE_OPTIONS naming a file in a
// hidden or private place stops the agent's Node from starting"). The guard is the test process's tripwire, not the
// agent's: the sandbox cuts the agent's network itself, which these tests assert. Only the guard's own import is taken out;
// every other NODE_OPTIONS setting, and every other variable, is kept.

const GUARD_IMPORT = /(^|\s)--import=\S*\/offline-guard\.mjs(?=\s|$)/g;

/** `env` without the offline guard's `--import` in NODE_OPTIONS (NODE_OPTIONS dropped when nothing else is left in it). */
export function withoutOfflineGuard(env = process.env) {
  const out = { ...env };
  if (typeof out.NODE_OPTIONS !== "string") return out;
  const rest = out.NODE_OPTIONS.replace(GUARD_IMPORT, "$1").trim();
  if (rest === "") delete out.NODE_OPTIONS;
  else out.NODE_OPTIONS = rest;
  return out;
}
