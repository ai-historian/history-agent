/**
 * Named collections declared in `collections/<name>.json`.
 *
 * A manifest lists member sources (workspace-relative or absolute paths) with
 * optional per-member metadata and an optional collection description. The
 * loader resolves each member into a CollectionMember, skipping any whose png/
 * folder is missing. When no manifest is selected the agent falls back to the
 * auto-collection (every source under sources/, see buildCollectionFromDiscovery).
 *
 * Manifest shape (all fields optional except member.path):
 *   {
 *     "name": "frankfurt-directories",
 *     "description": "City directories 1850–1900",
 *     "members": [
 *       { "ref": "Frankfurt_1864", "path": "sources/Frankfurt_1864", "meta": { "year": 1864 } }
 *     ]
 *   }
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type CollectionContext,
  type CollectionMember,
  createCollectionContext,
  deriveRef,
  dataKeyForRef,
} from "../tools/collection-context.js";

const COLLECTIONS_DIR = "collections";

interface ManifestMember {
  ref?: string;
  path: string;
  meta?: Record<string, unknown>;
}

interface Manifest {
  name?: string;
  description?: string;
  members?: ManifestMember[];
}

export interface CollectionSummary {
  name: string;
  description?: string;
  memberCount: number;
}

function manifestPath(workspaceDir: string, name: string): string {
  return join(workspaceDir, COLLECTIONS_DIR, `${name}.json`);
}

/** Available named collections (collections/*.json), sorted by name. */
export function listCollections(workspaceDir: string): CollectionSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(join(workspaceDir, COLLECTIONS_DIR));
  } catch {
    return [];
  }
  const out: CollectionSummary[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(workspaceDir, COLLECTIONS_DIR, f), "utf-8")) as Manifest;
      out.push({
        name: m.name ?? f.replace(/\.json$/, ""),
        description: m.description,
        memberCount: Array.isArray(m.members) ? m.members.length : 0,
      });
    } catch {
      // skip an unparseable manifest
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a named collection into a fresh context, or null if absent/unparseable/empty. */
export function loadCollection(workspaceDir: string, name: string): CollectionContext | null {
  const p = manifestPath(workspaceDir, name);
  if (!existsSync(p)) return null;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
  const ctx = createCollectionContext(workspaceDir, manifest.name ?? name);
  ctx.description = manifest.description ?? null;
  for (const mm of manifest.members ?? []) {
    if (!mm || typeof mm.path !== "string") continue;
    const abs = isAbsolute(mm.path) ? mm.path : join(workspaceDir, mm.path);
    if (!existsSync(join(abs, "png"))) {
      console.warn(`[chronos] collection "${name}": skipping member with no png/: ${mm.path}`);
      continue;
    }
    const ref = mm.ref ?? deriveRef(workspaceDir, abs);
    const member: CollectionMember = {
      ref,
      path: abs,
      dataDir: join(workspaceDir, "data", dataKeyForRef(ref, abs)),
      meta: mm.meta,
    };
    ctx.members.set(ref, member);
  }
  return ctx.members.size > 0 ? ctx : null;
}

/**
 * Narrow the shared collection context to a named collection, mutating it in
 * place so tools that closed over the object see the change. Returns false
 * (leaving the context untouched) if the manifest is missing/unparseable/empty.
 */
export function loadCollectionInto(ctx: CollectionContext, workspaceDir: string, name: string): boolean {
  const loaded = loadCollection(workspaceDir, name);
  if (!loaded) return false;
  ctx.workspaceDir = workspaceDir;
  ctx.name = loaded.name;
  ctx.description = loaded.description;
  ctx.members.clear();
  for (const [k, v] of loaded.members) ctx.members.set(k, v);
  return true;
}
