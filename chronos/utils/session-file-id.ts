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
 * Reads only the first line, not the whole file, since a session transcript
 * can be large. Returns undefined for a missing/unreadable/malformed file, or
 * one whose first line isn't a session header with a string id.
 */
import { readFileSync } from "node:fs";

export function sessionIdFromFile(sessionFilePath: string): string | undefined {
  try {
    const contents = readFileSync(sessionFilePath, "utf-8");
    const newlineIndex = contents.indexOf("\n");
    const firstLine = newlineIndex === -1 ? contents : contents.slice(0, newlineIndex);
    const header = JSON.parse(firstLine);
    return header && header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  }
}
