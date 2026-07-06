import { readFileSync, existsSync } from "node:fs";
import {
  complete,
  type ImageContent,
  type Message,
  type TextContent,
  type ToolCall,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pageIdToPath } from "../utils/page-files.js";
import type { ExpertRegistry, ExpertSession } from "./expert-registry.js";
import { newTaskId } from "./expert-registry.js";
import type { CollectionContext } from "./collection-context.js";
import { resolveSource } from "./collection-context.js";
import { resolveExpertModel } from "../utils/resolve-model.js";
import { cropImageToBuffer, downscaleToLimit, type Bbox } from "../utils/crop-image.js";
import { appendExpertTurn, type PersistedExpert, type PersistedStep } from "../utils/expert-store.js";
import { envInt } from "../utils/env-config.js";
import {
  buildExpertTools,
  executeExpertTool,
  outputOnlyTools,
  rehydrateToolResult,
  type ExpertCapability,
} from "./expert-tools.js";

// Bound the per-turn agentic loop so a confused expert can't spin on tool calls.
// User-configurable via the extension's `chronos.maxExpertToolCalls` setting,
// forwarded as CHRONOS_MAX_EXPERT_TOOL_CALLS; defaults to 100.
const MAX_EXPERT_TOOL_CALLS = envInt("CHRONOS_MAX_EXPERT_TOOL_CALLS", 100, 1, 1000);
// Absolute ceiling: past the exploratory budget an output-owing expert keeps only
// save_output (a few retries for invalid JSON), but this hard-stops all tools so
// the loop always terminates even if it keeps calling save_output.
const HARD_TOOL_CALL_CEILING = MAX_EXPERT_TOOL_CALLS + 3;
// Cap the long edge of every image sent to expert models. Providers resize
// past their own pixel caps anyway (Anthropic: 2576px on Opus 4.7+), so
// larger uploads are pure wasted bandwidth — at batch concurrency they can
// saturate the user's uplink. `chronos.maxImageDimension` setting, forwarded
// as CHRONOS_MAX_IMAGE_DIMENSION; 0 disables. view_region crops are cut from
// the full-resolution file first, so expert zooming keeps full detail.
const MAX_IMAGE_DIMENSION = envInt("CHRONOS_MAX_IMAGE_DIMENSION", 2576, 0, 100_000);

const CAP_DESCRIPTION: Record<ExpertCapability, string> = {
  bash: "run shell commands",
  write: "create files",
  edit: "modify files",
};

/**
 * Ask the user to approve elevating an expert beyond read-only. Experts are
 * read-only by default so their work stays auditable; bash/write/edit are off
 * unless the orchestrator requests them AND the user approves here. Always
 * prompts (it is the oversight gate). Returns true if approved; `scope`
 * describes who gets the grant (e.g. "this expert", "all 12 experts in this batch").
 */
export async function confirmExpertGrant(
  extCtx: ExtensionContext,
  caps: ExpertCapability[],
  scope: string,
): Promise<boolean> {
  if (caps.length === 0) return true;
  const list = caps.map((c) => `${c} (${CAP_DESCRIPTION[c]})`).join(", ");
  return extCtx.ui.confirm(
    "Grant expert elevated access?",
    `The agent wants to let ${scope} go beyond read-only — ${list} — in the workspace. ` +
      `Expert subagents are read-only by default so their work stays auditable; this is normally ` +
      `disabled for oversight and safety. Allow for this call?`,
  );
}

export function modelSpec(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

/**
 * Build the image content block for an expert turn by reading (and optionally
 * cropping) the page from disk. Shared by live turns and session restore, so a
 * persisted expert rehydrates its images without storing base64 on disk.
 */
export async function pageImageContent(sourceDir: string, pageId: number, bbox?: Bbox): Promise<ImageContent> {
  const imgPath = pageIdToPath(sourceDir, pageId);
  if (!existsSync(imgPath)) {
    throw new Error(`Page ${String(pageId).padStart(4, "0")} not found: ${imgPath}`);
  }
  const raw = bbox ? await cropImageToBuffer(imgPath, bbox) : readFileSync(imgPath);
  const capped = await downscaleToLimit(raw, MAX_IMAGE_DIMENSION);
  return { type: "image", data: capped.toString("base64"), mimeType: "image/png" };
}

export interface ExpertTurnInput {
  /** Collection member ref the expert works on. Always provided (the tools require it). */
  source: string;
  /** Continue an existing session; omit to spawn a new one. */
  taskId?: string;
  prompt: string;
  /** provider/model-id; defaults to the session's model on follow-up, else the orchestrator's current model. */
  model?: string;
  /** Attach this page's image to the message. */
  pageId?: number;
  bbox?: Bbox;
  /** Abort the (multi-call) agentic loop when the user cancels. */
  signal?: AbortSignal;
  /**
   * Elevated capabilities the orchestrator granted this expert (bash/write/edit).
   * Read-only tools are always available; these are added only when present, and
   * the caller is responsible for getting the user's confirmation first.
   */
  grantedCaps?: ExpertCapability[];
  /**
   * Absolute path the expert must write its result to via `save_output`
   * (pre-resolved by the caller from output_file). When set, the expert is given
   * the save_output tool and told to use it; the turn no longer returns its raw
   * text as the file's contents. Undefined for inline (return-text) tasks.
   */
  outputPath?: string;
}

/** One tool the expert invoked during a turn — surfaced to the UI for oversight. */
export interface ExpertToolUse {
  tool: string;
  pageId?: number;
  bbox?: Bbox;
  /** Short label for non-page tools (command run, file path, search term). */
  detail?: string;
  isError: boolean;
}

export type ExpertTurnResult =
  | {
      ok: true;
      taskId: string;
      model: string;
      text: string;
      cost: number | undefined;
      pageId: number | null;
      /** view_region/view_page calls the expert made this turn (in order). */
      toolUses: ExpertToolUse[];
      /** True when an output_file was owed and the expert wrote it via save_output.
       *  Always false for inline tasks (no output_file). */
      wroteOutput: boolean;
    }
  | { ok: false; error: string; taskId?: string };

function isToolCall(c: { type: string }): c is ToolCall {
  return c.type === "toolCall";
}

/**
 * Run one expert turn: resolve the model, build the (optionally image-bearing)
 * user message, then run an agentic loop — the model may call `view_region` /
 * `view_page` to pull in more imagery before answering. The full exchange
 * (intermediate tool calls + results) is kept in the session and persisted.
 * Shared by the `task` tool (single, formatted) and `task_batch` (many).
 */
export async function runExpertTurn(
  registry: ExpertRegistry,
  collectionCtx: CollectionContext,
  pageExpertPrompt: string,
  extCtx: ExtensionContext,
  input: ExpertTurnInput,
): Promise<ExpertTurnResult> {
  if (input.bbox && input.pageId === undefined) {
    return { ok: false, error: "bbox requires page_id." };
  }

  // Resolve the source up-front — it scopes both the attached page image and the
  // expert's own view_page/view_region tools. A source is always given now.
  let sourceDir: string;
  try {
    sourceDir = resolveSource(collectionCtx, input.source).path;
  } catch (e) {
    return { ok: false, taskId: input.taskId, error: (e as Error).message };
  }

  // Resolve the session first so a follow-up can default to its model.
  let session: ExpertSession | undefined;
  let taskId = input.taskId;
  if (taskId) {
    session = registry.sessions.get(taskId);
    if (!session) {
      const active = [...registry.sessions.keys()];
      return {
        ok: false,
        error: `Unknown task_id "${taskId}". Active tasks: ${active.length > 0 ? active.join(", ") : "(none)"}.`,
      };
    }
  }

  // Build the user message; attach a page image only when page_id is given.
  // The expert's tools always reach the resolved source, image or not.
  const content: (TextContent | ImageContent)[] = [];
  let pageId: number | null = null;
  const turnSourceDir: string = sourceDir;
  if (input.pageId !== undefined) {
    pageId = Math.round(input.pageId);
    try {
      content.push(await pageImageContent(sourceDir, pageId, input.bbox));
    } catch (e) {
      return { ok: false, taskId, error: (e as Error).message };
    }
  }
  // When an output_file is owed, direct the expert to write via save_output. The
  // directive is appended to the sent message only; the persisted turn keeps the
  // clean `input.prompt` (below) so restored history isn't cluttered with it.
  let promptText = input.prompt;
  if (input.outputPath) {
    const jsonHint = input.outputPath.toLowerCase().endsWith(".json")
      ? " The output file is JSON: pass a single valid JSON value (no code fences, no prose)."
      : "";
    promptText +=
      "\n\n[Output file] You MUST call save_output with your final result — the complete content " +
      "to write to the output file. Your chat reply is for reasoning only and is NOT saved." +
      jsonHint;
  }
  content.push({ type: "text", text: promptText });

  // Default to the session's model on follow-up, else the orchestrator's current
  // model (whatever the user has selected/authed in pi) — no provider is baked in.
  const fallback = session
    ? modelSpec(session.model)
    : extCtx.model
      ? modelSpec(extCtx.model)
      : undefined;
  const resolved = await resolveExpertModel(input.model, extCtx.modelRegistry, fallback, pageId !== null);
  if (!resolved.ok) {
    return { ok: false, taskId, error: resolved.error };
  }

  if (!session) {
    taskId = newTaskId(registry);
    session = { messages: [], model: resolved.model };
    registry.sessions.set(taskId, session);
  } else {
    session.model = resolved.model;
  }

  const userMessage: UserMessage = { role: "user", content, timestamp: Date.now() };

  // ── Agentic loop ─────────────────────────────────────────────────────────
  // turnMessages accumulates everything this turn appends after the prior
  // session history: the user message, intermediate tool calls/results, and the
  // final answer. steps captures the intermediate exchange for persistence.
  const turnMessages: Message[] = [userMessage];
  const steps: PersistedStep[] = [];
  let currentPageId: number | null = pageId;
  let toolCallCount = 0;
  // Read-only tools are always offered; the image tools only when the model can
  // consume images; bash/write/edit only for capabilities the orchestrator
  // granted (and the user approved upstream).
  const granted = new Set<ExpertCapability>(input.grantedCaps ?? []);
  const outputMode = !!input.outputPath;
  let expertToolDefs = buildExpertTools({
    vision: resolved.model.input.includes("image"),
    granted: [...granted],
    output: outputMode,
  });
  let toolsEnabled = expertToolDefs.length > 0;
  let totalCost = 0;
  let wroteOutput = false;
  let finalResponse;

  for (;;) {
    if (input.signal?.aborted) {
      return { ok: false, taskId, error: "Expert turn aborted." };
    }
    const response = await complete(
      resolved.model,
      {
        systemPrompt: pageExpertPrompt,
        messages: [...session.messages, ...turnMessages],
        tools: toolsEnabled ? expertToolDefs : undefined,
      },
      { apiKey: resolved.apiKey, headers: resolved.headers, signal: input.signal },
    );
    if (response.stopReason === "error") {
      return {
        ok: false,
        taskId,
        error: `Expert model error (${modelSpec(resolved.model)}): ${response.errorMessage ?? "unknown error"}`,
      };
    }
    // A cancel that lands while complete() is in flight resolves with an
    // "aborted" response rather than throwing. Treat it as a failed turn so it is
    // neither committed to session.messages nor persisted, and the callers don't
    // write its empty/partial text to an output_file as if it were a real answer.
    if (input.signal?.aborted || response.stopReason === "aborted") {
      return { ok: false, taskId, error: "Expert turn aborted." };
    }
    turnMessages.push(response);
    finalResponse = response;
    totalCost += response.usage?.cost?.total ?? 0;

    const toolCalls = toolsEnabled ? response.content.filter(isToolCall) : [];
    if (response.stopReason !== "toolUse" || toolCalls.length === 0) break;

    // Intermediate assistant turn — record it, then run each requested tool.
    steps.push({ kind: "assistant", message: response });
    for (const call of toolCalls) {
      toolCallCount++;
      const outcome = await executeExpertTool(call, {
        sourceDir: turnSourceDir,
        currentPageId,
        cwd: extCtx.cwd,
        granted,
        outputPath: input.outputPath,
      });
      turnMessages.push(outcome.message);
      steps.push({ kind: "toolResult", toolResult: outcome.persist });
      if (outcome.viewedPageId !== undefined) currentPageId = outcome.viewedPageId;
      if (outcome.wroteOutput) wroteOutput = true;
    }
    // Spent the budget — stop the exploratory tools so the next completion must
    // answer. When an output_file is still owed, keep ONLY save_output (within a
    // small grace window) so the expert can still fulfill its contract instead of
    // being stranded; the hard ceiling then cuts everything off so the loop ends.
    if (toolCallCount >= HARD_TOOL_CALL_CEILING) {
      toolsEnabled = false;
    } else if (toolCallCount >= MAX_EXPERT_TOOL_CALLS) {
      if (outputMode) {
        expertToolDefs = outputOnlyTools();
      } else {
        toolsEnabled = false;
      }
    }
  }

  session.messages.push(...turnMessages);

  const text = finalResponse.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Persist this turn so the expert survives an agent restart. Compact: prompt +
  // provenance + the (text-only) agentic exchange; page images are re-cropped
  // from disk on restore. Best-effort — appendExpertTurn never throws.
  appendExpertTurn(extCtx.cwd, extCtx.sessionManager.getSessionId(), taskId!, modelSpec(resolved.model), {
    prompt: input.prompt,
    pageId: pageId ?? undefined,
    bbox: input.bbox,
    sourceDir: turnSourceDir,
    steps: steps.length > 0 ? steps : undefined,
    response: finalResponse,
  });

  // Surface the expert's tool calls (page/region it pulled in) for UI oversight.
  const toolUses: ExpertToolUse[] = steps
    .filter((s): s is Extract<PersistedStep, { kind: "toolResult" }> => s.kind === "toolResult")
    .map((s) => ({
      tool: s.toolResult.toolName,
      pageId: s.toolResult.image?.pageId,
      bbox: s.toolResult.image?.bbox,
      detail: s.toolResult.detail,
      isError: s.toolResult.isError,
    }));

  return {
    ok: true,
    taskId: taskId!,
    model: modelSpec(resolved.model),
    text,
    cost: totalCost > 0 ? totalCost : undefined,
    pageId,
    toolUses,
    wroteOutput,
  };
}

/**
 * Rebuild in-memory expert sessions from their persisted turn-logs, re-cropping
 * page images (and any tool-driven zoom crops) from disk. Skips a task whose
 * model can no longer be resolved (e.g. missing API key); restores a turn
 * text-only if its source page is gone. Mutates the registry in place.
 */
export async function restoreExpertSessions(
  registry: ExpertRegistry,
  extCtx: ExtensionContext,
  persisted: PersistedExpert[],
): Promise<void> {
  let maxId = 0;
  for (const rec of persisted) {
    const messages: Message[] = [];
    for (const turn of rec.turns) {
      const content: (TextContent | ImageContent)[] = [];
      if (turn.pageId !== undefined && turn.sourceDir) {
        try {
          content.push(await pageImageContent(turn.sourceDir, turn.pageId, turn.bbox));
        } catch {
          // page/source no longer on disk — restore this turn text-only
        }
      }
      content.push({ type: "text", text: turn.prompt });
      const userMessage: UserMessage = { role: "user", content, timestamp: turn.response.timestamp };
      messages.push(userMessage);
      // Replay the agentic exchange (assistant tool calls + re-hydrated results).
      for (const step of turn.steps ?? []) {
        if (step.kind === "assistant") {
          messages.push(step.message);
        } else {
          messages.push(await rehydrateToolResult(step.toolResult));
        }
      }
      messages.push(turn.response);
    }
    const resolved = await resolveExpertModel(rec.modelSpec, extCtx.modelRegistry, undefined, false);
    if (!resolved.ok) continue;
    registry.sessions.set(rec.taskId, { messages, model: resolved.model });
    const n = parseInt(rec.taskId.replace(/^task-/, ""), 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  }
  if (maxId + 1 > registry.nextId) registry.nextId = maxId + 1;
}
