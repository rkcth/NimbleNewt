/**
 * The seam for a work-in-progress push or restore that needs a credential (card P02b). The worker's git runs with an empty home and no user configuration on purpose, so a https or ssh remote can be reached only with
 * what the HOST hands it for that one call. Nothing here reads, creates, prints or stores a credential: a helper takes the secret VALUE the host already resolved (from its secret store, by a name the owner chose) and builds
 * the environment of that one git process from it. The environment is never logged, never returned to the controller and never written to a file; the host redacts the values from any message it sends back (`redactEnv`).
 *
 * https: the secret is a token (the user name is then `git`) or `user:password`; it goes out as a Basic `Authorization` header that git adds to requests to that remote's own origin only (`http.<origin>/.extraHeader`).
 * ssh: no secret value passes through here at all. The host's own ssh agent does the signing (`SSH_AUTH_SOCK`), and git is told to run ssh without prompts.
 */

/** The origin (`https://host[:port]/`) of an https remote, or `undefined` when the remote is not one. */
export function httpsOrigin(remote: string): string | undefined {
  let url: URL;
  try { url = new URL(remote); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.host === "") return undefined;
  return `${url.protocol}//${url.host}/`;
}

/** Whether the remote is an ssh address (`ssh://...` or the scp form `user@host:path`). */
export const isSshRemote = (remote: string): boolean => /^ssh:\/\//i.test(remote) || (!remote.includes("://") && /^[^/@:\\]+@[^/@:\\]+:/.test(remote));

/** The environment that lets git send a token to one https remote. Throws a plain reason when the remote is not https or the secret cannot be used. */
export function httpsTokenEnv(remote: string, secret: string): NodeJS.ProcessEnv {
  const origin = httpsOrigin(remote);
  if (origin === undefined) throw new Error("a named secret is used only for an https remote (an ssh remote uses the host's ssh agent)");
  if (typeof secret !== "string" || secret.length === 0 || /[\u0000-\u001f\u007f]/.test(secret)) throw new Error("the named secret is empty or holds a control character, so it cannot be a token");
  const pair = secret.includes(":") ? secret : `git:${secret}`;
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${origin}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(pair, "utf8").toString("base64")}` };
}

/** The environment that lets git reach an ssh remote through the host's own ssh agent, or nothing when the host has no agent (the push then fails with ssh's own reason). */
export function sshAgentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sock = source["SSH_AUTH_SOCK"];
  return { GIT_SSH_COMMAND: "ssh -o BatchMode=yes", ...(typeof sock === "string" && sock.length > 0 ? { SSH_AUTH_SOCK: sock } : {}) };
}

/** Replaces every value of `env` (and the base64 form of a Basic header's pair) in `text`, so a message from git can never carry what the host handed it. */
export function redactEnv(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 6 || key === "GIT_CONFIG_COUNT" || key === "GIT_SSH_COMMAND") continue;
    const parts = new Set([value, value.replace(/^Authorization: Basic /, "")]);
    // A Basic header carries `user:secret` in base64: the decoded pair and the secret alone are cleaned too.
    const encoded = /^Authorization: Basic (\S+)$/.exec(value)?.[1];
    if (encoded !== undefined) { const pair = Buffer.from(encoded, "base64").toString("utf8"); parts.add(pair); parts.add(pair.slice(pair.indexOf(":") + 1)); }
    for (const p of parts) if (p.length >= 6) out = out.split(p).join("[secret]");
  }
  return out;
}

/**
 * The host's `pushEnv` for the usual layout: an ssh remote goes through the host's ssh agent (and refuses a named secret, which would be meaningless there), an https remote with a named secret gets its token header, an https
 * remote with none and a local folder get nothing extra. `secret` reads one secret by NAME from the host's own secret store at the moment of the call; a missing secret fails the call with its name (never a value).
 */
export function wipPushEnv(options: { readonly secret: (name: string) => Promise<string | undefined>; readonly env?: NodeJS.ProcessEnv }): (call: { readonly remote: string; readonly credential?: string }) => Promise<NodeJS.ProcessEnv> {
  return async (call) => {
    if (isSshRemote(call.remote)) {
      if (call.credential !== undefined) throw new Error("a named secret is used only for an https remote; an ssh remote uses the host's ssh agent");
      return sshAgentEnv(options.env);
    }
    if (call.credential === undefined) return {};
    if (httpsOrigin(call.remote) === undefined) throw new Error("a named secret is used only for an https remote");
    const value = await options.secret(call.credential);
    if (value === undefined) throw new Error(`the secret named ${call.credential} is not in the secret store`);
    return httpsTokenEnv(call.remote, value);
  };
}
