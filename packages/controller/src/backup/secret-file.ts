import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** A secret file that cannot be used. The message is fixed text about the file's kind, never its content or a parser's words. */
export class SecretFileRefused extends Error { constructor(message: string) { super(message); this.name = "SecretFileRefused"; } }

/**
 * Reads a small secret file written for the owner alone (card K01b). The path is looked at first without opening it (`lstat`: a link, a pipe or a device is refused before anything is opened, so a named pipe cannot block the
 * reader and a link cannot point it at another file), then opened without following links and without blocking, then the opened file is checked again to be the same regular file before a byte is read. It must be a regular file,
 * not readable by group or others, at most `maxBytes`. The content is never put in an error.
 */
export async function readSecretFile(path: string, maxBytes = 4096): Promise<string> {
  let before;
  try { before = await lstat(path); } catch { throw new SecretFileRefused("the file cannot be read"); }
  if (!before.isFile()) throw new SecretFileRefused("the file is not a regular file");
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { throw new SecretFileRefused("the file cannot be read"); }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) throw new SecretFileRefused("the file is not a regular file");
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new SecretFileRefused("the file can be read by others: set its mode to 600");
    if (st.size > maxBytes) throw new SecretFileRefused("the file is too large");
    const buffer = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new SecretFileRefused("the file is too large");
    return buffer.subarray(0, bytesRead).toString("utf8").replace(/\r?\n$/, "");
  } catch (error) {
    if (error instanceof SecretFileRefused) throw error;
    throw new SecretFileRefused("the file cannot be read");
  } finally { await handle.close().catch(() => undefined); }
}
