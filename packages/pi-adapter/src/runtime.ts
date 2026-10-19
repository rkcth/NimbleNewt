import { createRequire } from "node:module";
import { UnsupportedRuntimeError } from "./errors.js";

/** The exact Pi Durable release this adapter is written and qualified against. */
export const PINNED_PI_DURABLE_VERSION = "1.3.0";

/** Oldest Node release the adapter supports; matches the root `engines` field. */
export const MINIMUM_NODE_VERSION = "22.19.0";

export interface RuntimeInfo {
  readonly piDurableVersion: string;
  readonly nodeVersion: string;
}

export function detectRuntime(): RuntimeInfo {
  const require = createRequire(import.meta.url);
  const manifest = require("@earendil-works/pi-durable/package.json") as { version: string };
  return { piDurableVersion: manifest.version, nodeVersion: process.versions.node };
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new UnsupportedRuntimeError(`cannot parse version "${version}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Throws UnsupportedRuntimeError unless Pi Durable is exactly the pinned release and Node is new enough. */
export function assertSupportedRuntime(runtime: RuntimeInfo = detectRuntime()): void {
  if (runtime.piDurableVersion !== PINNED_PI_DURABLE_VERSION) {
    throw new UnsupportedRuntimeError(
      `Pi Durable ${runtime.piDurableVersion} is not supported; this adapter is qualified only against ${PINNED_PI_DURABLE_VERSION}`,
    );
  }
  const have = parseVersion(runtime.nodeVersion);
  const need = parseVersion(MINIMUM_NODE_VERSION);
  for (let i = 0; i < 3; i++) {
    if (have[i]! > need[i]!) return;
    if (have[i]! < need[i]!) {
      throw new UnsupportedRuntimeError(`Node ${runtime.nodeVersion} is not supported; Node ${MINIMUM_NODE_VERSION} or newer is required`);
    }
  }
}
