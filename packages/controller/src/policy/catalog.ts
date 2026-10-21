/**
 * The classes of action the approval policy reasons about (card A07). A tool belongs to one class; the policy decides per class and environment, not per tool, so a new tool is covered the
 * moment it is classified, and one that is not classified is `unknown` and goes to review.
 */
export const ACTION_CLASSES = ["inspect", "workspace-edit", "mutate", "external-send", "publish", "spend", "install-executable", "access-change", "commit", "push", "merge", "deploy"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Environments, and how freely work flows in each: development and testing are `free`, staging is `guarded`, customer-live is `live`. */
export const ENVIRONMENTS = ["development", "testing", "staging", "customer-live"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export const TIERS = ["free", "guarded", "live"] as const;
export type Tier = (typeof TIERS)[number];
export const tierOf = (environment: Environment): Tier => (environment === "customer-live" ? "live" : environment === "staging" ? "guarded" : "free");

/** The tools the first release knows, by name. A project's own tools are added with `ActionCatalog.with`. */
export const DEFAULT_TOOL_CLASSES: Readonly<Record<string, ActionClass>> = {
  "read-file": "inspect", "list-files": "inspect", "search-files": "inspect", "grep": "inspect", "git-status": "inspect", "git-diff": "inspect", "git-log": "inspect",
  "edit-file": "workspace-edit", "write-file": "workspace-edit", "delete-file": "workspace-edit", "move-file": "workspace-edit",
  "git-commit": "commit", "git-push": "push", "git-merge": "merge", "deploy": "deploy",
  "send-message": "external-send", "send-email": "external-send", "http-post": "external-send",
  "publish-package": "publish", "publish-post": "publish", "publish-release": "publish",
  "purchase": "spend", "pay": "spend", "buy-credits": "spend",
  "install-package": "install-executable", "install-tool": "install-executable", "register-skill": "install-executable", "install-mcp-server": "install-executable",
  "grant-access": "access-change", "add-user": "access-change", "set-permission": "access-change", "rotate-credential": "access-change", "open-network": "access-change",
  "update-database": "mutate", "delete-remote": "mutate", "call-api": "mutate",
};
/** Tools that run a program: inside the agent's own checkout they only edit it; anywhere else they can change anything. */
export const EXECUTION_TOOLS: ReadonlySet<string> = new Set(["run-script", "shell", "exec"]);

export class ActionCatalog {
  readonly #extra: Readonly<Record<string, ActionClass>>;
  private constructor(extra: Readonly<Record<string, ActionClass>>) { this.#extra = extra; }
  static readonly default = new ActionCatalog({});
  /** The catalogue with more tools classified (a name already known keeps its class). */
  static with(extra: Readonly<Record<string, ActionClass>>): ActionCatalog { return new ActionCatalog({ ...extra }); }

  /** The class of a tool call. A program run is an edit when it runs in the agent's own checkout and a mutation anywhere else. */
  classify(tool: string, targetKind?: string): ActionClass | "unknown" {
    if (EXECUTION_TOOLS.has(tool)) return targetKind === "workspace" ? "workspace-edit" : "mutate";
    return (Object.hasOwn(DEFAULT_TOOL_CLASSES, tool) ? DEFAULT_TOOL_CLASSES[tool] : Object.hasOwn(this.#extra, tool) ? this.#extra[tool] : undefined) ?? "unknown";
  }
}
