import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

import {
  createCollectionContext,
  buildCollectionFromDiscovery,
  collectionDataDir,
  collectionMemoryPath,
  deriveRef,
  dataKeyForRef,
  type CollectionContext,
} from "../tools/collection-context.js";
import { createListPagesTool } from "../tools/list-pages.js";
import { createTaskTool } from "../tools/view-page.js";
import { createShowPageTool } from "../tools/show-page.js";
import { createShowTextTool } from "../tools/show-text.js";
import { createChangeSourceTool } from "../tools/change-source.js";
import { createTaskBatchTool } from "../tools/task-batch.js";
import { createExpertRegistry } from "../tools/expert-registry.js";
import { restoreExpertSessions } from "../tools/expert-turn.js";
import { loadExpertTasks } from "../utils/expert-store.js";
import { loadToolText, loadPromptFile } from "../utils/tool-loader.js";
import { listPageIds } from "../utils/page-files.js";
import { ensureWorkspace } from "../utils/workspace.js";
import { listCollections, loadCollectionInto } from "../utils/collection-manifest.js";
import {
  saveSessionCollection,
  loadSessionCollection,
  loadSessionExtraMembers,
} from "../utils/session-collection-store.js";
import { getNamedPromptCount, saveSessionName } from "../utils/session-name-store.js";
import { generateSessionTitle } from "../utils/session-namer.js";
import { connectHttp, sendToExtension, disconnectHttp } from "../http/http-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, "..", "..", "prompts");

function readWorkspaceSettings(cwd: string): Record<string, unknown> {
  const settingsPath = join(cwd, ".chronos", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

function writeWorkspaceSettings(cwd: string, settings: Record<string, unknown>) {
  const settingsPath = join(cwd, ".chronos", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

export default function (pi: ExtensionAPI) {
  // Shared mutable collection context — the active unit of work. Rebuilt from
  // discovery on every session start; tools resolve their required `source` ref
  // against it. "Everything is a collection; a single doc is a collection of one."
  const collectionCtx: CollectionContext = createCollectionContext();

  // ── Register all custom tools ──────────────────────────────────────────

  const expertRegistry = createExpertRegistry();
  const pageExpertPrompt = loadPromptFile("page-expert-prompt.md");

  pi.registerTool(createListPagesTool(collectionCtx, loadToolText("list-pages.md").description));
  pi.registerTool(createTaskTool(collectionCtx, expertRegistry, loadToolText("task.md").description, pageExpertPrompt));
  pi.registerTool(createShowPageTool(collectionCtx, loadToolText("show-page.md").description));
  pi.registerTool(createShowTextTool(collectionCtx, loadToolText("show-text.md").description));
  pi.registerTool(createTaskBatchTool(collectionCtx, expertRegistry, loadToolText("task-batch.md"), pageExpertPrompt));
  pi.registerTool(createChangeSourceTool(collectionCtx, loadToolText("change-source.md").description));

  // ── /select-source command ─────────────────────────────────────────────

  pi.registerCommand("select-source", {
    description: "Preview a source from the active collection in the page viewer",
    handler: async (args, ctx) => {
      const members = [...collectionCtx.members.values()].sort((a, b) => a.ref.localeCompare(b.ref));

      if (members.length === 0) {
        ctx.ui.notify(
          "No sources found. Add a directory with a png/ subfolder under sources/.",
          "warning",
        );
        return;
      }

      // Non-interactive: `/select-source <ref>` — the entire args string is the
      // member ref (refs are workspace-relative paths and may contain spaces).
      let member: (typeof members)[number] | undefined;
      const requested = (args ?? "").trim();
      if (requested) {
        member = members.find((m) => m.ref === requested || basename(m.path) === requested);
        if (!member) {
          ctx.ui.notify(`Source "${requested}" not found.`, "warning");
          return;
        }
      } else {
        const items = members.map((m) => `${m.ref}  (${listPageIds(m.path).length} pages)`);
        const selected = await ctx.ui.select("Preview a source", items);
        if (!selected) return;
        member = members[items.indexOf(selected)];
      }

      // Preview the first page in the viewer. There is no single "current source"
      // anymore — page tools take an explicit `source` ref — so this only previews.
      sendToExtension({
        type: "show_page",
        pageId: 1,
        totalPages: listPageIds(member.path).length,
        sourceDir: member.path,
        sourceName: basename(member.dataDir),
        bbox: null,
      });

      // Nudge the model toward the ref to pass as `source`. Keep the "Source
      // selected:" prefix — the session auto-namer filters it out.
      pi.sendUserMessage(
        `Source selected: "${member.ref}" (previewing in the viewer). ` +
          `Pass source: "${member.ref}" when calling page tools (list_pages, show_page, task, …).`,
        { deliverAs: "followUp" },
      );

      ctx.ui.notify(`Source: ${member.ref}`, "info");
    },
  });

  // ── /select-collection command ─────────────────────────────────────────

  const ALL_SOURCES = "(all sources)";

  pi.registerCommand("select-collection", {
    description: "Select a named collection to work over (or all sources)",
    handler: async (args, ctx) => {
      const collections = listCollections(ctx.cwd);

      // Resolve the choice: null = the auto "all sources" collection.
      let chosen: string | null | undefined;
      const requested = (args ?? "").trim();
      if (requested) {
        if (requested === ALL_SOURCES || requested.toLowerCase() === "all") {
          chosen = null;
        } else {
          const found = collections.find((c) => c.name === requested);
          if (!found) {
            ctx.ui.notify(`Collection "${requested}" not found.`, "warning");
            return;
          }
          chosen = found.name;
        }
      } else {
        const items = [
          ALL_SOURCES,
          ...collections.map(
            (c) => `${c.name}  (${c.memberCount} sources)${c.description ? ` — ${c.description}` : ""}`,
          ),
        ];
        const selected = await ctx.ui.select("Select a collection", items);
        if (selected === undefined) return;
        const idx = items.indexOf(selected);
        chosen = idx <= 0 ? null : collections[idx - 1].name;
      }

      // Apply to the shared context (mutated in place so tools see it).
      if (chosen === null) {
        buildCollectionFromDiscovery(collectionCtx, ctx.cwd);
      } else if (!loadCollectionInto(collectionCtx, ctx.cwd, chosen)) {
        ctx.ui.notify(`Collection "${chosen}" could not be loaded (missing or empty manifest).`, "warning");
        return;
      }
      saveSessionCollection(ctx.cwd, ctx.sessionManager.getSessionId(), chosen);

      // Tell the viewer the active collection (picker state) and preview the first member.
      emitActiveCollection(collectionCtx);
      const first = collectionCtx.members.values().next().value;
      if (first) {
        sendToExtension({
          type: "show_page",
          pageId: 1,
          totalPages: listPageIds(first.path).length,
          sourceDir: first.path,
          sourceName: basename(first.dataDir),
          bbox: null,
        });
      }

      const label = collectionCtx.name ?? ALL_SOURCES;
      pi.sendUserMessage(
        `Collection selected: "${label}" — ${collectionCtx.members.size} source(s). ` +
          `Pass a source ref (see the catalog) to page tools.`,
        { deliverAs: "followUp" },
      );
      ctx.ui.notify(`Collection: ${label} (${collectionCtx.members.size})`, "info");
    },
  });

  // ── /yolo command ──────────────────────────────────────────────────────

  pi.registerCommand("yolo", {
    description: "Toggle yolo mode — skip bash command confirmations",
    handler: async (_args, ctx) => {
      const settings = readWorkspaceSettings(ctx.cwd);
      const current = settings.yolo === true;
      settings.yolo = !current;
      writeWorkspaceSettings(ctx.cwd, settings);
      ctx.ui.notify(`Yolo mode ${settings.yolo ? "ON" : "OFF"}`, "info");
    },
  });

  // ── Lifecycle events ───────────────────────────────────────────────────

  // Rebuild this session's persisted expert (task/task_batch) conversations so
  // task_id follow-ups keep working across agent restarts and session resumes.
  const restoreExperts = async (ctx: ExtensionContext) => {
    try {
      const persisted = loadExpertTasks(ctx.cwd, ctx.sessionManager.getSessionId());
      if (persisted.length) await restoreExpertSessions(expertRegistry, ctx, persisted);
    } catch (err) {
      console.warn("[chronos] expert restore failed:", (err as Error).message);
    }
  };

  pi.on("session_start", async (event, ctx) => {
    ensureWorkspace(ctx.cwd);
    // .chronos/.env holds workspace API keys (e.g. GEMINI_API_KEY) — the
    // expert models read them from the environment (and we need them to
    // re-resolve expert models when restoring sessions).
    dotenvConfig({ path: join(ctx.cwd, ".chronos", ".env") });
    // session_start fires for the initial startup AND every switch/resume/fork
    // (0.79 folded the former session_switch event into this, distinguished by
    // event.reason). On a switch the in-memory experts belong to the previous
    // session — clear them before restoring the target session's state.
    if (event.reason !== "startup") {
      expertRegistry.sessions.clear();
      expertRegistry.nextId = 1;
    }
    // session_shutdown clears the viewer HTTP flag before each switch, so
    // (re)connect on every start. connectHttp is idempotent.
    connectHttp();
    // The collection auto-forms from the sources/ tree — cheap FS walk, rebuilt
    // fresh every start so switches/resumes never carry a stale catalog. If this
    // session had narrowed to a named collection, re-narrow to it (falling back
    // to all sources if that manifest is gone).
    buildCollectionFromDiscovery(collectionCtx, ctx.cwd);
    const savedCollection = loadSessionCollection(ctx.cwd, ctx.sessionManager.getSessionId());
    if (savedCollection && !loadCollectionInto(collectionCtx, ctx.cwd, savedCollection)) {
      console.warn(`[chronos] saved collection "${savedCollection}" not found; using all sources`);
    }
    // Re-add out-of-tree sources added via change_source this session.
    // buildCollectionFromDiscovery above wiped them, and a named-collection
    // restore does not know about them either.
    for (const sourcePath of loadSessionExtraMembers(ctx.cwd, ctx.sessionManager.getSessionId())) {
      if (!existsSync(join(sourcePath, "png"))) {
        console.warn(`[chronos] added source no longer has png/, skipping: ${sourcePath}`);
        continue;
      }
      const ref = deriveRef(ctx.cwd, sourcePath);
      if (collectionCtx.members.has(ref)) continue;
      collectionCtx.members.set(ref, {
        ref,
        path: sourcePath,
        dataDir: join(ctx.cwd, "data", dataKeyForRef(ref, sourcePath)),
      });
    }
    // Tell the viewer which collection is active so the picker reflects it.
    emitActiveCollection(collectionCtx);
    await restoreExperts(ctx);
  });

  pi.on("session_shutdown", async () => {
    disconnectHttp();
  });

  // Auto-generate a short session title from the user's prompts (once, cached in
  // a sidecar) so the history list shows something better than the truncated
  // first message. Best-effort and non-blocking: fire-and-forget so it never
  // delays the next prompt, and silently keeps the fallback on any failure.
  pi.on("agent_end", async (_event, ctx) => {
    void maybeNameSession(ctx);
  });

  // (No session_directory hook: pi >= 0.7x dropped it. Session storage is
  // redirected via the PI_CODING_AGENT_SESSION_DIR env var, set by the VS Code
  // extension when launching pi.)

  // ── System prompt injection (every turn) ───────────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    return { systemPrompt: buildChronosSystemPrompt(collectionCtx, ctx.cwd) };
  });

  // Note: chat/tool streaming (text deltas, tool start/end, turn end) reaches
  // the VS Code panel over RPC AgentEvents. HTTP carries only viewer events
  // (show_page / page_list / show_text from the viewer tools), so there are no
  // streaming hooks here.

  // ── Bash confirmation hook ─────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const settings = readWorkspaceSettings(ctx.cwd);
    if (settings.yolo === true) return;
    const approved = await ctx.ui.confirm(
      "Bash Command",
      `Allow: ${event.input.command}`,
    );
    if (!approved) {
      return { block: true, reason: "User denied bash command" };
    }
  });
}

// Tell the VS Code viewer which collection is active (picker state) and where its
// collection-level outputs (entity index) live, so the Data tab can surface them.
function emitActiveCollection(collectionCtx: CollectionContext): void {
  sendToExtension({ type: "collection", name: collectionCtx.name, dataDir: collectionDataDir(collectionCtx) });
}

// ── Session auto-naming ─────────────────────────────────────────────────────

function textOfMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: "text"; text: string } => (b as any)?.type === "text")
      .map((b) => b.text);
    if (parts.length) return parts.join(" ");
  }
  return undefined;
}

// Genuine user prompts from a session, in order. Skips the synthetic
// "Source selected: …" follow-up the /select-source command injects.
function userPromptsFromSession(entries: { type: string; [k: string]: any }[]): string[] {
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "user") continue;
    const text = textOfMessageContent(message.content)?.trim();
    if (!text || text.startsWith("Source selected:") || text.startsWith("Collection selected:")) continue;
    prompts.push(text);
  }
  return prompts;
}

// Refine the title over the first few prompts, then lock it, so a session named
// after one terse opener still gets a better label as its task takes shape.
const NAMING_PROMPT_CAP = 3;
// In-process guard so two near-simultaneous agent_end events don't both fire a
// generation before either has written its result.
const namingInFlight = new Set<string>();

// Generate-and-cache a display name for the current session from its user
// prompts, unless the user named it explicitly or it's already named from at
// least this many prompts. Never throws.
async function maybeNameSession(ctx: ExtensionContext): Promise<void> {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    if (ctx.sessionManager.getSessionName()) return; // user set a name explicitly
    if (namingInFlight.has(sessionId)) return; // a generation is already running
    const prompts = userPromptsFromSession(ctx.sessionManager.getEntries());
    if (prompts.length === 0) return;
    const target = Math.min(prompts.length, NAMING_PROMPT_CAP);
    if (getNamedPromptCount(ctx.cwd, sessionId) >= target) return; // already named from enough prompts

    namingInFlight.add(sessionId);
    try {
      const title = await generateSessionTitle(ctx.modelRegistry, prompts, ctx.model);
      if (title) saveSessionName(ctx.cwd, sessionId, title, target);
    } finally {
      namingInFlight.delete(sessionId);
    }
  } catch (err) {
    console.warn("[chronos] session auto-name failed:", (err as Error).message);
  }
}

// ── System prompt builder ──────────────────────────────────────────────

// Cap the rendered catalog so a large archive doesn't blow the system prompt.
// The full set stays resolvable via `resolveSource`; the table is a summary.
const ROSTER_ROW_CAP = 60;

// Render the active collection's catalog as a markdown table the agent can read
// to pick a `source` ref without a tool call.
function renderRoster(collectionCtx: CollectionContext): string {
  const members = [...collectionCtx.members.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  if (members.length === 0) {
    return "_No sources found. Add a directory containing a `png/` subfolder under `sources/`._";
  }
  const memoryDir = join(collectionCtx.workspaceDir, "memory");
  const shown = members.slice(0, ROSTER_ROW_CAP);
  const rows = shown.map((m) => {
    const pages = listPageIds(m.path).length;
    const meta =
      m.meta && Object.keys(m.meta).length > 0
        ? Object.entries(m.meta)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
    // ✓ when memory/<ref>.md exists, so the agent knows to read it before working the source.
    const mem = existsSync(join(memoryDir, `${m.ref}.md`)) ? "✓" : "";
    return `| \`${m.ref}\` | ${pages} | ${meta} | ${relative(collectionCtx.workspaceDir, m.dataDir)}/ | ${mem} |`;
  });
  const table = ["| source (ref) | pages | meta | data dir | mem |", "|---|---|---|---|---|", ...rows].join("\n");
  if (members.length > ROSTER_ROW_CAP) {
    return (
      table +
      `\n\n_…and ${members.length - ROSTER_ROW_CAP} more. Use \`list_pages(source)\` to inspect any source not listed._`
    );
  }
  return table;
}

function buildChronosSystemPrompt(collectionCtx: CollectionContext, cwd: string): string {
  const memoryDir = join(cwd, "memory");
  const skillsDir = join(cwd, "skills");
  const dataDir = join(cwd, "data");
  const template = readFileSync(join(PROMPTS_DIR, "system-prompt.md"), "utf-8");

  let globalMemory = "";
  const gmp = join(memoryDir, "MEMORY.MD");
  if (existsSync(gmp)) globalMemory = readFileSync(gmp, "utf-8").trim();

  // Collection memory: always-on tier for cross-source, long-horizon findings.
  const cmp = collectionMemoryPath(collectionCtx);
  let collectionMemory = "";
  if (existsSync(cmp)) collectionMemory = readFileSync(cmp, "utf-8").trim();

  return template
    .replaceAll("{{workspaceDir}}", cwd)
    .replaceAll("{{collectionName}}", collectionCtx.name ?? "(all sources)")
    .replaceAll("{{collectionDescription}}", collectionCtx.description ?? "")
    .replaceAll("{{sourceCount}}", String(collectionCtx.members.size))
    .replaceAll("{{collectionRoster}}", renderRoster(collectionCtx))
    .replaceAll("{{collectionDataDir}}", relative(cwd, collectionDataDir(collectionCtx)))
    .replaceAll("{{collectionMemoryPath}}", relative(cwd, cmp))
    .replaceAll("{{collectionMemory}}", collectionMemory || "_(empty — write cross-source findings here)_")
    .replaceAll("{{memoryDir}}", memoryDir)
    .replaceAll("{{skillsDir}}", skillsDir)
    .replaceAll("{{dataDir}}", dataDir)
    .replaceAll("{{globalMemory}}", globalMemory);
}
