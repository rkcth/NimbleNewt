import type { AgentPolicyContext } from "./policy.js";

/** The rules that bind an agent, as the short text it is given with its task (card U04d). Only what the agent needs to plan around: how each class of action is decided, what only the owner may review, the approvals it holds, and the latest changes. */
export function describePolicyContext(c: AgentPolicyContext): string {
  const list = (xs: readonly string[]): string => (xs.length === 0 ? "none" : xs.join(", "));
  const lines = [
    "Rules that bind you in this project (read at the start of this attempt; they may change later):",
    `- Approval profile: ${c.profile}${c.allCommandGate ? ", with every command gated" : ""}; environment: ${c.environment}.`,
    `- Runs without asking: ${list(c.decidedBy.allow)}.`,
    `- Goes to a reviewing agent: ${list(c.decidedBy["agent-review"])}.`,
    `- Goes to the owner: ${list(c.decidedBy.owner)}.`,
  ];
  if (c.reservedForOwner.length > 0) lines.push(`- Only the owner may review: ${list(c.reservedForOwner)}.`);
  if (c.approvals.length > 0) lines.push(`- Approvals you hold: ${c.approvals.map((a) => `${a.action}${a.environments === undefined ? "" : ` in ${a.environments.join("/")}`}${a.expiresAt === undefined ? "" : ` until ${a.expiresAt}`}`).join("; ")}.`);
  if (c.recentChanges.length > 0) lines.push(`- Latest changes: ${c.recentChanges.slice(-3).map((h) => `${h.summary} (${h.scope}, ${h.by})`).join("; ")}.`);
  return lines.join("\n");
}
