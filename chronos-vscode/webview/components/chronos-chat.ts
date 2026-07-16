import { LitElement, html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderMarkdown, parseViewLinkElement } from "../markdown";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  RpcSessionState,
  RpcSlashCommand,
} from "../../src/rpc/rpc-types";
import type { WebviewToExt } from "../../src/panel/webview-protocol";

type ToolItem = {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  args: any;
  result?: any;
  isError?: boolean;
  running: boolean;
};

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; message: AssistantMessage; streaming: boolean }
  | ToolItem
  | { kind: "info"; text: string }
  | { kind: "compaction"; summary: string; tokensBefore?: number };

// Render-time blocks: consecutive tool calls + reasoning collapse into one
// activity group; prose text stays prominent.
type ActivityStep =
  | { kind: "tool"; item: ToolItem }
  | { kind: "thinking"; text: string };

type RenderBlock =
  | { kind: "group"; key: string; steps: ActivityStep[] }
  | { kind: "prose"; key: string; text: string; streaming: boolean }
  | { kind: "user"; key: string; text: string; itemIndex: number }
  | { kind: "info"; key: string; text: string }
  | { kind: "error"; key: string; text: string }
  | { kind: "compaction"; key: string; summary: string; tokensBefore?: number }
  // expert subagent call (`task` tool) — rendered as a standalone live card,
  // opencode-style, instead of being buried in an activity group
  | { kind: "expert"; key: string; item: ToolItem }
  // batch subagent call (`task_batch`) — one card listing the N experts it spawned
  | { kind: "expertBatch"; key: string; item: ToolItem };

// A tool the expert invoked during a turn (view_region / view_page), surfaced
// from the task/task_batch result so the drawer can show what it inspected.
interface ExpertToolUse {
  tool: string;
  pageId?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  detail?: string;
  isError: boolean;
}

// One reconstructed turn of an expert conversation, gathered from `task` calls
// and/or the first turn embedded in a `task_batch` result.
interface ExpertTurn {
  prompt: string;
  pageId?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  reply: string;
  running: boolean;
  isError: boolean;
  toolUses?: ExpertToolUse[];
  /** Workspace-relative source path so this turn's page/region chips open the
   *  expert's own source, not whichever was shown last. */
  source?: string;
}

const SOURCE_SELECTED_RE = /^Source selected: "([^"]+)"/;

// Slash command names may arrive with a leading "/" (extension commands use
// their invocation name); strip it so display and matching are consistent.
function bareName(cmd: RpcSlashCommand): string {
  return cmd.name.replace(/^\//, "");
}

function messageText(content: string | { type: string; [key: string]: any }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

// A view a chat entry can re-open in the viewer (the agent showed it earlier).
type ViewRef =
  | { kind: "page"; pageId: number; bbox: { x: number; y: number; w: number; h: number } | null; source?: string }
  | { kind: "text"; filePath: string; highlight: string | null };

// Tool calls that drove the page viewer carry enough in their args to re-open
// the same view later — even from inside a collapsed activity group.
function viewRefFromTool(item: ToolItem): ViewRef | null {
  const a: any = item.args ?? {};
  if (item.toolName === "show_page" && typeof a.page_id === "number") {
    const source = (item.result as any)?.details?.source;
    return { kind: "page", pageId: a.page_id, bbox: a.bbox ?? null, source: typeof source === "string" ? source : undefined };
  }
  if (item.toolName === "show_text" && typeof a.file_path === "string") {
    return { kind: "text", filePath: a.file_path, highlight: a.highlight ?? null };
  }
  return null;
}

function resultText(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  if (Array.isArray(result)) {
    return result
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return JSON.stringify(result, null, 2);
}

// ── expert subagent helpers (`task` tool) ──────────────────────────────────
// Every task result ends with a "task_id: task-N" trailer; details carry
// { taskId, model } when available. History fallback parses the trailer.

const TASK_TRAILER_RE = /\n?task_id:\s*(task-\d+)\s*$/;
// A reply that attached a page starts with its view link(s) on one line.
const LEADING_VIEW_LINKS_RE = /^(\[view p\.[^\]]*\]\s*)+\n?/;

function taskMeta(item: ToolItem): { taskId?: string; model?: string } {
  const details = (item.result as any)?.details;
  const trailer = TASK_TRAILER_RE.exec(resultText(item.result));
  return {
    taskId: details?.taskId ?? item.args?.task_id ?? (trailer ? trailer[1] : undefined),
    model: details?.model ?? item.args?.model,
  };
}

/** Expert reply text without the task_id trailer (view links kept). */
function taskReplyText(item: ToolItem): string {
  return resultText(item.result).replace(TASK_TRAILER_RE, "").trim();
}

interface BatchExpertEntry {
  taskId?: string;
  page_id: number;
  /** queued/running only appear in live (partial) results while the batch runs. */
  status: "queued" | "running" | "ok" | "error";
  response?: string;
  file?: string;
  error?: string;
  toolUses?: ExpertToolUse[];
  /** Live activity line for a running expert (e.g. "view_region · 3 tool calls"). */
  activity?: string;
}

/** Read a task_batch tool result's details (streamed live while it runs). */
function batchDetails(item: ToolItem): {
  model?: string;
  prompt: string;
  bbox?: { x: number; y: number; w: number; h: number };
  source?: string;
  experts: BatchExpertEntry[];
} {
  const d = (item.result as any)?.details ?? {};
  return {
    model: d.model,
    prompt: typeof d.prompt === "string" ? d.prompt : "",
    bbox: d.bbox ?? undefined,
    source: typeof d.source === "string" ? d.source : undefined,
    experts: Array.isArray(d.experts) ? d.experts : [],
  };
}

// Human summaries for the chronos tools; anything unknown gets a generic card.
function toolSummary(item: ToolItem): { label: string; detail: string } {
  const args = item.args ?? {};
  switch (item.toolName) {
    case "task": {
      if (args.task_id) {
        return { label: `Follow-up to ${args.task_id}`, detail: args.prompt ?? "" };
      }
      const label = args.page_id != null ? `Examining page ${args.page_id}` : "Asking expert";
      return { label, detail: args.prompt ?? "" };
    }
    case "show_page":
      return { label: `Showing page ${args.page_id ?? args.page ?? "?"}`, detail: "" };
    case "show_text":
      return { label: "Showing text", detail: String(args.path ?? args.filePath ?? "") };
    case "list_pages":
      return { label: "Listing pages", detail: "" };
    case "change_source":
      return { label: `Switching source`, detail: String(args.source ?? args.name ?? "") };
    case "bash":
      return { label: "Running command", detail: String(args.command ?? "") };
    case "read":
      return { label: "Reading file", detail: String(args.path ?? args.file_path ?? "") };
    case "write":
      return { label: "Writing file", detail: String(args.path ?? args.file_path ?? "") };
    case "edit":
      return { label: "Editing file", detail: String(args.path ?? args.file_path ?? "") };
    case "grep":
    case "find":
      return { label: `Searching (${item.toolName})`, detail: String(args.pattern ?? args.query ?? "") };
    default:
      return { label: item.toolName.replace(/_/g, " "), detail: "" };
  }
}

export class ChronosChat extends LitElement {
  static properties = {
    items: { state: true },
    running: { state: true },
    exited: { state: true },
    permissionQueue: { state: true },
    visibleLimit: { state: true },
    editing: { state: true },
    openExpert: { state: true },
    commands: { state: true },
    menuOpen: { state: true },
    menuQuery: { state: true },
    menuActive: { state: true },
  };

  declare items: ChatItem[];
  declare running: boolean;
  declare exited: { code: number | null; stderr: string } | null;
  declare permissionQueue: { id: string; command: string; suggestedPrefix: string }[];
  declare visibleLimit: number;
  declare editing: { itemIndex: number } | null;
  declare openExpert: string | null;
  declare commands: RpcSlashCommand[];
  declare menuOpen: boolean;
  declare menuQuery: string;
  declare menuActive: number;

  private postMessage: (msg: WebviewToExt) => void = () => {};
  private pinnedToBottom = true;

  constructor() {
    super();
    this.items = [];
    this.running = false;
    this.exited = null;
    this.permissionQueue = [];
    this.visibleLimit = 120;
    this.editing = null;
    this.openExpert = null;
    this.commands = [];
    this.menuOpen = false;
    this.menuQuery = "";
    this.menuActive = 0;
    this.onGlobalKeydown = this.onGlobalKeydown.bind(this);
  }

  private confirmEdit(itemIndex: number): void {
    const textarea = this.querySelector<HTMLTextAreaElement>("#edit-input");
    const item = this.items[itemIndex];
    if (!textarea || item?.kind !== "user") return;
    const newText = textarea.value.trim();
    this.editing = null;
    if (!newText) return;
    // Disambiguate identical texts by occurrence among user items
    let occurrence = 0;
    for (let i = 0; i < itemIndex; i++) {
      const prev = this.items[i];
      if (prev.kind === "user" && prev.text.trim() === item.text.trim()) occurrence++;
    }
    this.dispatchEvent(
      new CustomEvent("rewind-start", { bubbles: true, detail: { preview: newText } }),
    );
    this.postMessage({
      type: "editMessage",
      originalText: item.text,
      occurrence,
      newText,
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onGlobalKeydown);
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onGlobalKeydown);
    super.disconnectedCallback();
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  setPostMessage(fn: (msg: WebviewToExt) => void): void {
    this.postMessage = fn;
  }

  applyState(rpcState: RpcSessionState): void {
    this.running = rpcState.isStreaming;
  }

  private pushUserItem(text: string): void {
    // The source selector injects a long instruction as a user message;
    // render it as a quiet system note instead of a speech bubble.
    const sourceMatch = SOURCE_SELECTED_RE.exec(text);
    if (sourceMatch) {
      this.items = [...this.items, { kind: "info", text: `Source selected: ${sourceMatch[1]}` }];
    } else {
      this.items = [...this.items, { kind: "user", text }];
    }
  }

  loadHistory(messages: AgentMessage[]): void {
    const items: ChatItem[] = [];
    const toolArgs = new Map<string, any>();
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = messageText(msg.content);
        if (!text.trim()) continue;
        const sourceMatch = SOURCE_SELECTED_RE.exec(text);
        if (sourceMatch) {
          items.push({ kind: "info", text: `Source selected: ${sourceMatch[1]}` });
        } else {
          items.push({ kind: "user", text });
        }
      } else if (msg.role === "assistant") {
        const assistantMsg = msg as AssistantMessage;
        items.push({ kind: "assistant", message: assistantMsg, streaming: false });
        for (const block of assistantMsg.content) {
          if (block.type === "toolCall") toolArgs.set(block.id, block.arguments);
        }
      } else if (msg.role === "toolResult") {
        items.push({
          kind: "tool",
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          args: toolArgs.get(msg.toolCallId),
          // keep details (taskId/model for expert calls) alongside the content
          result: { content: msg.content, details: msg.details },
          isError: msg.isError,
          running: false,
        });
      } else if (msg.role === "compaction_marker") {
        items.push({
          kind: "compaction",
          summary: String((msg as any).summary ?? ""),
          tokensBefore: (msg as any).tokensBefore,
        });
      }
    }
    this.items = items;
    this.visibleLimit = 120;
    this.pinnedToBottom = true;
  }

  handleAgentExited(code: number | null, stderr: string): void {
    this.running = false;
    this.exited = { code, stderr };
  }

  handleAgentRestarted(): void {
    this.exited = null;
    this.items = [...this.items, { kind: "info", text: "Agent restarted" }];
  }

  addPermissionRequest(req: { id: string; command: string; suggestedPrefix: string }): void {
    this.permissionQueue = [...this.permissionQueue, req];
  }

  private answerPermission(action: "allow" | "always" | "deny"): void {
    const req = this.permissionQueue[0];
    if (!req) return;
    this.permissionQueue = this.permissionQueue.slice(1);
    this.postMessage({
      type: "permissionResponse",
      id: req.id,
      action,
      prefix: action === "always" ? req.suggestedPrefix : undefined,
    });
  }

  private onGlobalKeydown(e: KeyboardEvent): void {
    if (this.openExpert && e.key === "Escape") {
      e.preventDefault();
      this.openExpert = null;
      return;
    }
    if (this.permissionQueue.length === 0) return;
    // While a request is pending the agent is blocked anyway, so Enter/Esc
    // can safely answer the card instead of the composer.
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      this.answerPermission("allow");
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.answerPermission("deny");
    }
  }

  handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        break;
      case "agent_end":
        this.running = false;
        this.items = this.items.map((item) =>
          item.kind === "assistant" ? { ...item, streaming: false } : item,
        );
        break;
      case "message_start": {
        const msg = event.message;
        if (msg.role === "assistant") {
          this.items = [...this.items, { kind: "assistant", message: msg as AssistantMessage, streaming: true }];
        } else if (msg.role === "user") {
          const text = messageText((msg as { content: any }).content);
          const last = [...this.items].reverse().find((item) => item.kind === "user");
          if (text.trim() && (!last || last.text !== text)) {
            this.pushUserItem(text);
          }
        }
        break;
      }
      case "message_update":
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        let idx = -1;
        for (let i = this.items.length - 1; i >= 0; i--) {
          if (this.items[i].kind === "assistant") {
            idx = i;
            break;
          }
        }
        const streaming = event.type !== "message_end";
        if (idx === -1) {
          this.items = [...this.items, { kind: "assistant", message, streaming }];
        } else {
          const items = [...this.items];
          items[idx] = { kind: "assistant", message, streaming };
          this.items = items;
        }
        break;
      }
      case "tool_execution_start":
        this.items = [
          ...this.items,
          { kind: "tool", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, running: true },
        ];
        break;
      case "tool_execution_update": {
        const items = [...this.items];
        const idx = items.findIndex((item) => item.kind === "tool" && item.toolCallId === event.toolCallId);
        if (idx !== -1) {
          items[idx] = { ...(items[idx] as ToolItem), result: event.partialResult };
          this.items = items;
        }
        break;
      }
      case "tool_execution_end": {
        const items = [...this.items];
        const idx = items.findIndex((item) => item.kind === "tool" && item.toolCallId === event.toolCallId);
        if (idx !== -1) {
          items[idx] = {
            ...(items[idx] as ToolItem),
            result: event.result,
            isError: event.isError,
            running: false,
          };
          this.items = items;
        }
        break;
      }
    }
  }

  // ── test seam ───────────────────────────────────────────────────────────
  // Mirrors a real composer submit (used by integration tests).
  testSubmit(text: string): void {
    if (!text) return;
    this.items = [...this.items, { kind: "user", text }];
    this.postMessage({ type: "prompt", text });
  }

  testSnapshot(): {
    itemCount: number;
    userCount: number;
    toolNames: string[];
    lastAssistant: string;
    running: boolean;
    expertOpen: string | null;
    expertToolLinks: number;
    expertToolChips: number;
    expertElevatedChips: number;
  } {
    const assistant = [...this.items].reverse().find((i) => i.kind === "assistant") as
      | { kind: "assistant"; message: AssistantMessage }
      | undefined;
    return {
      itemCount: this.items.length,
      userCount: this.items.filter((i) => i.kind === "user").length,
      toolNames: this.items.filter((i) => i.kind === "tool").map((i) => (i as ToolItem).toolName),
      lastAssistant: assistant ? messageText(assistant.message.content) : "",
      running: this.running,
      expertOpen: this.openExpert,
      // Oversight chips for the expert's own tool calls, in the open drawer.
      expertToolLinks: this.querySelectorAll(".expert-turn-tools a.view-link").length,
      expertToolChips: this.querySelectorAll(".expert-turn-tools .expert-tool").length,
      expertElevatedChips: this.querySelectorAll(".expert-turn-tools .expert-tool.is-elevated").length,
    };
  }

  // Test seam: inject a synthetic expert (task) call whose result carries
  // tool-use oversight data, and open its drawer — exercises the expert
  // tool-link rendering end-to-end without a live model.
  testInjectExpertWithTools(): void {
    this.items = [
      {
        kind: "tool",
        toolCallId: "tc-expert",
        toolName: "task",
        args: { prompt: "Read the marriage entries on this page.", page_id: 42 },
        result: {
          content: [{ type: "text", text: "Found 3 entries.\ntask_id: task-1" }],
          details: {
            taskId: "task-1",
            model: "anthropic/claude-opus-4-8",
            toolUses: [
              { tool: "view_region", pageId: 42, bbox: { x: 0.1, y: 0.3, w: 0.8, h: 0.1 }, isError: false },
              { tool: "view_page", pageId: 43, isError: false },
              { tool: "grep", detail: '"Müller" in data', isError: false },
              { tool: "bash", detail: "wc -l data/entries.json", isError: false },
            ],
          },
        },
        isError: false,
        running: false,
      },
    ];
    this.openExpert = "task-1";
  }

  private sendPrompt(): void {
    const input = this.querySelector<HTMLTextAreaElement>("#composer-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    this.menuOpen = false;
    this.items = [...this.items, { kind: "user", text }];
    this.pinnedToBottom = true;
    this.postMessage({ type: "prompt", text });
  }

  setCommands(commands: RpcSlashCommand[]): void {
    this.commands = commands;
  }

  // Commands matching the current "/" query. Empty unless the menu is open.
  // Prefix matches rank above substring matches. All matches are returned (the
  // menu scrolls) — capping here silently hid late-sorting entries like skills.
  private filteredCommands(): RpcSlashCommand[] {
    if (!this.menuOpen) return [];
    const q = this.menuQuery.toLowerCase();
    const scored = this.commands
      .map((cmd) => {
        const name = bareName(cmd).toLowerCase();
        const idx = name.indexOf(q);
        return { cmd, rank: idx === 0 ? 0 : idx > 0 ? 1 : -1 };
      })
      .filter((s) => s.rank >= 0);
    scored.sort((a, b) => a.rank - b.rank || bareName(a.cmd).localeCompare(bareName(b.cmd)));
    return scored.map((s) => s.cmd);
  }

  // Insert "/command " into the composer for the user to add args and send.
  private applyCommand(cmd: RpcSlashCommand): void {
    const input = this.querySelector<HTMLTextAreaElement>("#composer-input");
    if (!input) return;
    input.value = `/${bareName(cmd)} `;
    this.menuOpen = false;
    this.menuQuery = "";
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  private onComposerKeydown(e: KeyboardEvent): void {
    const filtered = this.filteredCommands();
    if (this.menuOpen && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.menuActive = (this.menuActive + 1) % filtered.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.menuActive = (this.menuActive - 1 + filtered.length) % filtered.length;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        this.applyCommand(filtered[Math.min(this.menuActive, filtered.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.menuOpen = false;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && this.permissionQueue.length === 0) {
      e.preventDefault();
      this.sendPrompt();
    }
  }

  private onComposerInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
    // Slash-command autocomplete: only while typing the command name (a bare
    // "/word" with no space yet) — once args begin, get out of the way.
    const match = /^\/(\S*)$/.exec(ta.value);
    if (match) {
      this.menuQuery = match[1];
      this.menuActive = 0;
      this.menuOpen = true;
    } else {
      this.menuOpen = false;
    }
  }

  private onLogClick(e: MouseEvent): void {
    const link = (e.target as HTMLElement).closest<HTMLElement>("a.view-link");
    if (!link) return;
    e.preventDefault();
    const data = parseViewLinkElement(link);
    if (data) {
      this.postMessage({ type: "openViewLink", pageId: data.pageId, bbox: data.bbox, sourcePath: data.sourcePath });
    }
  }

  private onLogScroll(): void {
    const log = this.querySelector("#chat-log");
    if (!log) return;
    this.pinnedToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  protected updated(): void {
    if (this.menuOpen) {
      this.querySelector(".command-item.is-active")?.scrollIntoView({ block: "nearest" });
    }
    if (this.editing) {
      const editInput = this.querySelector<HTMLTextAreaElement>("#edit-input");
      if (editInput && document.activeElement !== editInput) {
        editInput.focus();
        editInput.setSelectionRange(editInput.value.length, editInput.value.length);
      }
    }
    if (!this.pinnedToBottom) return;
    const log = this.querySelector("#chat-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  // ── render-block construction ─────────────────────────────────────────────

  private buildBlocks(): RenderBlock[] {
    const blocks: RenderBlock[] = [];
    let group: (RenderBlock & { kind: "group" }) | null = null;
    const ensureGroup = (key: string): RenderBlock & { kind: "group" } => {
      if (!group) {
        group = { kind: "group", key, steps: [] };
        blocks.push(group);
      }
      return group;
    };

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.kind === "tool" && item.toolName === "task") {
        group = null;
        blocks.push({ kind: "expert", key: `x${i}`, item });
      } else if (item.kind === "tool" && item.toolName === "task_batch") {
        group = null;
        blocks.push({ kind: "expertBatch", key: `xb${i}`, item });
      } else if (item.kind === "tool") {
        ensureGroup(`g${i}`).steps.push({ kind: "tool", item });
      } else if (item.kind === "assistant") {
        const content = item.message.content;
        for (let b = 0; b < content.length; b++) {
          const block = content[b];
          if (block.type === "thinking") {
            if (block.thinking?.trim()) {
              ensureGroup(`g${i}`).steps.push({ kind: "thinking", text: block.thinking });
            }
          } else if (block.type === "text") {
            if (block.text?.trim()) {
              group = null;
              const isLastBlock = b === content.length - 1;
              blocks.push({
                kind: "prose",
                key: `p${i}.${b}`,
                text: block.text,
                streaming: item.streaming && isLastBlock,
              });
            }
          }
        }
        if (item.message.errorMessage) {
          group = null;
          blocks.push({ kind: "error", key: `e${i}`, text: item.message.errorMessage });
        }
      } else if (item.kind === "user") {
        group = null;
        blocks.push({ kind: "user", key: `u${i}`, text: item.text, itemIndex: i });
      } else if (item.kind === "compaction") {
        group = null;
        blocks.push({ kind: "compaction", key: `c${i}`, summary: item.summary, tokensBefore: item.tokensBefore });
      } else {
        group = null;
        blocks.push({ kind: "info", key: `n${i}`, text: item.text });
      }
    }
    return blocks;
  }

  // ── render ────────────────────────────────────────────────────────────────

  private renderCommandMenu(): TemplateResult | typeof nothing {
    const filtered = this.filteredCommands();
    if (!this.menuOpen || filtered.length === 0) return nothing;
    return html`
      <div class="command-menu" role="listbox">
        ${filtered.map(
          (cmd, i) => html`
            <button
              class="command-item ${i === this.menuActive ? "is-active" : ""}"
              role="option"
              aria-selected=${i === this.menuActive}
              @mouseenter=${() => (this.menuActive = i)}
              @mousedown=${(e: MouseEvent) => {
                e.preventDefault();
                this.applyCommand(cmd);
              }}
            >
              <span class="command-name">/${bareName(cmd)}</span>
              ${cmd.description ? html`<span class="command-desc">${cmd.description}</span>` : nothing}
              <span class="command-source">${cmd.source}</span>
            </button>
          `,
        )}
      </div>
    `;
  }

  render(): TemplateResult {
    const allBlocks = this.buildBlocks();
    const hidden = Math.max(0, allBlocks.length - this.visibleLimit);
    const blocks = hidden > 0 ? allBlocks.slice(hidden) : allBlocks;
    const lastBlock = blocks[blocks.length - 1];
    return html`
      <div id="chat-root">
        <div id="chat-log" @click=${this.onLogClick} @scroll=${this.onLogScroll}>
          ${blocks.length === 0 && !this.running ? this.renderEmpty() : nothing}
          ${hidden > 0
            ? html`<button
                class="show-earlier"
                @click=${() => {
                  this.pinnedToBottom = false;
                  this.visibleLimit += 300;
                }}
              >
                Show earlier · ${hidden} hidden
              </button>`
            : nothing}
          ${repeat(
            blocks,
            (block) => block.key,
            (block) => this.renderBlock(block, this.running && block === lastBlock),
          )}
          ${this.running &&
          lastBlock?.kind !== "group" &&
          !(lastBlock?.kind === "expert" && lastBlock.item.running) &&
          !(lastBlock?.kind === "expertBatch" && lastBlock.item.running)
            ? html`<div class="working"><span class="working-dot"></span>Working…</div>`
            : nothing}
        </div>
        ${this.openExpert ? this.renderExpertDrawer(this.openExpert) : nothing}
        ${this.permissionQueue.length > 0 ? this.renderPermissionCard() : nothing}
        ${this.exited ? this.renderExitBanner() : nothing}
        <div id="composer">
          ${this.renderCommandMenu()}
          <textarea
            id="composer-input"
            rows="1"
            placeholder=${this.running ? "Steer Chronos mid-task… (Enter to send)" : "Ask about your source… (Enter to send)"}
            @keydown=${this.onComposerKeydown}
            @input=${this.onComposerInput}
          ></textarea>
          <div class="composer-actions">
            ${this.running
              ? html`<button class="btn-stop" title="Stop the agent" @click=${() => this.postMessage({ type: "abort" })}>■ Stop</button>`
              : nothing}
            <button class="btn-send" @click=${this.sendPrompt}>${this.running ? "Steer" : "Send"}</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderBlock(block: RenderBlock, isActive: boolean): TemplateResult {
    switch (block.kind) {
      case "user": {
        if (this.editing?.itemIndex === block.itemIndex) {
          return html`
            <div class="msg-user is-editing">
              <textarea id="edit-input" class="edit-input" rows="3" .value=${block.text}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    this.confirmEdit(block.itemIndex);
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    this.editing = null;
                  }
                }}></textarea>
              <div class="edit-hint">Editing rewinds the conversation to this point — later turns move to an abandoned branch.</div>
              <div class="edit-actions">
                <button class="btn-secondary" @click=${() => (this.editing = null)}>Cancel</button>
                <button class="btn-send" @click=${() => this.confirmEdit(block.itemIndex)}>Rewind & send</button>
              </div>
            </div>
          `;
        }
        return html`
          <div class="msg-user">
            <div class="msg-user-text">${block.text}</div>
            ${!this.running && this.permissionQueue.length === 0
              ? html`<button class="msg-edit-btn" title="Edit & rewind to this point"
                  @click=${() => (this.editing = { itemIndex: block.itemIndex })}>✎</button>`
              : nothing}
          </div>
        `;
      }
      case "info":
        return html`<div class="msg-info">${block.text}</div>`;
      case "error":
        return html`<div class="msg-error">${block.text}</div>`;
      case "prose":
        return html`
          <div class="msg-assistant ${block.streaming ? "streaming" : ""}">
            <div class="md">${unsafeHTML(renderMarkdown(block.text))}</div>
            ${block.streaming ? html`<span class="caret"></span>` : nothing}
          </div>
        `;
      case "group":
        return this.renderGroup(block, isActive);
      case "compaction":
        return this.renderCompaction(block);
      case "expert":
        return this.renderExpertCard(block.item);
      case "expertBatch":
        return this.renderExpertBatchCard(block.item);
    }
  }

  // ── expert subagent cards + transcript drawer ─────────────────────────────

  /**
   * Reconstruct an expert's conversation, in order. Turn 1 of a batch-spawned
   * expert lives in the `task_batch` result; later turns are `task` calls.
   */
  private expertTurns(taskId: string): ExpertTurn[] {
    const turns: ExpertTurn[] = [];
    for (const item of this.items) {
      if (item.kind !== "tool") continue;
      if (item.toolName === "task" && taskMeta(item).taskId === taskId) {
        turns.push({
          prompt: String(item.args?.prompt ?? ""),
          pageId: item.args?.page_id,
          bbox: item.args?.bbox,
          reply: taskReplyText(item).replace(LEADING_VIEW_LINKS_RE, ""),
          running: !!item.running,
          isError: !!item.isError,
          toolUses: (item.result as any)?.details?.toolUses,
          source: (item.result as any)?.details?.source,
        });
      } else if (item.toolName === "task_batch") {
        const { prompt, bbox, source, experts } = batchDetails(item);
        const entry = experts.find((e) => e.taskId === taskId);
        if (entry) {
          turns.push({
            prompt,
            pageId: entry.page_id,
            bbox,
            reply: entry.response ?? (entry.file ? `→ ${entry.file}` : entry.error ?? ""),
            running: entry.status === "queued" || entry.status === "running",
            isError: entry.status === "error",
            toolUses: entry.toolUses,
            source,
          });
        }
      }
    }
    return turns;
  }

  /** Model id for an expert session, from its `task` calls or spawning batch. */
  private expertModel(taskId: string): string | undefined {
    let model: string | undefined;
    for (const item of this.items) {
      if (item.kind !== "tool") continue;
      if (item.toolName === "task" && taskMeta(item).taskId === taskId) {
        model = taskMeta(item).model ?? model;
      } else if (item.toolName === "task_batch") {
        const { model: m, experts } = batchDetails(item);
        if (experts.some((e) => e.taskId === taskId)) model = m ?? model;
      }
    }
    return model;
  }

  private renderExpertCard(item: ToolItem): TemplateResult {
    const { taskId, model } = taskMeta(item);
    const isFollowUp = item.args?.task_id != null;
    const prompt = String(item.args?.prompt ?? "");
    const pageId = item.args?.page_id;
    // Workspace-relative source (from the result) so the page chip opens this
    // expert's source, not the last-shown one.
    const source = (item.result as any)?.details?.source as string | undefined;

    // A finished call without a task_id is a refused/failed spawn (bad model,
    // unknown task_id, …) — fall back to the plain tool card so the error is
    // inspectable.
    if (!item.running && !taskId) return this.renderTool(item);

    const index = taskId ? taskId.replace(/^task-/, "") : null;
    const state = item.running ? "running" : item.isError ? "error" : "done";
    const seal = item.running
      ? html`<span class="spinner"></span>`
      : item.isError
        ? html`✗`
        : html`✓`;
    const turnCount = taskId ? this.expertTurns(taskId).length : 0;
    // Live activity streamed via tool_execution_update while the expert works.
    const live = (item.result as any)?.details?.live as
      | { phase: string; toolCalls: number; lastTool?: string }
      | undefined;
    const liveStatus = live
      ? live.phase === "tool"
        ? `${live.lastTool} · ${live.toolCalls} tool ${live.toolCalls === 1 ? "call" : "calls"}`
        : live.toolCalls > 0
          ? `thinking · ${live.toolCalls} tool ${live.toolCalls === 1 ? "call" : "calls"}`
          : "thinking…"
      : undefined;
    const status = item.running
      ? (liveStatus ?? (isFollowUp ? "answering…" : "consulting…"))
      : `${turnCount} ${turnCount === 1 ? "turn" : "turns"}`;

    return html`
      <div
        class="expert-card state-${state} ${item.running ? "is-running" : ""}"
        role="button"
        tabindex="0"
        title=${taskId ? "View expert transcript" : ""}
        @click=${() => taskId && (this.openExpert = taskId)}
        @keydown=${(e: KeyboardEvent) => {
          if (taskId && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            this.openExpert = taskId;
          }
        }}
      >
        <span class="expert-seal" aria-hidden="true">${seal}</span>
        <div class="expert-body">
          <div class="expert-row">
            <span class="expert-title">Expert${index ? html`<span class="expert-index">#${index}</span>` : nothing}</span>
            ${isFollowUp ? html`<span class="expert-tag">follow-up</span>` : nothing}
            ${pageId != null
              ? html`<a
                  class="expert-tag is-page view-link"
                  href="#"
                  title="Jump to page ${pageId}"
                  @click=${(e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.postMessage({ type: "openViewLink", pageId, bbox: item.args?.bbox ?? null, sourcePath: source });
                  }}
                  >p. ${pageId}</a
                >`
              : nothing}
            <span class="expert-spacer"></span>
            ${model ? html`<span class="expert-model">${model}</span>` : nothing}
          </div>
          <div class="expert-prompt">${prompt.length > 120 ? prompt.slice(0, 120) + "…" : prompt}</div>
          <div class="expert-meta">
            <span class="expert-status">${status}</span>
            ${taskId ? html`<span class="expert-open">view transcript →</span>` : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private renderExpertDrawer(taskId: string): TemplateResult {
    const turns = this.expertTurns(taskId);
    const model = this.expertModel(taskId);
    return html`
      <div class="expert-drawer" @click=${this.onLogClick}>
        <div class="expert-drawer-head">
          <span class="expert-seal" aria-hidden="true">✦</span>
          <span class="expert-title">Expert <span class="expert-index">#${taskId.replace(/^task-/, "")}</span></span>
          ${model ? html`<span class="expert-model">${model}</span>` : nothing}
          <span class="expert-spacer"></span>
          <span class="expert-status">${turns.length} turns</span>
          <button class="expert-close" title="Close (Esc)" @click=${() => (this.openExpert = null)}>✕</button>
        </div>
        <div class="expert-drawer-body">
          ${turns.map((turn) => this.renderExpertTurn(turn))}
        </div>
        <div class="expert-drawer-foot">
          Read-only — ask Chronos to follow up on <code>${taskId}</code> to continue this conversation.
        </div>
      </div>
    `;
  }

  private renderExpertTurn(turn: ExpertTurn): TemplateResult {
    // The reply opens with the page's view link when an image was attached;
    // we show the page chip on the question instead, so strip it from the reply.
    const reply = turn.reply.replace(LEADING_VIEW_LINKS_RE, "");
    const bbox = turn.bbox;
    const bboxAttr = bbox ? `${bbox.x},${bbox.y},${bbox.w},${bbox.h}` : undefined;
    const srcAttr = turn.source ? encodeURIComponent(turn.source) : nothing;
    return html`
      <div class="expert-turn-q">
        ${turn.pageId != null
          ? html`<a class="view-link ${bboxAttr ? "view-link-has-sel" : ""}" href="#" data-page=${turn.pageId} data-bbox=${bboxAttr ?? nothing} data-src=${srcAttr}>p. ${turn.pageId}</a>`
          : nothing}
        <span>${turn.prompt}</span>
      </div>
      ${turn.toolUses && turn.toolUses.length
        ? html`<div class="expert-turn-tools">
            <span class="expert-turn-tools-label">examined</span>
            ${turn.toolUses.map((u) => this.renderExpertToolUse(u, turn.source))}
          </div>`
        : nothing}
      ${turn.running
        ? html`<div class="expert-turn-a is-pending"><span class="spinner"></span> thinking…</div>`
        : html`<div class="expert-turn-a md ${turn.isError ? "is-error" : ""}">${unsafeHTML(renderMarkdown(reply || "*(empty response)*"))}</div>`}
    `;
  }

  // One expert tool call, for oversight. Page tools (view_region/view_page) are
  // clickable viewer links so the historian can jump to exactly what the expert
  // pulled in; file/search/command tools show as a labelled chip with the
  // command/path/term. Elevated tools (bash/write/edit) are visually flagged.
  private renderExpertToolUse(u: ExpertToolUse, source?: string): TemplateResult {
    if (u.pageId != null && (u.tool === "view_region" || u.tool === "view_page")) {
      const label = u.tool === "view_region" ? "⛶ region" : "page";
      const bboxAttr = u.bbox ? `${u.bbox.x},${u.bbox.y},${u.bbox.w},${u.bbox.h}` : undefined;
      return html`<a
        class="view-link expert-tool ${u.isError ? "is-error" : ""} ${bboxAttr ? "view-link-has-sel" : ""}"
        href="#"
        title=${u.isError ? "This lookup failed" : `Jump to p.${u.pageId}`}
        data-page=${u.pageId}
        data-bbox=${bboxAttr ?? nothing}
        data-src=${source ? encodeURIComponent(source) : nothing}
        >${label} p.${u.pageId}</a
      >`;
    }
    const labels: Record<string, string> = {
      read_file: "read",
      list_dir: "ls",
      grep: "grep",
      bash: "⌘ bash",
      write_file: "✎ write",
      edit_file: "✎ edit",
    };
    const elevated = u.tool === "bash" || u.tool === "write_file" || u.tool === "edit_file";
    const label = labels[u.tool] ?? u.tool.replace(/_/g, " ");
    const detail = u.detail ? (u.detail.length > 64 ? u.detail.slice(0, 64) + "…" : u.detail) : "";
    return html`<span
      class="expert-tool ${elevated ? "is-elevated" : ""} ${u.isError ? "is-error" : ""}"
      title=${u.detail ?? ""}
      >${label}${detail ? html`: ${detail}` : nothing}</span
    >`;
  }

  private renderExpertBatchCard(item: ToolItem): TemplateResult {
    const { model, experts } = batchDetails(item);
    if (experts.length === 0) {
      // Running but no progress event yet (spawn/confirmation phase) — show a
      // pulse so it's clear Chronos hasn't frozen.
      if (item.running) {
        return html`
          <div class="expert-batch-card is-running">
            <div class="expert-batch-head">
              <span class="expert-seal" aria-hidden="true"><span class="spinner"></span></span>
              <span class="expert-title">Expert cohort</span>
              <span class="expert-spacer"></span>
              <span class="expert-status">spawning experts…</span>
            </div>
          </div>
        `;
      }
      // A batch that errored before spawning anything (no source, bad template,
      // empty page list) carries no experts — fall back to the plain tool card.
      return this.renderTool(item);
    }

    const queued = experts.filter((e) => e.status === "queued").length;
    const running = experts.filter((e) => e.status === "running").length;
    const ok = experts.filter((e) => e.status === "ok").length;
    const err = experts.filter((e) => e.status === "error").length;
    // While running, the model may still be the "(orchestrator default)"
    // placeholder — hide it until a real id is known.
    const shownModel = model && model !== "(orchestrator default)" ? model : undefined;
    return html`
      <details class="expert-batch-card ${item.running ? "is-running" : ""}" open>
        <summary>
          <span class="expert-seal" aria-hidden="true">${item.running ? html`<span class="spinner"></span>` : "✦"}</span>
          <span class="group-chevron"></span>
          <span class="expert-title">Expert cohort</span>
          <span class="expert-batch-count">${experts.length} pages</span>
          ${shownModel ? html`<span class="expert-model">${shownModel}</span>` : nothing}
          <span class="expert-spacer"></span>
          ${item.running ? html`<span class="expert-batch-running">${running} running</span>` : nothing}
          ${item.running && queued > 0 ? html`<span class="expert-batch-queued">${queued} queued</span>` : nothing}
          <span class="expert-batch-ok">✓ ${ok}</span>
          ${err > 0 ? html`<span class="expert-batch-err">✗ ${err}</span>` : nothing}
        </summary>
        <div class="expert-batch-grid">
          ${experts.map((e) => this.renderBatchChip(e))}
        </div>
      </details>
    `;
  }

  private renderBatchChip(e: BatchExpertEntry): TemplateResult {
    const finished = e.status === "ok" || e.status === "error";
    const clickable = finished && !!e.taskId;
    const idx = e.taskId ? e.taskId.replace(/^task-/, "#") : "—";
    const foot =
      e.status === "queued" ? "queued" : e.status === "running" ? (e.activity ?? "working…") : idx;
    const title =
      e.status === "error"
        ? (e.error ?? "failed")
        : e.status === "queued"
          ? "Waiting for a free worker slot"
          : e.status === "running"
            ? (e.activity ?? "working…")
            : `View ${e.taskId} transcript`;
    return html`
      <button
        class="expert-chip is-${e.status}"
        ?disabled=${!clickable}
        title=${title}
        @click=${() => clickable && (this.openExpert = e.taskId!)}
      >
        <span class="expert-chip-page">p. ${e.page_id}</span>
        <span class="expert-chip-foot">
          <span class="expert-chip-task">${foot}</span>
          <span class="expert-chip-dot is-${e.status}" aria-hidden="true"></span>
        </span>
      </button>
    `;
  }

  private renderCompaction(block: RenderBlock & { kind: "compaction" }): TemplateResult {
    const tokens =
      typeof block.tokensBefore === "number" && block.tokensBefore > 0
        ? `${Math.round(block.tokensBefore / 1000)}k tokens summarized`
        : "earlier turns summarized";
    return html`
      <details class="compaction-divider">
        <summary>
          <span class="compaction-line"></span>
          <span class="compaction-label">Context compacted · ${tokens}</span>
          <span class="compaction-line"></span>
        </summary>
        ${block.summary
          ? html`<div class="compaction-summary md">${unsafeHTML(renderMarkdown(block.summary))}</div>`
          : nothing}
      </details>
    `;
  }

  private renderGroup(group: RenderBlock & { kind: "group" }, active: boolean): TemplateResult {
    const toolSteps = group.steps.filter((s): s is ActivityStep & { kind: "tool" } => s.kind === "tool");
    const failed = toolSteps.filter((s) => s.item.isError).length;
    let summary: TemplateResult;
    if (active) {
      const current = [...toolSteps].reverse().find((s) => s.item.running);
      const label = current ? toolSummary(current.item).label : "Reasoning";
      summary = html`<span class="spinner"></span><span class="group-label">${label}…</span>
        ${group.steps.length > 1 ? html`<span class="group-count">${group.steps.length} steps</span>` : nothing}`;
    } else {
      summary = html`<span class="group-chevron"></span>
        <span class="group-label">${group.steps.length === 1 ? this.singleStepLabel(group.steps[0]) : `${group.steps.length} steps`}</span>
        ${failed > 0 ? html`<span class="group-failed">${failed} failed</span>` : nothing}`;
    }
    return html`
      <details class="activity-group ${active ? "is-active" : ""}">
        <summary>${summary}</summary>
        <div class="group-body">
          ${group.steps.map((step) =>
            step.kind === "tool"
              ? this.renderTool(step.item)
              : html`
                  <details class="thinking">
                    <summary>Reasoning</summary>
                    <div class="thinking-body md">${unsafeHTML(renderMarkdown(step.text))}</div>
                  </details>
                `,
          )}
        </div>
      </details>
    `;
  }

  private singleStepLabel(step: ActivityStep): string {
    if (step.kind === "thinking") return "Reasoning";
    const { label, detail } = toolSummary(step.item);
    return detail ? `${label} · ${detail.length > 60 ? detail.slice(0, 60) + "…" : detail}` : label;
  }

  private renderEmpty(): TemplateResult {
    return html`
      <div class="chat-empty">
        <div class="chat-empty-title">Start a conversation</div>
        <div class="chat-empty-hint">
          Select a source in the header, then ask about its pages.<br />
          Answers cite pages as <span class="view-link-demo">p. 12</span> — click a citation to see the evidence.
        </div>
      </div>
    `;
  }

  // A small "open in viewer" control for chat entries that showed something
  // (a page or text). Lives in summaries, so it must not toggle the <details>.
  private renderViewButton(ref: ViewRef): TemplateResult {
    return html`<button
      class="view-reopen"
      title="Show this in the viewer again"
      @click=${(e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (ref.kind === "page") {
          this.postMessage({ type: "openViewLink", pageId: ref.pageId, bbox: ref.bbox, sourcePath: ref.source });
        } else {
          this.postMessage({ type: "openTextView", filePath: ref.filePath, highlight: ref.highlight });
        }
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>`;
  }

  private renderTool(item: ToolItem): TemplateResult {
    const { label, detail } = toolSummary(item);
    const output = resultText(item.result);
    const ref = viewRefFromTool(item);
    return html`
      <details class="tool-card ${item.isError ? "is-error" : ""} ${item.running ? "is-running" : ""}">
        <summary>
          <span class="tool-marker">${item.running ? html`<span class="spinner"></span>` : item.isError ? "✗" : "·"}</span>
          <span class="tool-label">${label}</span>
          ${detail ? html`<span class="tool-detail">${detail.length > 80 ? detail.slice(0, 80) + "…" : detail}</span>` : nothing}
          ${ref ? this.renderViewButton(ref) : nothing}
        </summary>
        <div class="tool-body">
          ${item.args != null ? html`<pre class="tool-pre">${JSON.stringify(item.args, null, 2)}</pre>` : nothing}
          ${output
            ? html`<pre class="tool-pre tool-output">${output.length > 3000 ? output.slice(0, 3000) + "\n…" : output}</pre>`
            : nothing}
        </div>
      </details>
    `;
  }

  private renderPermissionCard(): TemplateResult {
    const req = this.permissionQueue[0];
    const queued = this.permissionQueue.length - 1;
    return html`
      <div id="permission-card">
        <div class="perm-head">
          <span class="perm-title">Run this command?</span>
          ${queued > 0 ? html`<span class="perm-queued">+${queued} more</span>` : nothing}
        </div>
        <pre class="perm-command">${req.command}</pre>
        <div class="perm-actions">
          <button class="btn-secondary" title="Esc" @click=${() => this.answerPermission("deny")}>Deny</button>
          <span class="perm-spacer"></span>
          <button class="btn-secondary" title="Auto-approve commands starting with “${req.suggestedPrefix}” in this workspace"
            @click=${() => this.answerPermission("always")}>
            Always allow <code>${req.suggestedPrefix}</code>
          </button>
          <button class="btn-send" title="Enter" @click=${() => this.answerPermission("allow")}>Allow once</button>
        </div>
      </div>
    `;
  }

  private renderExitBanner(): TemplateResult {
    return html`
      <div id="exit-banner">
        <div class="exit-text">
          <strong>The agent process stopped${this.exited?.code != null ? ` (code ${this.exited.code})` : ""}.</strong>
          ${this.exited?.stderr ? html`<pre class="stderr-tail">${this.exited.stderr}</pre>` : nothing}
        </div>
        <button class="btn-send" @click=${() => this.postMessage({ type: "restartAgent" })}>Restart</button>
      </div>
    `;
  }
}

customElements.define("chronos-chat", ChronosChat);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-chat": ChronosChat;
  }
}
