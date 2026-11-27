// W09 second slice: the clauses of a bench task's CONTRACT section, for the task contract's acceptance criteria (the product's done check then asks PLAN.md to map each clause to a test of the change; see
// packages/controller/src/dispatch/clause-plan.ts). Offline and model-free.

/** The contract's bounds (packages/controller/src/planning/contracts.ts CONTRACT_LIMITS): at most 50 criteria of at most 500 characters. */
export const CLAUSE_LIMITS = Object.freeze({ criteria: 50, criterion: 500 });

/** The text cut to at most `max` UTF-16 units between whole characters, ending in "..." when cut. */
function cut(text, max) {
  if (text.length <= max) return text;
  let out = "";
  for (const c of text) { if (out.length + c.length > max - 3) break; out += c; }
  return `${out}...`;
}

/**
 * The bullets of the task text's CONTRACT section, in order: the section starts at a line beginning `CONTRACT`; each bullet is a line beginning `- ` and the indented lines after it; the section ends at the next line that is not
 * a bullet, not indented and not empty. A bullet is cut to the contract's bound (the agent has it whole in the task's description; the done check only needs its number). Empty when the text has no such section.
 */
export function contractClauses(taskText) {
  const lines = String(taskText).split(/\r\n|\n|\r/);
  const start = lines.findIndex((l) => /^CONTRACT\b/.test(l));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("- ")) { out.push(line.slice(2).trim()); continue; }
    if (line.trim() === "") continue;
    if (/^[ \t]/.test(line) && out.length > 0) { out[out.length - 1] += ` ${line.trim()}`; continue; }
    break;
  }
  return out.filter((c) => c !== "").slice(0, CLAUSE_LIMITS.criteria).map((c) => cut(c, CLAUSE_LIMITS.criterion));
}
