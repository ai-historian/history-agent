import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute, join, basename } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { sendToExtension } from "../http/http-client.js";
import type { CollectionContext } from "./collection-context.js";
import { resolveSource } from "./collection-context.js";

const showTextParams = Type.Object({
  source: Type.String({
    description: "Collection member ref the file belongs to (used to resolve a relative file_path).",
  }),
  file_path: Type.String({
    description: "Path to the text file. Absolute, or relative to the source directory.",
  }),
  highlight: Type.Optional(
    Type.String({
      description:
        "A text passage to highlight and scroll to. Must be an exact substring of the file content.",
    })
  ),
});

export function createShowTextTool(ctx: CollectionContext, description: string): ToolDefinition<typeof showTextParams> {
  return {
    name: "show_text",
    label: "Show Text",
    description,
    parameters: showTextParams,
    async execute(_toolCallId, params) {
      const m = resolveSource(ctx, params.source);
      const sourceDir = m.path;
      const filePath = isAbsolute(params.file_path)
        ? params.file_path
        : resolve(join(sourceDir, params.file_path));

      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          details: {},
        };
      }

      const content = readFileSync(filePath, "utf-8");
      const highlightFound =
        params.highlight == null || content.includes(params.highlight);

      sendToExtension({
        type: "show_text",
        filePath,
        content,
        highlight: params.highlight ?? null,
        sourceName: basename(m.dataDir),
      });

      return {
        content: [
          {
            type: "text",
            text: highlightFound
              ? `Showing ${params.file_path} in the viewer.`
              : `Showing ${params.file_path} — highlight passage not found in file.`,
          },
        ],
        details: { filePath, highlight: params.highlight ?? null },
      };
    },
  };
}
