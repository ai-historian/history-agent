import { join, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExpertRegistry } from "./expert-registry.js";
import type { CollectionContext } from "./collection-context.js";
import { resolveSource } from "./collection-context.js";
import type { ToolText } from "../utils/tool-loader.js";
import { runExpertTurn, confirmExpertGrant, type ExpertTurnInput, type ExpertToolUse } from "./expert-turn.js";
import type { ExpertCapability } from "./expert-tools.js";
import { type Bbox } from "../utils/crop-image.js";
import { envInt } from "../utils/env-config.js";

interface ExpertEntry {
  taskId?: string;
  page_id: number;
  status: "ok" | "error";
  response?: string;
  file?: string;
  /** Turn ran, but an output_file was owed and the expert never wrote it. */
  noOutput?: boolean;
  error?: string;
  cost?: number;
  toolUses?: ExpertToolUse[];
}

/**
 * One page's live state while the batch runs, streamed to the UI via the
 * tool's onUpdate callback. Same shape as the final ExpertEntry plus the
 * two pre-completion statuses and a short activity line.
 */
interface LiveExpertEntry extends Omit<ExpertEntry, "status"> {
  status: "queued" | "running" | "ok" | "error";
  /** What the expert is doing right now (e.g. "view_region · 3 tool calls"). */
  activity?: string;
}

// Coalesce onUpdate emissions: a 250-expert batch can produce a state change
// every few ms; the UI only needs a smooth trickle.
const PROGRESS_EMIT_MS = 150;

const taskBatchParams = Type.Object({
  source: Type.String({
    description:
      "Collection member ref every expert in this batch works on (see the catalog in the system prompt). " +
      "One batch targets a single source; iterate sources with separate batches.",
  }),
  page_ids: Type.Array(Type.Number(), {
    description:
      "Array of page IDs to spawn an expert for (e.g. [42, 43, 44]). " +
      "These are file-system indices, not printed page numbers.",
  }),
  prompt: Type.String({ description: "The prompt sent to each page's expert." }),
  model: Type.Optional(
    Type.String({
      description:
        `Model as provider/model-id (e.g. "anthropic/claude-opus-4-8"). ` +
        `Default: the orchestrator's current model. Any model pi has auth for works; ` +
        `an unknown model errors with the list of available models.`,
    }),
  ),
  output_file: Type.Optional(
    Type.String({
      description:
        "File name template with a {page_id} placeholder (e.g. 'entries_{page_id}.json'). " +
        "{page_id} is replaced with the zero-padded page number (e.g. 0042), giving each page its " +
        "own file in the source data directory. When set, each expert writes its result there itself " +
        "via a scoped save_output tool (JSON is validated before writing) — its chat text is not " +
        "captured. A page whose expert never calls save_output is reported as producing no output. " +
        "If omitted, results are returned inline.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      description:
        "Max parallel API calls. Higher values are faster but cost more concurrent quota. " +
        "Omit to use the user's configured default; requests above the user's configured max are clamped to it.",
      minimum: 1,
      maximum: 250,
    }),
  ),
  bbox: Type.Optional(
    Type.Object(
      {
        x: Type.Number({ minimum: 0, maximum: 1 }),
        y: Type.Number({ minimum: 0, maximum: 1 }),
        w: Type.Number({ minimum: 0, maximum: 1 }),
        h: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { description: "Crop region in normalized coordinates (0–1). Applied to every page before sending to the model." }
    )
  ),
  grant: Type.Optional(
    Type.Array(Type.Union([Type.Literal("bash"), Type.Literal("write"), Type.Literal("edit")]), {
      description:
        'Elevate EVERY expert in this batch beyond read-only: "bash" (run shell commands), "write" ' +
        '(create files), "edit" (modify files). REQUIRES the user\'s confirmation (asked once for the whole ' +
        "batch) — experts are read-only by default so their work stays auditable; normally disabled for " +
        "oversight and safety. Omit for normal read-only experts.",
    }),
  ),
});

export function createTaskBatchTool(
  collectionCtx: CollectionContext,
  registry: ExpertRegistry,
  toolText: ToolText,
  pageExpertPrompt: string,
): ToolDefinition<typeof taskBatchParams> {
  return {
    name: "task_batch",
    label: "Task (Batch)",
    description: toolText.description,
    promptGuidelines: toolText.promptGuidelines,
    parameters: taskBatchParams,
    async execute(_toolCallId, params, signal, onUpdate, extCtx) {
      const member = resolveSource(collectionCtx, params.source);
      const outputDir = member.dataDir;
      const sourceRel = relative(collectionCtx.workspaceDir, member.path);
      const pageIds = params.page_ids.map((id) => Math.round(id));
      const outputFileTemplate = params.output_file;
      const bbox = params.bbox as Bbox | undefined;

      if (outputFileTemplate && !outputFileTemplate.includes("{page_id}")) {
        return {
          content: [{ type: "text", text: "output_file must contain {page_id} placeholder (e.g. 'entries_{page_id}.json')." }],
          details: {},
        };
      }
      if (pageIds.length === 0) {
        return { content: [{ type: "text", text: "No page IDs provided." }], details: {} };
      }

      // Elevated capabilities are confirmed ONCE for the whole cohort, before any
      // expert runs. Denial aborts the batch.
      const grant: ExpertCapability[] = params.grant ?? [];
      if (grant.length > 0 && !(await confirmExpertGrant(extCtx, grant, `all ${pageIds.length} experts in this batch`))) {
        return {
          content: [
            {
              type: "text",
              text:
                `User declined to grant elevated access (${grant.join(", ")}); no experts were run. ` +
                "Re-issue without `grant` to run read-only, or ask the user to approve.",
            },
          ],
          details: {},
        };
      }

      const experts: ExpertEntry[] = [];
      let resolvedModel = params.model ?? "(orchestrator default)";

      // ── live progress ────────────────────────────────────────────────────
      // Every page starts "queued"; workers flip entries to "running" (with an
      // activity line from the expert's own loop) and then to the final entry.
      // Snapshots stream to the UI via onUpdate, coalesced to PROGRESS_EMIT_MS.
      const live = new Map<number, LiveExpertEntry>(pageIds.map((id) => [id, { page_id: id, status: "queued" }]));
      let lastEmit = 0;
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let progressClosed = false;
      const emitNow = (): void => {
        lastEmit = Date.now();
        const entries = [...live.values()].sort((a, b) => a.page_id - b.page_id).map((e) => ({ ...e }));
        const queued = entries.filter((e) => e.status === "queued").length;
        const running = entries.filter((e) => e.status === "running").length;
        const done = entries.filter((e) => e.status === "ok").length;
        const failed = entries.filter((e) => e.status === "error").length;
        onUpdate?.({
          content: [
            {
              type: "text",
              text:
                `Batch progress: ${done + failed}/${entries.length} finished — ` +
                `${running} running, ${queued} queued` +
                (failed > 0 ? `, ${failed} failed` : ""),
            },
          ],
          details: {
            model: resolvedModel,
            prompt: params.prompt,
            bbox: bbox ?? null,
            source: sourceRel,
            experts: entries,
            progress: { total: entries.length, queued, running, done, failed },
          },
        });
      };
      const scheduleEmit = (): void => {
        if (!onUpdate || progressClosed) return;
        const elapsed = Date.now() - lastEmit;
        if (elapsed >= PROGRESS_EMIT_MS) {
          emitNow();
          return;
        }
        if (emitTimer) return;
        emitTimer = setTimeout(() => {
          emitTimer = undefined;
          if (!progressClosed) emitNow();
        }, PROGRESS_EMIT_MS - elapsed);
      };

      const runOne = async (pageId: number): Promise<ExpertEntry> => {
        const filename = outputFileTemplate?.replace("{page_id}", String(pageId).padStart(4, "0"));
        const outputPath = filename ? join(outputDir, filename) : undefined;
        const entry = live.get(pageId)!;
        entry.status = "running";
        scheduleEmit();
        const input: ExpertTurnInput = {
          source: params.source,
          prompt: params.prompt,
          model: params.model,
          pageId,
          bbox,
          signal,
          grantedCaps: grant,
          outputPath,
          onProgress: (p) => {
            if (p.taskId) entry.taskId = p.taskId;
            entry.activity =
              p.phase === "tool"
                ? `${p.lastTool} · ${p.toolCalls} tool ${p.toolCalls === 1 ? "call" : "calls"}`
                : p.toolCalls > 0
                  ? `thinking · ${p.toolCalls} tool ${p.toolCalls === 1 ? "call" : "calls"}`
                  : "thinking";
            scheduleEmit();
          },
        };
        const result = await runExpertTurn(registry, collectionCtx, pageExpertPrompt, extCtx, input);
        let final: ExpertEntry;
        if (!result.ok) {
          final = { page_id: pageId, status: "error", error: result.error };
        } else {
          resolvedModel = result.model;
          if (outputFileTemplate) {
            // The expert writes the file itself via save_output; report from whether it did.
            final = result.wroteOutput
              ? { taskId: result.taskId, page_id: pageId, status: "ok", file: filename, cost: result.cost, toolUses: result.toolUses }
              : { taskId: result.taskId, page_id: pageId, status: "ok", noOutput: true, cost: result.cost, toolUses: result.toolUses };
          } else {
            final = { taskId: result.taskId, page_id: pageId, status: "ok", response: result.text || "(empty response)", cost: result.cost, toolUses: result.toolUses };
          }
        }
        live.set(pageId, { ...final });
        scheduleEmit();
        return final;
      };

      // Concurrency-limited worker pool. The user's `chronos.maxConcurrency`
      // setting (CHRONOS_MAX_CONCURRENCY, default 20) is both the default when the
      // model omits `concurrency` AND a hard ceiling on what it may request.
      const maxConcurrency = envInt("CHRONOS_MAX_CONCURRENCY", 20, 1, 250);
      const concurrency = Math.min(params.concurrency ?? maxConcurrency, maxConcurrency);
      const queue = [...pageIds];
      if (onUpdate) emitNow(); // show the all-queued state immediately
      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(
          (async () => {
            while (queue.length > 0) {
              if (signal?.aborted) return;
              const pageId = queue.shift()!;
              experts.push(await runOne(pageId));
            }
          })(),
        );
      }
      await Promise.all(workers);
      // Stop progress emissions before returning: a trailing timer firing after
      // tool_execution_end would overwrite the final result in the UI.
      progressClosed = true;
      if (emitTimer) clearTimeout(emitTimer);
      experts.sort((a, b) => a.page_id - b.page_id);

      const errCount = experts.filter((e) => e.status === "error").length;
      const noOutputCount = experts.filter((e) => e.noOutput).length;
      // "Succeeded" means the goal was met: turn ran AND (if an output_file was
      // owed) the file was written. A page that ran but wrote no output is its
      // own bucket, not a success.
      const okCount = experts.filter((e) => e.status === "ok" && !e.noOutput).length;
      const totalCost = experts.reduce((sum, e) => sum + (e.cost ?? 0), 0);

      const lines = [
        `Batch complete: ${okCount}/${pageIds.length} succeeded` +
          (errCount > 0 ? `, ${errCount} failed` : "") +
          (noOutputCount > 0 ? `, ${noOutputCount} produced no output` : "") +
          (totalCost > 0 ? ` [total cost: $${totalCost.toFixed(4)}]` : ""),
        "",
        ...experts.map((e) =>
          e.status !== "ok"
            ? `(failed) p.${e.page_id}: ${e.error}`
            : e.noOutput
              ? `(no output) p.${e.page_id}: expert never called save_output — no file written [${e.taskId}]`
              : `${e.taskId} ⇒ p.${e.page_id}${e.file ? ` → ${e.file}` : ""}`,
        ),
        "",
        "Follow up on any page with task(task_id, prompt).",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { model: resolvedModel, prompt: params.prompt, bbox: bbox ?? null, source: sourceRel, experts },
      };
    },
  };
}
