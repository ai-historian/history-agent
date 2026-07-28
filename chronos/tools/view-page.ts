import { relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExpertRegistry } from "./expert-registry.js";
import type { CollectionContext } from "./collection-context.js";
import { requireSourceDataDir, resolveSource } from "./collection-context.js";
import { runExpertTurn, confirmExpertGrant } from "./expert-turn.js";
import { resolveImagePath, resolveOutputFile, type ExpertCapability } from "./expert-tools.js";

const grantParam = Type.Optional(
  Type.Array(Type.Union([Type.Literal("bash"), Type.Literal("write"), Type.Literal("edit")]), {
    description:
      'Elevate this expert beyond read-only by granting capabilities: "bash" (run shell commands), ' +
      '"write" (create files), "edit" (modify files). REQUIRES the user\'s confirmation each time — ' +
      "experts are read-only by default (they can view pages and read the workspace) so their work stays " +
      "auditable; this is normally disabled for oversight and safety. Omit for a normal read-only expert.",
  }),
);

const taskParams = Type.Object({
  source: Type.Optional(
    Type.String({
      description:
        "Collection member ref the expert works on (see the catalog in the system prompt). " +
        "Optional: required only when you pass page_id, or when the expert should have source-scoped " +
        "view_page/view_region. Omit for a task on an arbitrary `image` or a plain (text-only) task.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description:
        "Attach an arbitrary image file by path (workspace-relative, inside the workspace). Use this for " +
        "a picture that is not a cataloged source page. Mutually exclusive with page_id. Any common image " +
        "format is accepted (normalized to PNG, downscaled to the image cap). A missing/undecodable file " +
        "fails the task.",
    }),
  ),
  prompt: Type.String({ description: "What to ask the expert model." }),
  task_id: Type.Optional(
    Type.String({
      description:
        "Continue an existing expert session. Omit to spawn a new expert; the result ends with " +
        "its `task_id:` — pass that back here for follow-up questions in the same conversation.",
    })
  ),
  page_id: Type.Optional(
    Type.Number({
      description:
        "Attach this page's image to the message (file-system page index, e.g. 1 for page_0001.png — " +
        "NOT the printed page number). Optional: omit for a text-only message.",
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        `Model as provider/model-id (e.g. "anthropic/claude-opus-4-8"). ` +
        `Default: the orchestrator's current model for new tasks, the session's current model on follow-ups. ` +
        `Any model pi has auth for works; an unknown model errors with the list of available models.`,
    })
  ),
  output_file: Type.Optional(
    Type.String({
      description:
        "If provided, the expert writes its result to this file " +
        "(e.g. 'entries_0042.json') itself, via a scoped save_output tool (JSON is validated before " +
        "writing) — its chat text is not captured. The tool returns a short confirmation; if the " +
        "expert never calls save_output, no file is written and that is reported. " +
        "The path is relative to the data directory of the source in effect — the one you pass here, " +
        "or, on a task_id follow-up that omits `source`, the source that session already works on. " +
        "Only when no source is in effect at all (a plain task) is it resolved workspace-relative. " +
        "Restricted/escaping paths are rejected.",
    })
  ),
  bbox: Type.Optional(
    Type.Object(
      {
        x: Type.Number({ minimum: 0, maximum: 1 }),
        y: Type.Number({ minimum: 0, maximum: 1 }),
        w: Type.Number({ minimum: 0, maximum: 1 }),
        h: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { description: "Crop region in normalized coordinates (0–1). x/y is the top-left corner, w/h is width/height. Crops the image before sending. Requires page_id." }
    )
  ),
  grant: grantParam,
});

/**
 * Base dir for a task's `output_file`.
 *
 * An explicit `source` wins; otherwise a task_id follow-up inherits the
 * session's remembered source (mirroring expert-turn.ts's `effectiveSource`).
 * Only a genuine plain task — no source anywhere, a supported mode — targets
 * the workspace root. Returns "" for a ref that does not resolve, so
 * runExpertTurn reports the source error rather than writing somewhere else.
 */
export function outputBaseDir(
  ctx: CollectionContext,
  explicitSource: string | undefined,
  inheritedSource: string | undefined,
): string {
  const effective = explicitSource ?? inheritedSource;
  if (!effective) return ctx.workspaceDir;
  try {
    return requireSourceDataDir(ctx, effective);
  } catch {
    return "";
  }
}

/**
 * The source a `task_id` follow-up inherits — the ref its expert session
 * remembers. Read from the registry (rebuilt from the persisted expert store on
 * session start) because that is the very object runExpertTurn consults for its
 * `effectiveSource`, so the output dir can never disagree with the source the
 * expert actually views. Undefined for a new task or a sourceless session.
 */
function sessionSourceRef(registry: ExpertRegistry, taskId: string | undefined): string | undefined {
  return taskId ? registry.sessions.get(taskId)?.sourceRef : undefined;
}

export function createTaskTool(
  collectionCtx: CollectionContext,
  registry: ExpertRegistry,
  description: string,
  pageExpertPrompt: string,
): ToolDefinition<typeof taskParams> {
  return {
    name: "task",
    label: "Task",
    description,
    parameters: taskParams,
    async execute(_toolCallId, params, signal, onUpdate, extCtx) {
      const grant: ExpertCapability[] = params.grant ?? [];
      if (grant.length > 0 && !(await confirmExpertGrant(extCtx, grant, "this expert"))) {
        return {
          content: [
            {
              type: "text",
              text:
                `User declined to grant elevated access (${grant.join(", ")}); the expert was not run. ` +
                "Re-issue without `grant` to run read-only, or ask the user to approve.",
            },
          ],
          details: {},
        };
      }
      if (params.image && params.page_id !== undefined) {
        return {
          content: [{ type: "text", text: "`image` and `page_id` are mutually exclusive — pass only one." }],
          details: {},
        };
      }
      if (params.page_id !== undefined && !params.source) {
        return {
          content: [{ type: "text", text: "`page_id` requires a `source`." }],
          details: {},
        };
      }
      let imagePath: string | undefined;
      if (params.image) {
        try {
          imagePath = resolveImagePath(collectionCtx.workspaceDir, params.image);
        } catch (e) {
          return { content: [{ type: "text", text: (e as Error).message }], details: {} };
        }
      }

      // Pre-resolve the output path the expert will write to via save_output. If
      // the source ref is bad, runExpertTurn returns the proper error below, so
      // just leave outputPath undefined here.
      let outputPath: string | undefined;
      if (params.output_file) {
        // A bad source ref leaves baseDir empty so runExpertTurn reports the source
        // error; a restricted/escaping output_file is a hard error here (run nothing).
        const baseDir = outputBaseDir(collectionCtx, params.source, sessionSourceRef(registry, params.task_id));
        if (baseDir) {
          try {
            outputPath = resolveOutputFile(collectionCtx.workspaceDir, baseDir, params.output_file);
          } catch (e) {
            return { content: [{ type: "text", text: (e as Error).message }], details: {} };
          }
        }
      }

      const result = await runExpertTurn(registry, collectionCtx, pageExpertPrompt, extCtx, {
        source: params.source,
        taskId: params.task_id,
        prompt: params.prompt,
        model: params.model,
        pageId: params.page_id,
        bbox: params.bbox,
        imagePath,
        signal,
        grantedCaps: grant,
        outputPath,
        // Stream the expert's live state (phase + tool trace) so the UI card can
        // show what it is doing instead of a bare spinner.
        onProgress: onUpdate
          ? (p) =>
              onUpdate({
                content: [
                  {
                    type: "text",
                    text:
                      p.phase === "tool"
                        ? `Expert working… ${p.toolCalls} tool ${p.toolCalls === 1 ? "call" : "calls"} (last: ${p.lastTool})`
                        : "Expert thinking…",
                  },
                ],
                details: {
                  taskId: p.taskId,
                  toolUses: p.toolUses,
                  live: { phase: p.phase, toolCalls: p.toolCalls, lastTool: p.lastTool },
                },
              })
          : undefined,
      });

      if (!result.ok) {
        const trailer = result.taskId ? `\ntask_id: ${result.taskId}` : "";
        return {
          content: [{ type: "text", text: `${result.error}${trailer}` }],
          details: result.taskId ? { taskId: result.taskId } : {},
        };
      }

      const { taskId, model, text, cost, pageId, toolUses } = result;
      const bbox = params.bbox ?? null;
      const costStr = cost !== undefined ? ` [cost: $${cost.toFixed(4)}]` : "";

      // Workspace-relative source path — used both to source-qualify the citation
      // (@path) and passed in details.source so the expert transcript's page/region
      // chips open this task's source, not whichever was shown last. The turn
      // succeeded, so params.source resolves; guard anyway.
      let sourceRel = "";
      if (params.source) {
        try {
          sourceRel = relative(collectionCtx.workspaceDir, resolveSource(collectionCtx, params.source).path);
        } catch {
          sourceRel = "";
        }
      }
      const src = sourceRel ? `@${sourceRel}` : "";
      const viewLink =
        pageId === null
          ? ""
          : bbox
            ? `[view p.${pageId}${src}] [view p.${pageId}#sel=${bbox.x},${bbox.y},${bbox.w},${bbox.h}${src}]\n`
            : `[view p.${pageId}${src}]\n`;
      const trailer = `\ntask_id: ${taskId}`;

      if (params.output_file) {
        // The expert writes the file itself via save_output; report from whether it did.
        const body = result.wroteOutput
          ? `${viewLink}→ ${params.output_file}${trailer}`
          : `${viewLink}(expert produced no output — save_output was never called, so no file was written)${trailer}`;
        return {
          content: [{ type: "text", text: body }],
          details: {
            model,
            taskId,
            pageId,
            bbox,
            cost: costStr,
            path: result.wroteOutput ? outputPath : undefined,
            toolUses,
            source: sourceRel || undefined,
          },
        };
      }

      return {
        content: [{ type: "text", text: `${viewLink}${text || "(empty response)"}${trailer}` }],
        details: { model, taskId, pageId, bbox, cost: costStr, toolUses, source: sourceRel || undefined },
      };
    },
  };
}
