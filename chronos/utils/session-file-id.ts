/**
 * Extract the session id from a pi session `.jsonl` file's header (its first
 * line), given only the file PATH.
 *
 * `session_start`'s `previousSessionFile` (fired with `reason: "fork"`) is a
 * file path, not a session id — pi's fork implementation
 * (SessionManager.forkFrom/createBranchedSession) mints a brand-new session
 * id and file for the fork, and reports the file the fork was taken FROM.
 * To carry that previous session's out-of-band sidecars (collection
 * selection, change_source extraMembers — see session-collection-store.ts)
 * forward to the new session id, we need the OLD session's id, which only
 * lives in that file's header.
 *
 * Reads a bounded prefix, NOT the whole file. A session transcript grows without
 * bound (pi appends every turn), and `readFileSync(path, "utf-8")` on one past
 * Node's MAX_STRING_LENGTH (512 MiB) THROWS — which the catch below would
 * swallow, silently returning undefined and losing all carried state on exactly
 * the longest-running sessions this exists to protect. Slicing at the first
 * newline BYTE is safe for UTF-8: 0x0A cannot occur inside a multi-byte
 * sequence, so the prefix never splits a character.
 *
 * Returns undefined for a missing/unreadable/malformed file, or one whose first
 * line isn't a session header with a string id, or whose header exceeds
 * HEADER_LIMIT.
 */
import { closeSync, openSync, readSync } from "node:fs";

/** Generous for a header of {type, version, id, timestamp, cwd, parentSession}. */
const HEADER_LIMIT = 64 * 1024;

/**
 * Whether a `session_start` event is a fork we must carry sidecar state from,
 * and if so which file to read the previous session's id out of.
 *
 * Pure, and exported, so the guard itself is testable: it used to live inline in
 * the pi entrypoint's hook, where neutering it left every canary green.
 */
export function forkedPreviousSessionFile(event: {
  reason?: string;
  previousSessionFile?: string;
}): string | undefined {
  return event.reason === "fork" && event.previousSessionFile ? event.previousSessionFile : undefined;
}

export function sessionIdFromFile(sessionFilePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(sessionFilePath, "r");
    const buf = Buffer.allocUnsafe(HEADER_LIMIT);
    const bytesRead = readSync(fd, buf, 0, HEADER_LIMIT, 0);
    const newlineIndex = buf.indexOf(0x0a, 0);
    // No newline within the limit: either the whole file is one short line (fine,
    // parse what we read) or the header is implausibly long (parse fails below).
    const end = newlineIndex === -1 || newlineIndex > bytesRead ? bytesRead : newlineIndex;
    const header = JSON.parse(buf.toString("utf-8", 0, end));
    return header && header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed / never opened cleanly */
      }
    }
  }
}
