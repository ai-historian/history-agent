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
  /** The named collection, absent for the auto "all sources" collection. */
  name?: string;
  /** Absolute source dirs added this session via change_source. */
  extraMembers?: string[];
}

/** True when an entry carries nothing worth keeping. */
function isEmptySelection(s: Selection | undefined): boolean {
  return !s || (s.name === undefined && (s.extraMembers === undefined || s.extraMembers.length === 0));
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
  const entry: Selection = store[sessionId] ?? {};
  if (name === null) {
    // Auto-collection. Clear only the name — extraMembers added via
    // change_source must survive, or selecting "All sources" would silently
    // drop every out-of-tree source the user added this session.
    if (entry.name === undefined) return;
    delete entry.name;
  } else {
    if (entry.name === name) return;
    entry.name = name;
  }
  if (isEmptySelection(entry)) delete store[sessionId];
  else store[sessionId] = entry;
  writeStore(workspaceDir, store);
}

/** The named collection selected in this session, if any (undefined = auto-collection). */
export function loadSessionCollection(workspaceDir: string, sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const entry = readStore(workspaceDir)[sessionId];
  return entry && typeof entry.name === "string" ? entry.name : undefined;
}

/**
 * Remember an out-of-tree source added this session via change_source.
 * buildCollectionFromDiscovery repopulates from sources/ on every session_start
 * (startup, switch, resume, fork), so without this the addition is lost and the
 * refs the agent was told to use start throwing mid-conversation.
 */
export function saveSessionExtraMember(workspaceDir: string, sessionId: string, sourcePath: string): void {
  if (!sessionId || !sourcePath) return;
  const store = readStore(workspaceDir);
  const entry: Selection = store[sessionId] ?? {};
  const existing = entry.extraMembers ?? [];
  if (existing.includes(sourcePath)) return;
  entry.extraMembers = [...existing, sourcePath];
  store[sessionId] = entry;
  writeStore(workspaceDir, store);
}

/** Out-of-tree source dirs added in this session (empty when none). */
export function loadSessionExtraMembers(workspaceDir: string, sessionId: string): string[] {
  if (!sessionId) return [];
  const entry = readStore(workspaceDir)[sessionId];
  const extras = entry?.extraMembers;
  return Array.isArray(extras) ? extras.filter((p): p is string => typeof p === "string") : [];
}
