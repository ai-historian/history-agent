import { basename } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { listPageIds } from "../utils/page-files.js";
import { sendToExtension } from "../http/http-client.js";
import type { CollectionContext } from "./collection-context.js";
import { resolveSource } from "./collection-context.js";

const listPagesParams = Type.Object({
  source: Type.String({
    description: "Collection member ref to list pages for (see the catalog in the system prompt).",
  }),
});

export function createListPagesTool(ctx: CollectionContext, description: string): ToolDefinition<typeof listPagesParams> {
  return {
    name: "list_pages",
    label: "List Pages",
    description,
    parameters: listPagesParams,
    async execute(_toolCallId, params) {
      const m = resolveSource(ctx, params.source);
      const pages = listPageIds(m.path);
      if (pages.length === 0) {
        return {
          content: [{ type: "text", text: `No pages found in source "${m.ref}".` }],
          details: {},
        };
      }
      sendToExtension({
        type: "page_list",
        sourceDir: m.path,
        sourceName: basename(m.dataDir),
        firstPage: pages[0],
        lastPage: pages[pages.length - 1],
        totalPages: pages.length,
      });

      const first = String(pages[0]).padStart(4, "0");
      const last = String(pages[pages.length - 1]).padStart(4, "0");
      return {
        content: [
          {
            type: "text",
            text:
              `Source "${m.ref}" — pages ${first} to ${last} ` +
              `(${pages.length} pages total). ` +
              `Files are named page_NNNN.png (4-digit zero-padded).`,
          },
        ],
        details: {},
      };
    },
  };
}
