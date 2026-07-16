import { relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExpertRegistry } from "./expert-registry.js";
import type { CollectionContext } from "./collection-context.js";
import { resolveSource } from "./collection-context.js";
import type { ToolText } from "../utils/tool-loader.js";
import { runExpertTurn, confirmExpertGrant, type ExpertTurnInput, type ExpertToolUse } from "./expert-turn.js";
import { resolveImagePath, resolveOutputFile, type ExpertCapability } from "./expert-tools.js";
import { type Bbox } from "../utils/crop-image.js";
import { envInt } from "../utils/env-config.js";

interface ExpertEntry {
  key: string;
  label: string;
  taskId?: string;
  page_id?: number;
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
  source: Type.Optional(
    Type.String({
      description:
        "Collection member ref every expert works on. Required when using page_ids. " +
        "With images it is optional: if it resolves, each expert also gets that source's " +
        "view_page/view_region tools; a bad/absent ref is ignored.",
    }),
  ),
  page_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Spawn one expert per page id (file-system indices, not printed page numbers). Requires `source`. " +
        "Provide EITHER page_ids OR images, not both.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Spawn one expert per arbitrary image file path (workspace-relative). Source-independent. " +
        "Provide EITHER page_ids OR images, not both.",
    }),
  ),
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
        "Filename template. For a page batch use {page_id} (zero-padded), written in the source data dir. " +
        "For an image batch use {index} (1-based, zero-padded) and/or {name} (image basename without " +
        "extension), written workspace-relative. Each expert writes its own result via save_output (JSON " +
        "validated). If omitted, results are returned inline.",
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
      interface BatchItem { key: string; label: string; sortIndex: number; pageId?: number; imagePath?: string; }

      const usePages = Array.isArray(params.page_ids) && params.page_ids.length > 0;
      const useImages = Array.isArray(params.images) && params.images.length > 0;
      if (usePages === useImages) {
        return {
          content: [{ type: "text", text: "Provide exactly one of `page_ids` or `images` (non-empty)." }],
          details: {},
        };
      }
      if (usePages && !params.source) {
        return { content: [{ type: "text", text: "`page_ids` requires a `source`." }], details: {} };
      }

      let member: import("./collection-context.js").CollectionMember | undefined;
      let sourceRel: string | undefined;
      if (params.source) {
        try {
          member = resolveSource(collectionCtx, params.source);
          sourceRel = relative(collectionCtx.workspaceDir, member.path);
        } catch (e) {
          if (usePages) return { content: [{ type: "text", text: (e as Error).message }], details: {} };
          // image batch: a bad source ref is harmless (source unused) — ignore it.
        }
      }

      const outputFileTemplate = params.output_file;
      const bbox = params.bbox as Bbox | undefined;

      // Validate the output template against the chosen mode.
      if (outputFileTemplate) {
        if (usePages && !outputFileTemplate.includes("{page_id}")) {
          return { content: [{ type: "text", text: "output_file must contain {page_id} for a page batch." }], details: {} };
        }
        if (useImages && !outputFileTemplate.includes("{index}") && !outputFileTemplate.includes("{name}")) {
          return { content: [{ type: "text", text: "output_file must contain {index} and/or {name} for an image batch." }], details: {} };
        }
      }

      const items: BatchItem[] = [];
      if (usePages) {
        params.page_ids!.forEach((raw, i) => {
          const pageId = Math.round(raw);
          items.push({ key: `p${pageId}`, label: `p. ${pageId}`, sortIndex: i, pageId });
        });
      } else {
        for (let i = 0; i < params.images!.length; i++) {
          let imagePath: string;
          try {
            imagePath = resolveImagePath(collectionCtx.workspaceDir, params.images![i]);
          } catch (e) {
            return { content: [{ type: "text", text: `${params.images![i]}: ${(e as Error).message}` }], details: {} };
          }
          const base = params.images![i].replace(/\\/g, "/").split("/").pop() ?? params.images![i];
          items.push({ key: `img${i}`, label: base, sortIndex: i, imagePath });
        }
      }

      // Elevated capabilities are confirmed ONCE for the whole cohort, before any
      // expert runs. Denial aborts the batch.
      const grant: ExpertCapability[] = params.grant ?? [];
      if (grant.length > 0 && !(await confirmExpertGrant(extCtx, grant, `all ${items.length} experts in this batch`))) {
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
      const live = new Map<string, LiveExpertEntry>(
        items.map((it) => [it.key, { key: it.key, label: it.label, page_id: it.pageId, status: "queued" }]),
      );
      let lastEmit = 0;
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let progressClosed = false;
      const emitNow = (): void => {
        lastEmit = Date.now();
        const order = new Map(items.map((it) => [it.key, it.sortIndex]));
        const entries = [...live.values()]
          .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
          .map((e) => ({ ...e }));
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

      const runOne = async (item: BatchItem): Promise<ExpertEntry> => {
        const filename = outputFileTemplate
          ? outputFileTemplate
              .replace("{page_id}", item.pageId !== undefined ? String(item.pageId).padStart(4, "0") : "")
              .replace("{index}", String(item.sortIndex + 1).padStart(4, "0"))
              .replace("{name}", item.label.replace(/\.[^.]+$/, ""))
          : undefined;
        let outputPath: string | undefined;
        if (filename) {
          const baseDir = item.pageId !== undefined && member ? member.dataDir : collectionCtx.workspaceDir;
          try {
            outputPath = resolveOutputFile(collectionCtx.workspaceDir, baseDir, filename);
          } catch (e) {
            const errEntry: ExpertEntry = { key: item.key, label: item.label, page_id: item.pageId, status: "error", error: (e as Error).message };
            live.set(item.key, { ...errEntry });
            scheduleEmit();
            return errEntry;
          }
        }
        const entry = live.get(item.key)!;
        entry.status = "running";
        scheduleEmit();
        const input: ExpertTurnInput = {
          source: member ? params.source : undefined,
          prompt: params.prompt,
          model: params.model,
          pageId: item.pageId,
          bbox: item.pageId !== undefined ? bbox : undefined,
          imagePath: item.imagePath,
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
        const skel = { key: item.key, label: item.label, page_id: item.pageId };
        if (!result.ok) {
          final = { ...skel, status: "error", error: result.error };
        } else {
          resolvedModel = result.model;
          if (outputFileTemplate) {
            // The expert writes the file itself via save_output; report from whether it did.
            final = result.wroteOutput
              ? { ...skel, taskId: result.taskId, status: "ok", file: filename, cost: result.cost, toolUses: result.toolUses }
              : { ...skel, taskId: result.taskId, status: "ok", noOutput: true, cost: result.cost, toolUses: result.toolUses };
          } else {
            final = { ...skel, taskId: result.taskId, status: "ok", response: result.text || "(empty response)", cost: result.cost, toolUses: result.toolUses };
          }
        }
        live.set(item.key, { ...final });
        scheduleEmit();
        return final;
      };

      // Concurrency-limited worker pool. The user's `chronos.maxConcurrency`
      // setting (CHRONOS_MAX_CONCURRENCY, default 20) is both the default when the
      // model omits `concurrency` AND a hard ceiling on what it may request.
      const maxConcurrency = envInt("CHRONOS_MAX_CONCURRENCY", 20, 1, 250);
      const concurrency = Math.min(params.concurrency ?? maxConcurrency, maxConcurrency);
      const queue = [...items];
      if (onUpdate) emitNow(); // show the all-queued state immediately
      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(
          (async () => {
            while (queue.length > 0) {
              if (signal?.aborted) return;
              const item = queue.shift()!;
              experts.push(await runOne(item));
            }
          })(),
        );
      }
      await Promise.all(workers);
      // Stop progress emissions before returning: a trailing timer firing after
      // tool_execution_end would overwrite the final result in the UI.
      progressClosed = true;
      if (emitTimer) clearTimeout(emitTimer);
      const orderFinal = new Map(items.map((it) => [it.key, it.sortIndex]));
      experts.sort((a, b) => (orderFinal.get(a.key) ?? 0) - (orderFinal.get(b.key) ?? 0));

      const errCount = experts.filter((e) => e.status === "error").length;
      const noOutputCount = experts.filter((e) => e.noOutput).length;
      // "Succeeded" means the goal was met: turn ran AND (if an output_file was
      // owed) the file was written. A page that ran but wrote no output is its
      // own bucket, not a success.
      const okCount = experts.filter((e) => e.status === "ok" && !e.noOutput).length;
      const totalCost = experts.reduce((sum, e) => sum + (e.cost ?? 0), 0);

      const lines = [
        `Batch complete: ${okCount}/${items.length} succeeded` +
          (errCount > 0 ? `, ${errCount} failed` : "") +
          (noOutputCount > 0 ? `, ${noOutputCount} produced no output` : "") +
          (totalCost > 0 ? ` [total cost: $${totalCost.toFixed(4)}]` : ""),
        "",
        ...experts.map((e) =>
          e.status !== "ok"
            ? `(failed) ${e.label}: ${e.error}`
            : e.noOutput
              ? `(no output) ${e.label}: expert never called save_output — no file written [${e.taskId}]`
              : `${e.taskId} ⇒ ${e.label}${e.file ? ` → ${e.file}` : ""}`,
        ),
        "",
        "Follow up on any item with task(task_id, prompt).",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { model: resolvedModel, prompt: params.prompt, bbox: bbox ?? null, source: sourceRel, experts },
      };
    },
  };
}
