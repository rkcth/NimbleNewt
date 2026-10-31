/**
 * The landing policy of a workspace host, read from the controller's settings (card H12s): `workspace.landing.branch`, `workspace.landing.requirePermit` and `workspace.landing.protectedPaths`, as they apply to the task
 * (installation, the working agent's team and agent, the task). A host composer hands this to `LocalWorkspaces`' (or `WorkspaceHost`'s) `landing` option, so the owner's chat-set values are what a landing runs under.
 * Read fresh at every landing (no copy is kept), so a change counts from the next request. The team and agent layers apply only when an agent owns the task; for a task nobody owns only the installation and task layers do. A task the configuration does not know (a stale ID) is read at the installation layer, which is where a task with no narrower layer
 * would get its values anyway. A failure to read throws; the host treats that as "no policy" and refuses the landing (nothing is guessed).
 */
export interface LandingPolicyFigures {
  readonly branch?: string;
  readonly requirePermit?: boolean;
  readonly protectedPaths?: readonly string[];
  readonly protectDefaults?: boolean;
}

export interface LandingPolicySource {
  taskValues(keys: readonly string[], taskId: string): Promise<Readonly<Record<string, unknown>> | undefined>;
  installationValues(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>;
}

export const LANDING_SETTING_KEYS = { branch: "workspace.landing.branch", requirePermit: "workspace.landing.requirePermit", protectedPaths: "workspace.landing.protectedPaths", protectDefaults: "workspace.landing.protectDefaults" } as const;

export function landingPolicyFrom(source: LandingPolicySource): (call: { readonly taskId: string; readonly projectId: string }) => Promise<LandingPolicyFigures> {
  const keys = Object.values(LANDING_SETTING_KEYS);
  return async (call) => {
    // One combination of the layers per landing, so the four values come from the same revisions.
    const v = (await source.taskValues(keys, call.taskId)) ?? (await source.installationValues(keys));
    const branch = v[LANDING_SETTING_KEYS.branch], permit = v[LANDING_SETTING_KEYS.requirePermit], paths = v[LANDING_SETTING_KEYS.protectedPaths], defaults = v[LANDING_SETTING_KEYS.protectDefaults];
    return {
      ...(typeof branch === "string" ? { branch } : {}),
      // Unset or anything but an explicit false: the permit is required (the setting's own default).
      requirePermit: permit !== false,
      protectDefaults: defaults !== false,
      ...(Array.isArray(paths) ? { protectedPaths: paths.filter((p): p is string => typeof p === "string") } : {}),
    };
  };
}
