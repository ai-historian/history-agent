import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceInfo {
  id: string;
  name: string;
  path: string;
}

/** Convert a relative path to a URL-safe slug. */
export function toSlug(rel: string): string {
  return rel.replace(/[\\/]/g, "--").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Recursively discover source directories (those containing a `png/` subdir).
 */
export function discoverSources(rootDir: string): SourceInfo[] {
  const sources: SourceInfo[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const pngDir = join(dir, "png");
    if (existsSync(pngDir) && statSync(pngDir).isDirectory()) {
      const rel = relative(rootDir, dir);
      sources.push({
        id: toSlug(rel),
        name: rel,
        path: dir,
      });
      return; // don't recurse into source dirs
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory() && !entry.startsWith(".")) {
          walk(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  walk(rootDir);
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}
