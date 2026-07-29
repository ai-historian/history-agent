/**
 * Shared mutable collection context.
 *
 * A *collection* is the active unit of work: a cataloged set of sources. Every
 * source-bound tool takes a required `source` ref and resolves it against this
 * catalog via `resolveSource`. There is no implicit "current source" —
 * "everything is a collection; a single document is a collection of one".
 *
 * The object is created once and shared with every tool factory; its
 * `members`/`workspaceDir` are mutated in place (rebuilt from discovery on each
 * session start) so tools that closed over it always see the live catalog.
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { discoverSources, toSlug } from "../utils/source-discovery.js";
import { loadSessionExtraMembers } from "../utils/session-collection-store.js";

export interface CollectionMember {
  /** Stable handle the agent passes as `source` — the discovery name (workspace-relative path, e.g. "Frankfurt_1864" or "city/Frankfurt_1864"). */
  ref: string;
  /** Absolute source directory (contains png/). */
  path: string;
  /** Per-member output dir: <workspace>/data/<dataKey>/. */
  dataDir: string;
  /** Free-form metadata (year, place, title…). Empty until manifests land (Phase 2). */
  meta?: Record<string, unknown>;
}

export interface CollectionContext {
  workspaceDir: string;
  /** Collection name (null = the auto-formed "all sources" collection). Display-only — see `id`. */
  name: string | null;
  /** The collection's stable identity — the manifest's filename stem (null =
   *  the auto-formed "all sources" collection). Unlike `name`, this never
   *  changes when a manifest is renamed in its own `name` field, so it's what
   *  callers persist and match against — `name` is for display only. */
  id: string | null;
  /** Free-text description (from a manifest); null for the auto-collection. */
  description: string | null;
  /** The catalog, keyed by member ref. */
  members: Map<string, CollectionMember>;
}

export function createCollectionContext(
  workspaceDir = "",
  name: string | null = null,
  id: string | null = null,
): CollectionContext {
  return { workspaceDir, name, id, description: null, members: new Map() };
}

/**
 * Derive a member ref from a source path. For a path under the workspace's
 * `sources/` tree this equals the discovery name (workspace-relative, forward
 * slashes); otherwise the basename. Shared by discovery, change_source, and
 * manifest loading so refs never diverge across call sites.
 */
export function deriveRef(workspaceDir: string, sourcePath: string): string {
  const rel = relative(join(workspaceDir, "sources"), sourcePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : basename(sourcePath);
}

/**
 * The `data/<key>/` subfolder for a source. Flat sources keep the basename
 * verbatim (backward compat with existing `data/<name>/` dirs, whose names may
 * contain spaces/dots); nested refs are slugged so they stay unique.
 */
export function dataKeyForRef(ref: string, sourcePath: string): string {
  return ref.includes("/") ? toSlug(ref) : basename(sourcePath);
}

/**
 * Stable key for the active collection ("all-sources" for the auto-collection).
 * Keyed on `id` (the manifest's filename stem), not `name` — `name` is
 * display-only and can change when a historian edits the manifest's `"name"`
 * field without renaming the file. `id` is already a filesystem-safe path
 * component (it's derived from an actual filename on disk via
 * `listCollections`/`loadCollection`, never user free text), so it needs no
 * `toSlug` pass — unlike `name`, which could contain spaces/slashes/etc.
 */
export function collectionKey(ctx: CollectionContext): string {
  return ctx.id ?? "all-sources";
}

/** Collection-level output dir (entity index, cross-source summaries). Kept out
 *  of the per-source `data/<source>/` namespace under `data/_collections/`. */
export function collectionDataDir(ctx: CollectionContext): string {
  return join(ctx.workspaceDir, "data", "_collections", collectionKey(ctx));
}

/** Always-on collection memory file: cross-source, long-horizon findings. */
export function collectionMemoryPath(ctx: CollectionContext): string {
  return join(ctx.workspaceDir, "memory", "collections", `${collectionKey(ctx)}.md`);
}

// Bound the ref list embedded in error messages so a 500-source collection
// doesn't produce a multi-KB error string.
const REF_LIST_CAP = 40;

/** Sorted, capped list of valid refs for error/guidance messages. */
export function refList(ctx: CollectionContext): string {
  const refs = [...ctx.members.keys()].sort((a, b) => a.localeCompare(b));
  if (refs.length === 0) return "(none — add a directory containing a png/ subfolder under sources/)";
  if (refs.length <= REF_LIST_CAP) return refs.join(", ");
  return refs.slice(0, REF_LIST_CAP).join(", ") + `, …and ${refs.length - REF_LIST_CAP} more`;
}

// Lenient fallback so the agent can pass the human-obvious name. Mirrors
// /select-source's precedence (exact ref, checked by the caller via
// ctx.members.get, then basename, then workspace-relative path) — but NOT its
// handling of an ambiguous basename: /select-source silently takes whichever
// sorted member matches first, while this throws.
//
// A bare basename shared by two members is AMBIGUOUS and must not be guessed:
// nested sources keep distinct refs but can share a basename, and silently
// picking one writes the extraction into the wrong source's data dir. Mirrors
// resolveExpertModel, which errors on an ambiguous bare model id.
function resolveByAlias(ctx: CollectionContext, ref: string): CollectionMember | undefined {
  const byBasename = [...ctx.members.values()].filter((m) => basename(m.path) === ref);
  if (byBasename.length > 1) {
    const refs = byBasename.map((m) => m.ref).sort().join(", ");
    throw new Error(
      `Source "${ref}" is ambiguous — it matches ${byBasename.length} members: ${refs}. ` +
        `Pass the full ref instead.`,
    );
  }
  if (byBasename.length === 1) return byBasename[0];

  const norm = ref.replace(/\\/g, "/").replace(/^\.?\/?sources\//, "").replace(/\/+$/, "");
  for (const m of ctx.members.values()) {
    if (m.ref === norm) return m;
  }
  return undefined;
}

/**
 * Resolve a `source` ref to its catalog member, or throw a clear error listing
 * the valid refs. Replaces the old `requireSource(ctx)` — same "throw with
 * guidance" ergonomic, now per-call and collection-aware.
 */
export function resolveSource(ctx: CollectionContext, ref: string | undefined): CollectionMember {
  if (!ref) {
    throw new Error(`A 'source' ref is required (which collection member to act on). Valid refs: ${refList(ctx)}`);
  }
  const m = ctx.members.get(ref) ?? resolveByAlias(ctx, ref);
  if (!m) {
    throw new Error(`Unknown source "${ref}". Valid refs: ${refList(ctx)}`);
  }
  return m;
}

/** The output data dir for a resolved source. Callers mkdir it lazily as today. */
export function requireSourceDataDir(ctx: CollectionContext, ref: string | undefined): string {
  return resolveSource(ctx, ref).dataDir;
}

/**
 * (Re)populate the collection from the workspace `sources/` tree. Every workspace
 * auto-forms a collection of all its discovered sources — a single-source
 * workspace is a collection of one, which is the backward-compat path. Cheap
 * filesystem walk; called on every session start.
 *
 * dataKey is derived via `dataKeyForRef`: flat sources (no "/" in ref) keep the
 * bare `basename(path)`, so existing `data/<name>/` output dirs keep resolving;
 * nested refs are slugged via `toSlug` so two sources with the same basename
 * under different parents still get distinct data dirs.
 *
 * The ref is derived via `deriveRef(workspaceDir, s.path)` rather than using
 * `discoverSources`'s `s.name` verbatim. `s.name` is `relative(rootDir, dir)` —
 * platform-native, so `city\Nested_1900` on win32 — and `dataKeyForRef` only
 * recognizes the slugged-nested case via a forward slash. Using the bare name
 * there would make `dataKeyForRef` silently fall through to `basename(path)`
 * on win32, so two differently-nested sources sharing a basename would collide
 * on the same `data/` dir. `deriveRef` recomputes the same relative path but
 * always normalizes `\` to `/` before returning, so it's the single place this
 * normalization lives — every other ref-deriving call site (`replayExtraMembers`,
 * `change_source`, manifest loading) already goes through it; routing discovery
 * through it too means all four call sites can never disagree on what a given
 * source's ref is, on any platform.
 */
export function buildCollectionFromDiscovery(ctx: CollectionContext, workspaceDir: string): void {
  ctx.workspaceDir = workspaceDir;
  ctx.name = null;
  ctx.id = null;
  ctx.description = null;
  ctx.members.clear();
  for (const s of discoverSources(join(workspaceDir, "sources"))) {
    const ref = deriveRef(workspaceDir, s.path);
    ctx.members.set(ref, {
      ref,
      path: s.path,
      dataDir: join(workspaceDir, "data", dataKeyForRef(ref, s.path)),
    });
  }
}

/**
 * Re-add out-of-tree sources added via change_source this session. Both
 * buildCollectionFromDiscovery and loadCollectionInto rebuild/clear `ctx.members`
 * from scratch, which would otherwise silently drop these: on session_start
 * (startup/switch/resume/fork) AND on /select-collection (either branch — "all
 * sources" via discovery, or a named collection via the manifest loader). Skips
 * a path whose png/ dir is gone, and a ref already present in the catalog.
 */
export function replayExtraMembers(ctx: CollectionContext, workspaceDir: string, sessionId: string): void {
  for (const sourcePath of loadSessionExtraMembers(workspaceDir, sessionId)) {
    if (!existsSync(join(sourcePath, "png"))) {
      console.warn(`[chronos] added source no longer has png/, skipping: ${sourcePath}`);
      continue;
    }
    const ref = deriveRef(workspaceDir, sourcePath);
    if (ctx.members.has(ref)) continue;
    ctx.members.set(ref, {
      ref,
      path: sourcePath,
      dataDir: join(workspaceDir, "data", dataKeyForRef(ref, sourcePath)),
    });
  }
}
