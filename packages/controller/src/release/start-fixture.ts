import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PointerSwitcher, type Switcher } from "./activation.js";

/**
 * Test fixture for the launcher (cards K02e, K02f): fake releases on disk (a MANIFEST.json and one file, so `verifyReleaseDirectory` accepts them) and a clock the test moves. No release is ever run.
 */
export const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");

export function makeRelease(root: string, tag: string): { id: string; digest: string } {
  const id = `rcn-${sha256(`fixture-${tag}`).slice(0, 24)}`;
  const dir = join(root, "releases", id);
  mkdirSync(dir, { recursive: true });
  const body = `release ${tag}`;
  const manifest = JSON.stringify({ candidateId: id, sourceCommit: "a".repeat(40), files: { "nn.js": { sha256: sha256(body), size: Buffer.byteLength(body) } } });
  writeFileSync(join(dir, "nn.js"), body);
  writeFileSync(join(dir, "MANIFEST.json"), manifest);
  return { id, digest: sha256(manifest) };
}

export class Clock {
  #ms: number;
  constructor(start = "2026-11-11T08:00:00.000Z") { this.#ms = Date.parse(start); }
  now = (): string => new Date(this.#ms).toISOString();
  advance(seconds: number): void { this.#ms += seconds * 1000; }
}

export const pointerSwitcher = (root: string): Switcher => new PointerSwitcher(root);
