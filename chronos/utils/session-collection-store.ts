/**
 * Per-session collection selection persistence.
 *
 * Which named collection a session is working over lives in the in-memory
 * CollectionContext. A fresh agent process (or a resumed session) auto-forms the
 * "all sources" collection; if the user narrowed to a named collection we persist
 * that name here, keyed by pi session id, and re-narrow to it on session start.
 *
 * Absence of an entry means the auto-collection ("all sources") — selecting it
 * explicitly clears the entry. Like the other sidecars this is OUT-OF-BAND: it
 * adds nothing to the conversation history.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface Selection {
  name: string;
}

function storePath(workspaceDir: string): string {
  return join(workspaceDir, ".chronos", "session-collections.json");
}

function readStore(workspaceDir: string): Record<string, Selection> {
  try {
    const parsed = JSON.parse(readFileSync(storePath(workspaceDir), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(workspaceDir: string, store: Record<string, Selection>): void {
  const path = storePath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/**
 * Record the named collection selected in this session. Pass `null` to record
 * the auto-collection ("all sources"), which removes any stored name.
 */
export function saveSessionCollection(workspaceDir: string, sessionId: string, name: string | null): void {
  if (!sessionId) return;
  const store = readStore(workspaceDir);
  if (name === null) {
    if (!(sessionId in store)) return;
    delete store[sessionId];
  } else {
    if (store[sessionId]?.name === name) return;
    store[sessionId] = { name };
  }
  writeStore(workspaceDir, store);
}

/** The named collection selected in this session, if any (undefined = auto-collection). */
export function loadSessionCollection(workspaceDir: string, sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const entry = readStore(workspaceDir)[sessionId];
  return entry && typeof entry.name === "string" ? entry.name : undefined;
}
