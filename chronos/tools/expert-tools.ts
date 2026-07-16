/**
 * Tools the vision-expert subagents (task / task_batch) can call during a turn.
 *
 * Experts run a bounded agentic loop in `runExpertTurn`. By default they are
 * READ-ONLY — they can pull in more imagery and read the workspace, but cannot
 * change anything or run commands. The orchestrator may elevate a specific
 * expert by passing `grant` on the task/task_batch call (adding bash / write /
 * edit), but that path is gated behind a human confirmation (see view-page.ts /
 * task-batch.ts) and is off by default so expert work stays auditable.
 *
 * Separately, when a task is given an `output_file`, the expert also gets a
 * `save_output` tool scoped to that one pre-resolved path — the model never names
 * a path, so it needs no grant. That is how structured output is written now (the
 * caller no longer captures the model's raw text).
 *
 * The `Tool` shape pi-ai consumes is only `{ name, description, parameters }` —
 * execution is the caller's job, handled by `executeExpertTool` below.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ImageContent, TextContent, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Bbox } from "../utils/crop-image.js";
import { pageImageContent } from "./expert-turn.js";

const execAsync = promisify(exec);

/** Capabilities the orchestrator can grant beyond read-only (human-gated). */
export type ExpertCapability = "bash" | "write" | "edit";

const MAX_READ_CHARS = 100_000;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILES = 3000;
const BASH_TIMEOUT_MS = 30_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".chronos", "png", "dist", "out"]);

const bboxSchema = Type.Object({
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
  w: Type.Number({ minimum: 0, maximum: 1 }),
  h: Type.Number({ minimum: 0, maximum: 1 }),
});

// ── Read-only tools (always available) ──────────────────────────────────────

const VIEW_REGION_TOOL: Tool = {
  name: "view_region",
  description:
    "Zoom into a sub-region of a page at full resolution. Use this to read dense tables, " +
    "marginalia, or faint/damaged ink that is too small in the full-page view. bbox is the " +
    "crop in normalized coordinates (0–1): x/y is the top-left corner, w/h is width/height. " +
    "page_id is optional — omit it to zoom into the page you are currently looking at.",
  parameters: Type.Object({
    bbox: bboxSchema,
    page_id: Type.Optional(
      Type.Number({ description: "Page to crop (file-system index). Omit to use the current page." }),
    ),
  }),
};

const VIEW_PAGE_TOOL: Tool = {
  name: "view_page",
  description:
    "Load another full page from the same source into the conversation — e.g. to compare with a " +
    "neighbouring page or follow a record that continues overleaf. page_id is the file-system index " +
    "(1 = page_0001.png), not the printed page number.",
  parameters: Type.Object({
    page_id: Type.Number({ description: "Page to load (file-system index)." }),
  }),
};

const READ_FILE_TOOL: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace (read-only). Use for schemas, notes, memory, or " +
    "previously-extracted data. path is relative to the workspace root; it must stay inside the workspace.",
  parameters: Type.Object({ path: Type.String({ description: "Workspace-relative file path." }) }),
};

const LIST_DIR_TOOL: Tool = {
  name: "list_dir",
  description:
    "List the entries of a workspace directory (read-only). path is relative to the workspace root " +
    "(omit for the root). Directories are suffixed with '/'.",
  parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Workspace-relative directory." })) }),
};

const GREP_TOOL: Tool = {
  name: "grep",
  description:
    "Search workspace text files for a pattern (read-only). pattern is a regular expression (falls back " +
    "to a literal substring if it isn't valid regex). Returns up to 100 matches as path:line: text. " +
    "Optional path narrows the search to a subdirectory. Skips binaries and bulky dirs (png/, node_modules/, …).",
  parameters: Type.Object({
    pattern: Type.String({ description: "Regex or substring to search for." }),
    path: Type.Optional(Type.String({ description: "Workspace-relative subdirectory to search (default: whole workspace)." })),
  }),
};

// ── Elevated tools (only added when granted + human-approved) ────────────────

const BASH_TOOL: Tool = {
  name: "bash",
  description:
    "Run a shell command in the workspace directory and return its output. Only available when the " +
    "orchestrator granted this expert the \"bash\" capability (which the user approved).",
  parameters: Type.Object({ command: Type.String({ description: "Shell command to run." }) }),
};

const WRITE_FILE_TOOL: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a workspace text file. Only available when the orchestrator granted the " +
    "\"write\" capability (user-approved). path is workspace-relative and must stay inside the workspace.",
  parameters: Type.Object({
    path: Type.String({ description: "Workspace-relative file path." }),
    content: Type.String({ description: "Full file contents." }),
  }),
};

const EDIT_FILE_TOOL: Tool = {
  name: "edit_file",
  description:
    "Replace text in a workspace file. Only available when the orchestrator granted the \"edit\" " +
    "capability (user-approved). old_text must occur in the file; every occurrence is replaced.",
  parameters: Type.Object({
    path: Type.String({ description: "Workspace-relative file path." }),
    old_text: Type.String({ description: "Exact text to replace (must be present)." }),
    new_text: Type.String({ description: "Replacement text." }),
  }),
};

const ELEVATED_TOOLS: Record<ExpertCapability, Tool> = {
  bash: BASH_TOOL,
  write: WRITE_FILE_TOOL,
  edit: EDIT_FILE_TOOL,
};

// ── Output tool (only added when the task was given an output_file) ───────────
// Not an elevated capability: it can only ever touch the one pre-resolved output
// path (the model never names a path), so it is auditable by construction and
// needs no `grant`/human confirmation.

const SAVE_OUTPUT_TOOL: Tool = {
  name: "save_output",
  description:
    "Write your final result to this task's output file. Pass the COMPLETE content (e.g. a JSON " +
    "array of records) — it replaces the file, so call it again with corrected content to revise. " +
    "Your chat reply is for reasoning only and is NOT saved; the output file holds only what you " +
    "pass here. If the output file is JSON, `content` must be valid JSON or the write is rejected " +
    "and you must retry.",
  parameters: Type.Object({ content: Type.String({ description: "Full contents to write to the output file." }) }),
};

/** The tool set an expert is left with once its exploratory budget is spent but
 *  an output_file is still owed — only save_output, so it can fulfill the contract. */
export function outputOnlyTools(): Tool[] {
  return [SAVE_OUTPUT_TOOL];
}

const ELEVATED_TOOL_NAMES: Record<string, ExpertCapability> = {
  bash: "bash",
  write_file: "write",
  edit_file: "edit",
};

/**
 * The tools an expert sees this turn: read-only file/search tools always, the
 * image tools only when the model can consume images, and the elevated tools
 * only for capabilities the orchestrator granted (and the user approved).
 */
export function buildExpertTools(opts: {
  vision: boolean;
  hasSource: boolean;
  granted: ExpertCapability[];
  output: boolean;
}): Tool[] {
  const tools: Tool[] = [];
  if (opts.vision && opts.hasSource) tools.push(VIEW_REGION_TOOL, VIEW_PAGE_TOOL);
  tools.push(READ_FILE_TOOL, LIST_DIR_TOOL, GREP_TOOL);
  for (const cap of opts.granted) {
    const tool = ELEVATED_TOOLS[cap];
    if (tool && !tools.includes(tool)) tools.push(tool);
  }
  if (opts.output) tools.push(SAVE_OUTPUT_TOOL);
  return tools;
}

/**
 * Resolve an `image` path for a task/task_batch call. Like resolveInWorkspace it
 * keeps the target inside the workspace, but deliberately does NOT apply the
 * restricted-dir filter: page images legitimately live under png/, and the
 * anti-secret-leak rationale doesn't apply here because the target must decode
 * as an image (a .env won't). workspaceRoot is the pi cwd / workspace dir.
 */
export function resolveImagePath(workspaceRoot: string, p: string): string {
  const abs = resolve(workspaceRoot, p);
  const rel = relative(workspaceRoot, abs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Image path is outside the workspace.");
  }
  return abs;
}

export interface ExpertToolImageRef {
  pageId: number;
  bbox?: Bbox;
  sourceDir: string;
}

/** A tool result captured for persistence: text plus an optional re-hydratable image. */
export interface PersistedToolResult {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  /** Short human label for oversight (command run, file path, …). */
  detail?: string;
  image?: ExpertToolImageRef;
}

export interface ExpertToolContext {
  sourceDir: string | undefined;
  currentPageId: number | null;
  /** Workspace root — read/search/write/edit/bash are scoped to it. */
  cwd: string;
  /** Capabilities the orchestrator granted (and the user approved) for this expert. */
  granted: ReadonlySet<ExpertCapability>;
  /** Absolute path save_output writes to, pre-resolved by the caller from output_file
   *  (undefined when the task has no output_file — save_output is then not offered). */
  outputPath?: string;
}

export interface ExpertToolOutcome {
  message: ToolResultMessage;
  persist: PersistedToolResult;
  /** Page the expert is now looking at, so a later view_region can default to it. */
  viewedPageId?: number;
  /** Set when a save_output call successfully wrote the output file this turn. */
  wroteOutput?: boolean;
}

function coerceBbox(value: unknown): Bbox | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (["x", "y", "w", "h"].every((k) => typeof o[k] === "number")) {
    return { x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number };
  }
  return null;
}

// Resolve a workspace-relative path and refuse anything that escapes the root or
// reaches into a restricted directory. Mirrors walkFiles' policy (dot-dirs and
// SKIP_DIRS are off-limits) so the always-on read_file/list_dir/grep tools can't
// read workspace secrets such as .chronos/.env, which the walk path already skips.
function resolveInWorkspace(cwd: string, p: string): string {
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path is outside the workspace.");
  }
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith(".") || SKIP_DIRS.has(seg))) {
    throw new Error("Path is in a restricted directory.");
  }
  return abs;
}

function* walkFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      yield* walkFiles(join(dir, e.name), depth + 1);
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

/**
 * Execute one expert tool call. Never throws: bad args / missing files / denied
 * capabilities come back as `isError` tool results so the loop can feed them to
 * the model and let it recover (and they count toward the iteration cap).
 */
export async function executeExpertTool(call: ToolCall, ctx: ExpertToolContext): Promise<ExpertToolOutcome> {
  const base = { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, timestamp: Date.now() };
  const fail = (text: string, detail?: string): ExpertToolOutcome => ({
    message: { ...base, content: [{ type: "text", text }], isError: true },
    persist: { toolCallId: call.id, toolName: call.name, isError: true, text, detail },
  });
  const text = (body: string, detail?: string, isError = false): ExpertToolOutcome => ({
    message: { ...base, content: [{ type: "text", text: body }], isError },
    persist: { toolCallId: call.id, toolName: call.name, isError, text: body, detail },
  });

  // Defense in depth: never run an elevated tool the orchestrator didn't grant.
  const requiredCap = ELEVATED_TOOL_NAMES[call.name];
  if (requiredCap && !ctx.granted.has(requiredCap)) {
    return fail(`The "${call.name}" tool is not permitted (the "${requiredCap}" capability was not granted to this expert).`);
  }

  const args = (call.arguments ?? {}) as Record<string, unknown>;

  switch (call.name) {
    case "view_page":
    case "view_region": {
      if (!ctx.sourceDir) return fail("No source is active, so page imagery cannot be loaded.");
      const isRegion = call.name === "view_region";
      let bbox: Bbox | undefined;
      if (isRegion) {
        const parsed = coerceBbox(args.bbox);
        if (!parsed) return fail("view_region requires bbox as { x, y, w, h }, each normalized 0–1.");
        bbox = parsed;
      }
      const rawPage = args.page_id;
      const pageId = rawPage !== undefined && rawPage !== null ? Math.round(Number(rawPage)) : ctx.currentPageId;
      if (pageId === null || !Number.isFinite(pageId)) {
        return fail(`${call.name} needs a page_id (no page is currently in view).`);
      }
      try {
        const image: ImageContent = await pageImageContent(ctx.sourceDir, pageId, bbox);
        const note = isRegion ? `Zoomed into the requested region of page ${pageId}.` : `Loaded page ${pageId}.`;
        const content: (ImageContent | TextContent)[] = [image, { type: "text", text: note }];
        return {
          message: { ...base, content, isError: false },
          persist: {
            toolCallId: call.id,
            toolName: call.name,
            isError: false,
            text: note,
            image: { pageId, bbox, sourceDir: ctx.sourceDir },
          },
          viewedPageId: pageId,
        };
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    case "read_file": {
      const p = String(args.path ?? "");
      if (!p) return fail("read_file requires a path.");
      try {
        const abs = resolveInWorkspace(ctx.cwd, p);
        let body = readFileSync(abs, "utf-8");
        if (body.length > MAX_READ_CHARS) body = body.slice(0, MAX_READ_CHARS) + "\n…[truncated]";
        return text(body || "(empty file)", p);
      } catch (e) {
        return fail(`read_file failed: ${(e as Error).message}`, p);
      }
    }

    case "list_dir": {
      const p = String(args.path ?? "");
      try {
        const abs = p ? resolveInWorkspace(ctx.cwd, p) : ctx.cwd;
        const entries = readdirSync(abs, { withFileTypes: true })
          .filter((e) => !(e.name.startsWith(".") || SKIP_DIRS.has(e.name)))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return text(entries.join("\n") || "(empty directory)", p || ".");
      } catch (e) {
        return fail(`list_dir failed: ${(e as Error).message}`, p || ".");
      }
    }

    case "grep": {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return fail("grep requires a pattern.");
      const sub = String(args.path ?? "");
      let root: string;
      try {
        root = sub ? resolveInWorkspace(ctx.cwd, sub) : ctx.cwd;
      } catch (e) {
        return fail(`grep failed: ${(e as Error).message}`, pattern);
      }
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
      const matches: string[] = [];
      let scanned = 0;
      outer: for (const file of walkFiles(root)) {
        if (++scanned > MAX_GREP_FILES) break;
        let content: string;
        try {
          if (statSync(file).size > 2_000_000) continue;
          content = readFileSync(file, "utf-8");
        } catch {
          continue;
        }
        if (content.includes("\u0000")) continue; // binary
        const rel = relative(ctx.cwd, file);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (matches.length >= MAX_GREP_MATCHES) break outer;
          }
        }
      }
      const body = matches.length ? matches.join("\n") : "(no matches)";
      return text(body, `"${pattern}"${sub ? ` in ${sub}` : ""}`);
    }

    case "bash": {
      const command = String(args.command ?? "");
      if (!command) return fail("bash requires a command.", command);
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.cwd,
          timeout: BASH_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
        });
        const out = [stdout, stderr].filter(Boolean).join("\n").trim();
        return text(out || "(no output)", command);
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        const out = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
        return text(out || "(command failed)", command, true);
      }
    }

    case "write_file": {
      const p = String(args.path ?? "");
      const content = typeof args.content === "string" ? args.content : "";
      if (!p) return fail("write_file requires a path.");
      try {
        const abs = resolveInWorkspace(ctx.cwd, p);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf-8");
        return text(`Wrote ${p} (${content.length} chars).`, p);
      } catch (e) {
        return fail(`write_file failed: ${(e as Error).message}`, p);
      }
    }

    case "edit_file": {
      const p = String(args.path ?? "");
      const oldText = String(args.old_text ?? "");
      const newText = typeof args.new_text === "string" ? args.new_text : "";
      if (!p) return fail("edit_file requires a path.");
      if (!oldText) return fail("edit_file requires old_text.", p);
      try {
        const abs = resolveInWorkspace(ctx.cwd, p);
        const before = readFileSync(abs, "utf-8");
        if (!before.includes(oldText)) return fail(`edit_file: old_text not found in ${p}.`, p);
        const count = before.split(oldText).length - 1;
        writeFileSync(abs, before.split(oldText).join(newText), "utf-8");
        return text(`Edited ${p} (${count} replacement${count === 1 ? "" : "s"}).`, p);
      } catch (e) {
        return fail(`edit_file failed: ${(e as Error).message}`, p);
      }
    }

    case "save_output": {
      if (!ctx.outputPath) {
        return fail('save_output is not available (this task was not given an output_file).');
      }
      const content = typeof args.content === "string" ? args.content : "";
      const rel = relative(ctx.cwd, ctx.outputPath);
      // For JSON targets, validate before writing so malformed content bounces
      // back to the expert to fix instead of landing invalid on disk. This is the
      // whole point of the tool: no fences/prose ever reach a .json file.
      if (ctx.outputPath.toLowerCase().endsWith(".json")) {
        try {
          JSON.parse(content);
        } catch (e) {
          return fail(
            `save_output: content is not valid JSON (${(e as Error).message}). ` +
              "Nothing was written — call save_output again with corrected content.",
            rel,
          );
        }
      }
      try {
        mkdirSync(dirname(ctx.outputPath), { recursive: true });
        writeFileSync(ctx.outputPath, content, "utf-8");
      } catch (e) {
        return fail(`save_output failed: ${(e as Error).message}`, rel);
      }
      const note = `Saved ${content.length} chars to ${rel}.`;
      return {
        message: { ...base, content: [{ type: "text", text: note }], isError: false },
        persist: { toolCallId: call.id, toolName: call.name, isError: false, text: note, detail: rel },
        wroteOutput: true,
      };
    }

    default:
      return fail(`Unknown tool "${call.name}".`);
  }
}

/** Rebuild a persisted tool result on session restore, re-cropping its image from disk. */
export async function rehydrateToolResult(tr: PersistedToolResult): Promise<ToolResultMessage> {
  const content: (ImageContent | TextContent)[] = [];
  if (tr.image) {
    try {
      content.push(await pageImageContent(tr.image.sourceDir, tr.image.pageId, tr.image.bbox));
    } catch {
      // page/source no longer on disk — restore text-only
    }
  }
  content.push({ type: "text", text: tr.text });
  return {
    role: "toolResult",
    toolCallId: tr.toolCallId,
    toolName: tr.toolName,
    content,
    isError: tr.isError,
    timestamp: Date.now(),
  };
}
