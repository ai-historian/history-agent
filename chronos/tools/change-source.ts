import { existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listPageIds } from "../utils/page-files.js";
import { sendToExtension } from "../http/http-client.js";
import type { CollectionContext } from "./collection-context.js";
import { deriveRef, dataKeyForRef } from "./collection-context.js";
import { saveSessionExtraMember } from "../utils/session-collection-store.js";

const changeSourceParams = Type.Object({
  source_path: Type.String({
    description:
      "Path to a source directory (absolute, or relative to the workspace). Must contain a png/ " +
      "subdirectory. Added to the active collection if not already a member; the result gives the " +
      "ref to pass as `source`. Use this for a source outside the workspace's sources/ tree.",
  }),
});

export function createChangeSourceTool(ctx: CollectionContext, description: string): ToolDefinition<typeof changeSourceParams> {
  return {
    name: "change_source",
    label: "Add Source",
    description,
    parameters: changeSourceParams,
    async execute(_toolCallId, params, _signal, _onUpdate, extCtx: ExtensionContext) {
      const workspaceDir = extCtx.cwd;
      // resolve() so ONE directory has ONE spelling. Two consequences, both real:
      // the collision check below compares this against a stored member path, and a
      // trailing slash would make "/a/S/" look like a different directory from
      // "/a/S" — refusing an add whose "owner" is that very directory. And
      // deriveRef's basename of "/a/S/." is ".", which made ref "." and pointed the
      // source's data dir at the workspace data/ ROOT while reporting success.
      const sourcePath = resolve(isAbsolute(params.source_path) ? params.source_path : join(workspaceDir, params.source_path));

      if (!existsSync(sourcePath)) {
        return {
          content: [{ type: "text", text: `Source path does not exist: ${sourcePath}` }],
          details: {},
        };
      }

      const pngDir = join(sourcePath, "png");
      if (!existsSync(pngDir)) {
        return {
          content: [{ type: "text", text: `Not a valid source — no png/ subdirectory found at: ${sourcePath}` }],
          details: {},
        };
      }

      // Ref + data dir via the shared helpers so this agrees with discovery and
      // manifest loading (flat sources → data/<basename>, nested → data/<slug>).
      const ref = deriveRef(workspaceDir, sourcePath);

      // An out-of-tree source derives its ref from the BASENAME, so an archive at
      // /mnt/archive/Frankfurt_1864 collides with an in-tree sources/Frankfurt_1864.
      // Adding it was a no-op while this tool still reported success with the
      // ARCHIVE's page count and path — after which every list_pages/task silently
      // read the other document and both wrote into one data/ dir. Refuse instead:
      // a wrong source that looks right is the worst outcome here, and resolveByAlias
      // (which throws on an ambiguous basename) is never reached, because this
      // collision happens before any lookup.
      const existing = ctx.members.get(ref);
      if (existing && existing.path !== sourcePath) {
        return {
          content: [
            {
              type: "text",
              text:
                `Cannot add ${sourcePath}: its ref "${ref}" is already taken by ${existing.path}.\n` +
                `Two different directories cannot share one ref — the pages and the extracted data ` +
                `would be attributed to the wrong source. Rename the directory you are adding (its ` +
                `basename is what makes the ref), or move it under the workspace's sources/ tree, ` +
                `where a nested path keeps it distinct.`,
            },
          ],
          details: {},
        };
      }

      const dataDir = join(workspaceDir, "data", dataKeyForRef(ref, sourcePath));
      mkdirSync(dataDir, { recursive: true });

      // Idempotent add — the auto-collection already holds every source under sources/.
      if (!existing) {
        ctx.members.set(ref, { ref, path: sourcePath, dataDir });
      }

      // Persist the addition so it survives the next session_start.
      // buildCollectionFromDiscovery rebuilds the in-memory catalog from
      // sources/ on every startup/switch/resume/fork, which would otherwise
      // wipe this out-of-tree source with nothing to restore it from.
      saveSessionExtraMember(workspaceDir, extCtx.sessionManager.getSessionId(), sourcePath);

      const pages = listPageIds(sourcePath);
      sendToExtension({
        type: "show_page",
        pageId: 1,
        totalPages: pages.length,
        sourceDir: sourcePath,
        sourceName: basename(dataDir),
        bbox: null,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Added source "${ref}" to the collection (${pages.length} pages) at ${sourcePath}. ` +
              `Data dir: ${dataDir}. Pass source: "${ref}" to page tools.`,
          },
        ],
        details: { ref, sourcePath, pageCount: pages.length },
      };
    },
  };
}
