import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = join(__dirname, "..", "..", "data");



/** Recursively copy src → dst, skipping files that already exist at dst. */
function copyMissing(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyMissing(srcPath, dstPath);
    } else if (!existsSync(dstPath)) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/** Write a file only if it doesn't already exist. */
function writeIfMissing(filePath: string, content: string) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content, "utf-8");
  }
}

/**
 * Ensure the workspace has the required structure.
 * If it doesn't exist or is missing folders/files, scaffold from the default workspace.
 * Memory files are created from built-in defaults if neither the default workspace
 * nor the target workspace has them. Existing files are never overwritten.
 */
export function ensureWorkspace(workspaceDir: string) {
  const isNew = !existsSync(workspaceDir) || readdirSync(workspaceDir).length === 0;

  mkdirSync(join(workspaceDir, "sources"), { recursive: true });
  mkdirSync(join(workspaceDir, "skills"), { recursive: true });
  // collections/ holds optional <name>.json manifests (named source sets)
  mkdirSync(join(workspaceDir, "collections"), { recursive: true });

  // .chronos/ holds the API key (.env)
  const chronosDir = join(workspaceDir, ".chronos");
  mkdirSync(chronosDir, { recursive: true });

  // memory/ holds workspace-level MEMORY.MD, per-source <ref>.md, and
  // collections/<key>.md (cross-source, long-horizon findings).
  const memoryDst = join(workspaceDir, "memory");
  mkdirSync(memoryDst, { recursive: true });
  mkdirSync(join(memoryDst, "collections"), { recursive: true });
  writeIfMissing(join(memoryDst, "MEMORY.MD"), "");

  if (isNew) {
    console.log(`Workspace initialized at: ${workspaceDir}`);
  }
}
