import { existsSync } from "node:fs";
import { basename, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { pageIdToPath, listPageIds } from "../utils/page-files.js";
import { sendToExtension } from "../http/http-client.js";
import type { CollectionContext } from "./collection-context.js";
import { resolveSource } from "./collection-context.js";

const bboxSchema = Type.Object(
  {
    x: Type.Number({ minimum: 0, maximum: 1 }),
    y: Type.Number({ minimum: 0, maximum: 1 }),
    w: Type.Number({ minimum: 0, maximum: 1 }),
    h: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { description: "Crop region in normalized coordinates (0–1). x/y is the top-left corner, w/h is width/height." }
);

const showPageParams = Type.Object({
  source: Type.String({
    description: "Collection member ref to show a page from (see the catalog in the system prompt).",
  }),
  page_id: Type.Number({ description: "The page number (e.g. 1 for page_0001.png)." }),
  bbox: Type.Optional(bboxSchema),
});

export function createShowPageTool(ctx: CollectionContext, description: string): ToolDefinition<typeof showPageParams> {
  return {
    name: "show_page",
    label: "Show Page",
    description,
    parameters: showPageParams,
    async execute(_toolCallId, params) {
      const m = resolveSource(ctx, params.source);
      const sourceDir = m.path;
      const pageId = Math.round(params.page_id);
      const imgPath = pageIdToPath(sourceDir, pageId);

      if (!existsSync(imgPath)) {
        return {
          content: [{ type: "text", text: `Page ${String(pageId).padStart(4, "0")} not found: ${imgPath}` }],
          details: {},
        };
      }

      sendToExtension({
        type: "show_page",
        pageId,
        totalPages: listPageIds(sourceDir).length,
        sourceDir,
        // Emit the data-dir key (= basename(dataDir)); for flat sources this is
        // the source name, for nested ones the slug — so the panel's data/<name>
        // and viewer key agree with the agent's output dir in both cases.
        sourceName: basename(m.dataDir),
        bbox: params.bbox ?? null,
      });

      // Source-qualified view link (@ workspace-relative path) so a click opens
      // this exact source, not whichever was shown last. Guard against an empty
      // rel path so we never emit an unparseable "[view p.N@]".
      const sourceRel = relative(ctx.workspaceDir, sourceDir);
      const at = sourceRel ? `@${sourceRel}` : "";
      const bbox = params.bbox ?? null;
      const viewLink = bbox
        ? `[view p.${pageId}${at}] [view p.${pageId}#sel=${bbox.x},${bbox.y},${bbox.w},${bbox.h}${at}]`
        : `[view p.${pageId}${at}]`;

      return {
        content: [{ type: "text", text: viewLink }],
        details: { pageId, bbox, source: sourceRel || undefined },
      };
    },
  };
}
