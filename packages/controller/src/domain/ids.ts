import { createHash } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Lower-case base32 of the first `chars * 5` bits of the digest. */
function base32(bytes: Uint8Array, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  return out;
}

/**
 * The stable identity of a record created by a command. It is derived from the command ID, so a repeated command (a retry after a lost
 * answer, a duplicate delivery) names the same record instead of creating a second one, and no one chooses or guesses identities.
 * 100 bits: collisions are not a practical concern, and one would be reported as a command conflict, never as a merge.
 */
export function derivedId(prefix: "proj" | "task" | "art", commandId: string): string {
  return `${prefix}-${base32(createHash("sha256").update(`${prefix}\0${commandId}`).digest(), 20)}`;
}

/** The storage operation ID of a command. One command ID is one operation, whatever the command. */
export const operationIdOf = (commandId: string): string => `cmd:${commandId}`;
