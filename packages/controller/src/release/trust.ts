import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { CommandRunner } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import { RELEASE_KINDS, candidateIdOf, manifestDigestOf, type CandidateBody } from "./release.js";

/**
 * The trust root for signed release artifact sets (card K02, K02b).
 *
 * What is signed: the candidate's ID and the FULL sha256 of its canonical manifest, which names the sha256 of every artifact. The ID alone is only the first 96 bits of that digest, short enough that two
 * manifests made to share an ID are within reach (a birthday search of about 2^48), so the signature covers the whole digest: it covers exactly the artifact set. A staged directory is verified against that
 * manifest at staging, at activation and at launch, so "signed" means "the owner's chosen publisher vouched for exactly these bytes". The signed text is
 * `nimblenewt-release-v1\n<candidate id>\n<manifest sha256>\n` (a fixed prefix so the signature cannot be replayed for another purpose; release.verify shows the manifest digest). Algorithm: Ed25519 only (no negotiation).
 *
 * The trust root is the list of public keys the OWNER registered (`release.trust.add`, owner only, shown first in chat). A key is a base64 DER SubjectPublicKeyInfo; its ID is the first 16 hex characters of the
 * sha256 of that DER. Signatures are attached by whoever holds them (`release.signature.attach`); an attached signature is verified against the trust root when attached and again at every use, so removing a
 * key withdraws everything it signed at once. A signature by a key that is not in the root is refused, never stored.
 *
 * Whether a signature is needed: `require` (owner setting, `release.trust.require`); unset it follows the root: once the owner has trusted at least one key, staging, activating and rolling back need a valid signature
 * from a trusted key. With no key and no setting the installation works on digests alone, as before (the manifest is then unsigned, see the trust model in `activation.ts`). The private key never reaches the controller.
 * This module never reads a file, a network or a secret: keys and signatures arrive as arguments.
 */
export const SIGNING = { prefix: "nimblenewt-release-v1\n", maxKeys: 20, label: 80, signatureBytes: 64 } as const;
const TRUST: AggregateRef = { kind: "release-trust", id: "main" };
const SIGNATURE = "release-signature";
const CANDIDATE_ID = /^rcn-[0-9a-f]{24}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface TrustedKey { readonly keyId: string; readonly publicKey: string; readonly label: string; readonly addedBy: string; readonly addedAt: string }
export interface TrustBody { readonly keys: readonly TrustedKey[]; readonly require?: boolean; readonly updatedBy: string; readonly updatedAt: string }
export interface SignatureBody { readonly candidateId: string; readonly keyId: string; readonly signature: string; readonly by: string; readonly at: string }
export type SignatureCheck = { readonly ok: true; readonly keyId: string } | { readonly ok: false; readonly reason: string };

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const known = (command: object, fields: readonly string[]): void => { const u = Object.keys(command).filter((k) => !fields.includes(k)); if (u.length > 0) bad(u[0]!, "is not a field of this command"); };
const sha = (v: string | Uint8Array): string => createHash("sha256").update(v).digest("hex");

/** The text a signature covers: the candidate ID and the full digest of its manifest (`manifestDigestOf`). */
export const signedText = (candidateId: string, manifestDigest: string): Buffer => Buffer.from(`${SIGNING.prefix}${candidateId}\n${manifestDigest}\n`, "utf8");

/**
 * The text a signature over a STAGED release covers when the separate updater installs it (no database, so no candidate record to check): `nimblenewt-release-digest-v1`, a line break, the staged manifest's digest and a line break.
 * The digest names every file of the release (and its candidate ID), so the signature covers exactly the files the updater installs. A different prefix from `signedText`, so neither signature can stand for the other.
 */
export const signedDigestText = (digest: string): Buffer => Buffer.from(`nimblenewt-release-digest-v1\n${digest}\n`, "utf8");
/** Whether any of the base64 keys made `signature` over the digest. Returns the key's ID, or undefined. Throws nothing for a damaged key: it simply does not match. */
export function checkDigestSignature(keys: readonly string[], digest: string, signature: string): string | undefined {
  if (!B64.test(signature) || signature.length > 100) return undefined;
  const raw = Buffer.from(signature, "base64");
  if (raw.length !== SIGNING.signatureBytes) return undefined;
  for (const k of keys) {
    try { const p = parsePublicKey(k); if (verify(null, signedDigestText(digest), p.key, raw)) return p.keyId; } catch { /* not a usable key */ }
  }
  return undefined;
}

/** Reads a base64 DER SubjectPublicKeyInfo holding an Ed25519 key; returns the key and its canonical form and ID. */
export function parsePublicKey(text: unknown): { key: KeyObject; publicKey: string; keyId: string } {
  if (typeof text !== "string" || text.length > 200 || !B64.test(text)) return bad("publicKey", "must be the base64 of an Ed25519 public key in DER (SubjectPublicKeyInfo) form");
  let key: KeyObject;
  try { key = createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" }); } catch { return bad("publicKey", "is not a public key"); }
  if (key.asymmetricKeyType !== "ed25519") return bad("publicKey", "must be an Ed25519 key");
  const der = key.export({ format: "der", type: "spki" });
  return { key, publicKey: Buffer.from(der).toString("base64"), keyId: sha(der).slice(0, 16) };
}
/** Whether `signature` (base64, 64 bytes) is the key's signature over the candidate's signed text. */
export function checkSignature(key: KeyObject, candidateId: string, manifestDigest: string, signature: string): boolean {
  if (!B64.test(signature) || signature.length > 100) return false;
  const raw = Buffer.from(signature, "base64");
  if (raw.length !== SIGNING.signatureBytes) return false;
  try { return verify(null, signedText(candidateId, manifestDigest), key, raw); } catch { return false; }
}

/** Authority is checked by the caller (`ReleaseActivationService`): the owner for the trust root and its setting, the owner or a holder of `release.manage` for attaching a signature. */
export class ReleaseTrust {
  readonly #runner: CommandRunner;
  constructor(runner: CommandRunner) { this.#runner = runner; }

  async #body(): Promise<{ revision: number; body?: TrustBody }> {
    const found = await this.#runner.get(TRUST.kind, TRUST.id);
    return { revision: found?.revision ?? 0, ...(found === undefined ? {} : { body: found.body as unknown as TrustBody }) };
  }
  async list(): Promise<{ revision: number; keys: readonly TrustedKey[]; require: boolean | null; required: boolean }> {
    const { revision, body } = await this.#body();
    const keys = body?.keys ?? [];
    return { revision, keys, require: body?.require ?? null, required: body?.require ?? keys.length > 0 };
  }
  async required(): Promise<boolean> { return (await this.list()).required; }
  /** The full manifest digest of the candidate, read from its record; undefined when there is no record or it does not hash to its ID (a damaged record is never signed). */
  async #manifestDigest(candidateId: string): Promise<string | undefined> {
    if (!CANDIDATE_ID.test(candidateId)) return undefined;
    const m = ((await this.#runner.get(RELEASE_KINDS.candidate, candidateId))?.body as unknown as CandidateBody | undefined)?.manifest;
    if (m === undefined) return undefined;
    try { return candidateIdOf(m) === candidateId ? manifestDigestOf(m) : undefined; } catch { return undefined; }
  }
  /** The full digest a publisher signs for this candidate (shown by release.verify), or undefined. */
  manifestDigest(candidateId: string): Promise<string | undefined> { return this.#manifestDigest(candidateId); }

  async #write(by: Principal, op: string, commandId: string | undefined, expectedRevision: number | undefined, payload: JsonObject, next: (b: TrustBody | undefined) => TrustBody, detail: JsonObject): Promise<{ revision: number }> {
    const r = await this.#runner.command(op, { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { ...payload, expectedRevision: expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(TRUST.kind, TRUST.id);
        if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) throw new DomainError("stale_revision", `the trust root is at revision ${current?.revision ?? 0}, not ${expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const body = next(current?.body as unknown as TrustBody | undefined);
        const change = current === undefined ? { type: "create" as const, ref: TRUST, body: body as unknown as JsonObject } : { type: "update" as const, ref: TRUST, expectedRevision: current.revision, body: body as unknown as JsonObject };
        return { ref: TRUST, creates: current === undefined, changes: [change], detail };
      },
    }));
    return { revision: r.revision };
  }

  async add(by: Principal, command: NoActor & { publicKey: unknown; label?: unknown; expectedRevision?: number }, now: string): Promise<{ revision: number; keyId: string }> {
    known(command, ["commandId", "publicKey", "label", "expectedRevision"]);
    const k = parsePublicKey(command.publicKey);
    const label = command.label === undefined ? "" : typeof command.label === "string" && command.label.length <= SIGNING.label && !/[\u0000-\u001f\u007f]/.test(command.label) ? command.label : bad("label", `must be plain text of at most ${SIGNING.label} characters`);
    const r = await this.#write(by, "release.trust.add", command.commandId, command.expectedRevision, { keyId: k.keyId }, (b) => {
      const keys = b?.keys ?? [];
      if (keys.some((x) => x.keyId === k.keyId)) throw new DomainError("invalid_transition", "that key is already trusted");
      if (keys.length >= SIGNING.maxKeys) throw new DomainError("invalid_transition", `${SIGNING.maxKeys} keys are already trusted; remove one first`);
      return { keys: [...keys, { keyId: k.keyId, publicKey: k.publicKey, label, addedBy: by.id, addedAt: now }], ...(b?.require === undefined ? {} : { require: b.require }), updatedBy: by.id, updatedAt: now };
    }, { keyId: k.keyId });
    return { ...r, keyId: k.keyId };
  }

  async remove(by: Principal, command: NoActor & { keyId: unknown; expectedRevision?: number }, now: string): Promise<{ revision: number; keyId: string }> {
    known(command, ["commandId", "keyId", "expectedRevision"]);
    const keyId = typeof command.keyId === "string" && /^[0-9a-f]{16}$/.test(command.keyId) ? command.keyId : bad("keyId", "must be a key ID from release.trust.list (16 hexadecimal characters)");
    const r = await this.#write(by, "release.trust.remove", command.commandId, command.expectedRevision, { keyId }, (b) => {
      const keys = b?.keys ?? [];
      if (!keys.some((x) => x.keyId === keyId)) throw new DomainError("not_found", "that key is not trusted");
      return { keys: keys.filter((x) => x.keyId !== keyId), ...(b?.require === undefined ? {} : { require: b.require }), updatedBy: by.id, updatedAt: now };
    }, { keyId });
    return { ...r, keyId };
  }

  /** `true` always needs a signature, `false` never does (the owner's explicit word that digests are enough), `null` follows the trust root. */
  async setRequired(by: Principal, command: NoActor & { required: unknown; expectedRevision?: number }, now: string): Promise<{ revision: number }> {
    known(command, ["commandId", "required", "expectedRevision"]);
    if (command.required !== null && typeof command.required !== "boolean") bad("required", "must be true, false or null (follow the trust root)");
    const req = command.required as boolean | null;
    return this.#write(by, "release.trust.require", command.commandId, command.expectedRevision, { required: req }, (b) => ({ keys: b?.keys ?? [], ...(req === null ? {} : { require: req }), updatedBy: by.id, updatedAt: now }), { required: req });
  }

  /** Verifies the signature against the trust root and keeps it. The same signature again is a no-op. */
  async attach(by: Principal, command: NoActor & { candidateId: string; signature: unknown }, now: string): Promise<{ keyId: string; replayed: boolean }> {
    known(command, ["commandId", "candidateId", "signature"]);
    const id = command.candidateId;
    if (typeof command.signature !== "string") bad("signature", "must be the base64 of an Ed25519 signature");
    const sig = command.signature as string;
    const digest = await this.#manifestDigest(id);
    if (digest === undefined) throw new DomainError("not_found", "no such release candidate");
    const { body } = await this.#body();
    let match: TrustedKey | undefined;
    for (const k of body?.keys ?? []) if (checkSignature(parsePublicKey(k.publicKey).key, id, digest, sig)) { match = k; break; }
    if (match === undefined) throw new DomainError("invalid_command", "signature: is not a valid signature of this candidate by a trusted key", { field: "signature" });
    const ref: AggregateRef = { kind: SIGNATURE, id: `sig-${sha(`${id}|${match.keyId}`).slice(0, 24)}` };
    const keyId = match.keyId;
    const done = await this.#runner.command("release.signature.attach", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { candidateId: id, keyId },
      build: async () => {
        const existing = await this.#runner.get(ref.kind, ref.id);
        if (existing !== undefined) return { ref, creates: false, changes: [{ type: "check" as const, ref, expectedRevision: existing.revision }], detail: { candidateId: id, keyId, existing: true } };
        const b: SignatureBody = { candidateId: id, keyId, signature: sig, by: by.id, at: now };
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: b as unknown as JsonObject }], detail: { candidateId: id, keyId } };
      },
    }));
    return { keyId, replayed: done.replayed };
  }

  /** Whether a trusted key's signature over this candidate is on record and still verifies. Read afresh each time, so a removed key or a changed record counts at once. */
  async check(candidateId: string): Promise<SignatureCheck> {
    const r = await this.#find(candidateId);
    return r.ok ? { ok: true, keyId: r.keyId } : r;
  }
  async #find(candidateId: string): Promise<{ ok: true; keyId: string; revision: number } | { ok: false; reason: string }> {
    const { body } = await this.#body();
    if ((body?.keys ?? []).length === 0) return { ok: false, reason: "no signing key is trusted (release.trust.add)" };
    if (!CANDIDATE_ID.test(candidateId)) return { ok: false, reason: "not a candidate ID" };
    const digest = await this.#manifestDigest(candidateId);
    if (digest === undefined) return { ok: false, reason: "the candidate's record is missing or does not match its ID, so no signature over it can be checked" };
    for (const k of body!.keys) {
      const rec = await this.#runner.get(SIGNATURE, `sig-${sha(`${candidateId}|${k.keyId}`).slice(0, 24)}`);
      const s = rec?.body as unknown as SignatureBody | undefined;
      let good = false;
      try { good = s !== undefined && s.candidateId === candidateId && s.keyId === k.keyId && typeof s.signature === "string" && checkSignature(parsePublicKey(k.publicKey).key, candidateId, digest, s.signature); } catch { good = false; }
      if (good) return { ok: true, keyId: k.keyId, revision: rec!.revision };
    }
    return { ok: false, reason: "the release has no valid signature from a trusted key (release.signature.attach)" };
  }

  /**
   * For the commit point of a switch (activation, rollback): decides again whether a signature is needed and present, and returns revision checks of the trust root and of the signature record that decided it,
   * to be committed in the same operation as the switch's journal. A key removed (or the setting changed) after the checks before the switch but before its commit then makes the commit fail instead of
   * switching to a release that no longer counts as signed. Throws `invalid_transition` when a needed signature is missing. (With no trust root at all there is nothing to pin; a first key added at that very
   * moment is not raced against.)
   */
  async guard(candidateId: string): Promise<Change[]> {
    const root = await this.#runner.get(TRUST.kind, TRUST.id);
    if (root === undefined) return [];
    const pin: Change = { type: "check", ref: TRUST, expectedRevision: root.revision };
    const body = root.body as unknown as TrustBody;
    const required = body.require ?? (body.keys ?? []).length > 0;
    if (!required) return [pin];
    const r = await this.#find(candidateId);
    if (!r.ok) throw new DomainError("invalid_transition", `the release is not signed as this installation requires: ${r.reason}`);
    return [pin, { type: "check", ref: { kind: SIGNATURE, id: `sig-${sha(`${candidateId}|${r.keyId}`).slice(0, 24)}` }, expectedRevision: r.revision }];
  }
}
