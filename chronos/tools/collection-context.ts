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
  /** Collection name (null = the auto-formed "all sources" collection). */
  name: string | null;
  /** Free-text description (from a manifest); null for the auto-collection. */
  description: string | null;
  /** The catalog, keyed by member ref. */
  members: Map<string, CollectionMember>;
}

export function createCollectionContext(workspaceDir = "", name: string | null = null): CollectionContext {
  return { workspaceDir, name, description: null, members: new Map() };
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

/** Stable key for the active collection ("all-sources" for the auto-collection). */
export function collectionKey(ctx: CollectionContext): string {
  return ctx.name ? toSlug(ctx.name) : "all-sources";
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

// Lenient fallback so the agent can pass the human-obvious name. Mirrors the
// /select-source match (exact ref → basename → workspace-relative path).
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
 */
export function buildCollectionFromDiscovery(ctx: CollectionContext, workspaceDir: string): void {
  ctx.workspaceDir = workspaceDir;
  ctx.name = null;
  ctx.description = null;
  ctx.members.clear();
  for (const s of discoverSources(join(workspaceDir, "sources"))) {
    ctx.members.set(s.name, {
      ref: s.name,
      path: s.path,
      dataDir: join(workspaceDir, "data", dataKeyForRef(s.name, s.path)),
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
