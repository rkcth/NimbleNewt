import { OWNER_SECRET_PREFIX } from "../admin/admin.js";
import { SIGNING_SECRET_NAME } from "../backup/signing.js";

/**
 * Secret names the installation keeps for its own use, apart from the ones the configuration names (the database address and the transfer targets', which a caller adds). Kept in a constant of its own
 * so that the list the Secrets form reserves (`admin/admin.ts`) is reused, not copied: the owner's credential is matched by `OWNER_SECRET_PREFIX`, and these names are the fixed ones.
 */
export const INSTALLATION_SECRET_NAMES: readonly string[] = [SIGNING_SECRET_NAME];

/**
 * Why a secret name may not be a model provider's credential, or undefined when it may be. A provider's key is sent to that provider's server as a bearer token, so a name that holds something else
 * (the owner's credential, the database address, a transfer target's address, the backup signing key) would hand that to a model server. Letter case is ignored, as the secret stores ignore it.
 * `kept` is the configuration's own names (the database address's, the transfer targets', a backup signing key given another name).
 */
export function providerSecretRefusal(name: string, kept: readonly string[] = []): string | undefined {
  const lower = name.toLowerCase();
  if (lower.startsWith(OWNER_SECRET_PREFIX)) return "that is where the owner's credential is kept, which is never sent to a model server";
  if ([...INSTALLATION_SECRET_NAMES, ...kept].some((k) => k.toLowerCase() === lower)) return "the installation keeps that secret for something else (its database address, a database transfer target or the backup signing key), which is never sent to a model server";
  return undefined;
}
