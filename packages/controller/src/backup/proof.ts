import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { UnlockMethod } from "./encryption.js";

const REF = { kind: "backup-proof", id: "main" } as const;

/** The last proof that an unlock method works (card K01b), kept in the database so the quarterly reminder survives a restart. */
export interface BackupProofBody { readonly method: UnlockMethod; readonly at: string; /** The key this proof was for: a proof of an older key does not count for a rotated one. */ readonly keyId: string }

/** Records the last SUCCESSFUL proof (a failed one is not a proof, and is not kept). No secret is ever in it. */
export class BackupProofStore {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): BackupProofStore { return new BackupProofStore(new CommandRunner(storage, epoch, options)); }

  async load(): Promise<BackupProofBody | undefined> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return found === undefined ? undefined : found.body as unknown as BackupProofBody;
  }

  async save(proof: BackupProofBody): Promise<void> {
    const current = await this.#runner.get(REF.kind, REF.id);
    const body = proof as unknown as JsonObject;
    await this.#runner.command("backup.encryption.proof", { commandId: `backup-proof-${proof.at}-${proof.method}`, actor: "controller" }, async () => ({
      payload: { method: proof.method, keyId: proof.keyId },
      build: async () => ({ ref: REF, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: REF, body } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body }], detail: { method: proof.method } }),
    }));
  }
}
