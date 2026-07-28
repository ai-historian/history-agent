/**
 * Fallback derivation of a source's `data/<key>/` directory name, for use only
 * when the agent hasn't yet told the host what key it's using for a given
 * source directory this session (a cold `dataKeyBySourceDir` cache entry — see
 * `ChronosPanel.dataKeyForSourceDir` in `chronos-panel.ts`).
 *
 * This deliberately mirrors — line for line — the agent's own derivation:
 *   - `toSlug` in `chronos/utils/source-discovery.ts`
 *   - `deriveRef` and `dataKeyForRef` in `chronos/tools/collection-context.ts`
 *
 * `chronos-vscode` cannot import those modules directly (this package's
 * `tsconfig.json` sets `rootDir: "src"`, and the two packages are built and
 * published independently — see CLAUDE.md), so the trivial slug transform is
 * duplicated across the package boundary on purpose. If the agent's logic in
 * the files above ever changes, update this file to match — that drift is
 * exactly what `test/data-key-equivalence-test.mjs` checks for.
 *
 * Kept dependency-free (no `vscode` import) so it can be compiled and run
 * standalone by that test.
 */
import { basename, isAbsolute, join, relative } from "node:path";

/** Mirrors chronos/utils/source-discovery.ts's toSlug. */
export function toSlug(rel: string): string {
  return rel.replace(/[\\/]/g, "--").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Mirrors chronos/tools/collection-context.ts's deriveRef. */
export function deriveRef(workspaceDir: string, sourcePath: string): string {
  const rel = relative(join(workspaceDir, "sources"), sourcePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : basename(sourcePath);
}

/** Mirrors chronos/tools/collection-context.ts's dataKeyForRef. */
export function dataKeyForRef(ref: string, sourcePath: string): string {
  return ref.includes("/") ? toSlug(ref) : basename(sourcePath);
}

/** The full derivation the agent uses for a source's data dir name, applied to
 *  a bare source directory (no pre-computed ref available on the host side). */
export function deriveDataKeyFallback(workspaceDir: string, sourceDir: string): string {
  return dataKeyForRef(deriveRef(workspaceDir, sourceDir), sourceDir);
}
