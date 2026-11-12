import { parentPort, workerData } from "node:worker_threads";
import { argon2idSync, type Argon2Params } from "./argon2.js";

const d = workerData as { password: Uint8Array; salt: Uint8Array; params: Argon2Params; tagLength: number };
try { parentPort!.postMessage({ ok: true, tag: argon2idSync(d.password, d.salt, d.params, d.tagLength) }); } catch { parentPort!.postMessage({ ok: false }); }
