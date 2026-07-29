/**
 * Per-session collection selection persistence.
 *
 * Which named collection a session is working over lives in the in-memory
 * CollectionContext. A fresh agent process (or a resumed session) auto-forms the
 * "all sources" collection; if the user narrowed to a named collection we persist
 * its `id` here (the stable identity — see collection-context.ts), keyed by pi
 * session id, and re-narrow to it on session start.
 *
 * Absence of an entry means the auto-collection ("all sources") — selecting it
 * explicitly clears the entry. Like the other sidecars this is OUT-OF-BAND: it
 * adds nothing to the conversation history.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface Selection {
  /**
   * The selected collection's `id` (the manifest's filename stem) — NOT its
   * display name, despite the field/JSON key being called `name`. Since Task 6
   * introduced `id` as the stable identity, every writer here persists an id.
   * The key stays `name` on purpose: it is the on-disk JSON key in every
   * existing `.chronos/session-collections.json`, and callers (including the
   * canary's legacy-entry check) read/write bare `{ "name": "<value>" }`
   * objects — renaming the key would silently strand old entries instead of
   * just misnaming them. Absent for the auto "all sources" collection.
   */
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
 * Record the collection id selected in this session. Pass `null` to record
 * the auto-collection ("all sources"), which removes any stored id.
 */
export function saveSessionCollection(workspaceDir: string, sessionId: string, id: string | null): void {
  if (!sessionId) return;
  const store = readStore(workspaceDir);
  const entry: Selection = store[sessionId] ?? {};
  if (id === null) {
    // Auto-collection. Clear only the id — extraMembers added via
    // change_source must survive, or selecting "All sources" would silently
    // drop every out-of-tree source the user added this session.
    if (entry.name === undefined) return;
    delete entry.name;
  } else {
    if (entry.name === id) return;
    entry.name = id;
  }
  if (isEmptySelection(entry)) delete store[sessionId];
  else store[sessionId] = entry;
  writeStore(workspaceDir, store);
}

/** The collection id selected in this session, if any (undefined = auto-collection). */
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
  const existing = Array.isArray(entry.extraMembers) ? entry.extraMembers : [];
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

/**
 * Carry a forked session's collection selection and change_source
 * extraMembers forward to the new session id a fork mints.
 *
 * pi's fork (edit-and-resend in the VS Code panel) creates a brand-new
 * session file with a brand-new id — this store has no entry for that id yet,
 * so without this, every change_source addition and collection narrowing from
 * the forked-from session silently evaporates on edit-and-resend, exactly the
 * failure this store exists to prevent for startup/switch/resume. No-op if
 * the previous session has nothing recorded, or the ids are identical/absent.
 *
 * Copies (rather than only reading through to the previous session on demand)
 * so the new id's entry is self-contained and a later fork-of-this-fork can
 * chain off it the same way.
 */
export function carryForkedSessionState(workspaceDir: string, previousSessionId: string, newSessionId: string): void {
  if (!previousSessionId || !newSessionId || previousSessionId === newSessionId) return;
  const collection = loadSessionCollection(workspaceDir, previousSessionId);
  if (collection !== undefined) saveSessionCollection(workspaceDir, newSessionId, collection);
  for (const sourcePath of loadSessionExtraMembers(workspaceDir, previousSessionId)) {
    saveSessionExtraMember(workspaceDir, newSessionId, sourcePath);
  }
}
