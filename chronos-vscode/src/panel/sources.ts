import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceInfo {
  name: string;
  path: string;
}

export interface CollectionInfo {
  name: string;
  description?: string;
  memberCount: number;
}

/** Named collections declared in collections/<name>.json (mirrors the agent's
 *  listCollections). The picker lists these plus a synthetic "all sources". */
export function discoverCollections(workspaceDir: string): CollectionInfo[] {
  const dir = join(workspaceDir, "collections");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CollectionInfo[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      out.push({
        name: typeof m.name === "string" ? m.name : f.replace(/\.json$/, ""),
        description: typeof m.description === "string" ? m.description : undefined,
        memberCount: Array.isArray(m.members) ? m.members.length : 0,
      });
    } catch {
      // skip unparseable manifest
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function countPages(sourceDir: string): number {
  const pngDir = join(sourceDir, "png");
  try {
    return readdirSync(pngDir).filter(
      (f) => f.startsWith("page_") && /\.(png|jpg|jpeg)$/i.test(f)
    ).length;
  } catch {
    return 0;
  }
}

export function discoverSources(rootDir: string): SourceInfo[] {
  const sources: SourceInfo[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    if (existsSync(join(dir, "png")) && statSync(join(dir, "png")).isDirectory()) {
      sources.push({ name: relative(rootDir, dir), path: dir });
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory() && !entry.startsWith(".")) {
          walk(full);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  walk(rootDir);
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}
