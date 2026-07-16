import * as vscode from "vscode";
import { resolvePiBin } from "../pi-env";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, isAbsolute } from "node:path";
import { PiRpcSession } from "../rpc/pi-rpc-session";
import type { ModelInfo, RpcExtensionUIRequest, RpcSessionState, RpcSlashCommand } from "../rpc/rpc-types";
import type { AgentToExtensionMessage } from "../protocol";
import type { Bbox, ExtToWebview, WebviewToExt } from "./webview-protocol";
import { discoverSources, countPages, discoverCollections } from "./sources";
import { listSessions, readSessionMessages } from "./sessions";
import {
  beginAnthropicLogin,
  startCallbackServer,
  completeAnthropicLogin,
  parseAuthorizationInput,
  type AnthropicOAuthCredentials,
  type AuthCode,
  type CallbackServer,
} from "../anthropic-oauth";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export type AgentStatus = "starting" | "ready" | "failed" | "exited";

// Providers offered by the native login flow → the env var pi reads the key
// from (see pi-ai env-api-keys). "Other" lets the user name any other var.
const LOGIN_PROVIDERS: { label: string; envVar: string }[] = [
  { label: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY" },
  { label: "Google (Gemini)", envVar: "GEMINI_API_KEY" },
  { label: "OpenAI", envVar: "OPENAI_API_KEY" },
  { label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { label: "xAI (Grok)", envVar: "XAI_API_KEY" },
  { label: "Groq", envVar: "GROQ_API_KEY" },
  { label: "Mistral", envVar: "MISTRAL_API_KEY" },
  { label: "DeepSeek", envVar: "DEEPSEEK_API_KEY" },
];

// Set KEY=value in a .env file, replacing any existing assignment of KEY.
function upsertEnvVar(envPath: string, key: string, value: string): void {
  mkdirSync(dirname(envPath), { recursive: true });
  const kept = existsSync(envPath)
    ? readFileSync(envPath, "utf-8")
        .split("\n")
        .filter((line) => {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          return !(m && m[1] === key);
        })
    : [];
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push(`${key}=${value}`);
  // The .env holds billing-bearing provider API keys — keep it owner-only.
  // writeFileSync's mode only applies on creation, so chmod too to tighten a
  // pre-existing (possibly group/world-readable) file.
  writeFileSync(envPath, kept.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* best-effort (e.g. unsupported fs) */
  }
}

// Write an Anthropic OAuth credential into pi's global auth store
// (~/.pi/agent/auth.json), merging with any existing providers. This is the
// same file/shape pi's own /login writes, so pi reads and refreshes it.
function writeAnthropicOAuth(creds: AnthropicOAuthCredentials): void {
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  let store: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
      if (parsed && typeof parsed === "object") store = parsed as Record<string, unknown>;
    } catch {
      store = {};
    }
  }
  store.anthropic = { type: "oauth", refresh: creds.refresh, access: creds.access, expires: creds.expires };
  // Mirror pi's auth-storage hardening: owner-only dir + file. writeFileSync's
  // mode only applies on creation, so chmod too in case auth.json pre-exists
  // with looser permissions (it holds long-lived OAuth refresh/access tokens).
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  writeFileSync(authPath, JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(authPath, 0o600);
  } catch {
    /* best-effort */
  }
}

// pi auto-registers every .md in a package's prompts/ dir as a slash command,
// but the chronos package ships those files as agent-internal tool text (the
// system prompt, expert prompts, per-tool descriptions) — not user commands.
// They're the only "prompt"-source entries with package origin; the user's own
// global/project prompts are top-level, and skills/extension commands are
// genuinely user-facing. Hide package prompts; keep everything else.
function isUserCommand(c: RpcSlashCommand): boolean {
  return !(c.source === "prompt" && c.sourceInfo?.origin === "package");
}

// ── workspace settings (.chronos/settings.json — shared with the pi-package,
//    which reads the `yolo` flag on every bash call) ────────────────────────

interface ChronosSettings {
  yolo?: boolean;
  allowedCommands?: string[];
  [key: string]: unknown;
}

function readChronosSettings(workspaceDir: string): ChronosSettings {
  try {
    return JSON.parse(readFileSync(join(workspaceDir, ".chronos", "settings.json"), "utf-8"));
  } catch {
    return {};
  }
}

function writeChronosSettings(workspaceDir: string, settings: ChronosSettings): void {
  const dir = join(workspaceDir, ".chronos");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// Multi-word launchers where the subcommand is the meaningful unit: suggest
// "git status" rather than all of "git".
const PREFIX_LAUNCHERS = new Set([
  "git", "npm", "pnpm", "yarn", "pip", "pip3", "python", "python3",
  "node", "cargo", "docker", "uv", "poetry", "make",
]);

function suggestPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length >= 2 && PREFIX_LAUNCHERS.has(tokens[0])) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0] ?? command.trim();
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  const cmd = command.trim();
  return cmd === prefix || cmd.startsWith(prefix + " ");
}

export class ChronosPanel {
  private static current: ChronosPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private rpc: PiRpcSession | null = null;
  private isStreaming = false;
  private disposables: vscode.Disposable[] = [];
  private agentStatus: AgentStatus = "starting";
  private lastError = "";
  private webviewReady = false;

  // Viewer state so navigation and [view p.N] links without an explicit
  // source resolve against the current source.
  private currentSourceDir: string | undefined;
  private currentSourceName: string | undefined;
  private firstPage = 1;
  private lastPage = 1;
  // Last source we pushed a data-file list for, so navigation within a source
  // doesn't re-list on every page change.
  private lastDataSource: string | undefined;
  // Active collection name (null = auto "all sources"), pushed by the agent over
  // HTTP so the collection picker reflects the current selection.
  private activeCollection: string | null = null;
  // The active collection's output dir (data/_collections/<key>/) whose files —
  // e.g. the entity index — are surfaced in the Data tab alongside source data.
  private activeCollectionDataDir: string | undefined;
  // filename → directory it was listed from, so a data/load reads the right dir
  // when the list merges per-source and collection-level files.
  private dataFileDirs = new Map<string, string>();

  // Blocking extension_ui_requests forwarded to the webview; answered with
  // cancelled on dispose so the agent never deadlocks.
  private pendingUiRequestIds = new Set<string>();

  // Pending __test/dump requests awaiting the webview's state snapshot.
  private testDumpResolvers: ((state: unknown) => void)[] = [];

  // Introspection for integration tests and debugging
  static getStatus(): { panelOpen: boolean; agentStatus: AgentStatus; agentPid?: number; lastError: string; webviewReady: boolean } | undefined {
    const panel = ChronosPanel.current;
    if (!panel) return undefined;
    return {
      panelOpen: true,
      agentStatus: panel.agentStatus,
      agentPid: panel.rpc?.pid,
      lastError: panel.lastError,
      webviewReady: panel.webviewReady,
    };
  }

  static async createOrShow(
    extensionUri: vscode.Uri,
    workspaceDir: string,
    agentEnv: Record<string, string>,
  ): Promise<ChronosPanel> {
    if (ChronosPanel.current) {
      ChronosPanel.current.panel.reveal();
      return ChronosPanel.current;
    }
    const panel = new ChronosPanel(extensionUri, workspaceDir, agentEnv);
    ChronosPanel.current = panel;
    await panel.startAgent();
    return panel;
  }

  static get active(): ChronosPanel | undefined {
    return ChronosPanel.current;
  }

  /** Re-scan sources/ and push the updated list to the webview. Called when an
   *  external action changes the source tree (e.g. the Import Sources command
   *  adds a new source) so the header picker reflects it without a reload. */
  refreshSources(): void {
    this.postSources();
    this.postCollections();
  }

  // ── test seam (integration tests) ─────────────────────────────────────────
  /** Tell the webview to simulate a user action. */
  testInvoke(action: string, arg?: string): void {
    this.post({ type: "__test/invoke", action, arg });
  }

  /** Ask the webview for a state snapshot and resolve with it. */
  testDump(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("__test/dump timed out")), 5000);
      this.testDumpResolvers.push((state) => {
        clearTimeout(timer);
        resolve(state);
      });
      this.post({ type: "__test/dump" });
    });
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly workspaceDir: string,
    private readonly agentEnv: Record<string, string>,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "chronos.main",
      "Chronos",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "out"),
          vscode.Uri.file(workspaceDir),
        ],
      },
    );
    this.panel.webview.html = this.getHtml(extensionUri);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToExt) => this.handleWebviewMessage(msg),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private post(msg: ExtToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  // ── agent lifecycle ───────────────────────────────────────────────────────

  private async startAgent(): Promise<void> {
    const rpc = new PiRpcSession({
      piBin: resolvePiBin(),
      workspaceDir: this.workspaceDir,
      env: this.agentEnv,
    });
    this.rpc = rpc;

    rpc.onEvent((event) => {
      if (event.type === "agent_start") this.isStreaming = true;
      if (event.type === "agent_end") {
        this.isStreaming = false;
        // Message counts changed — keep the session list fresh
        this.postSessions();
        // The turn may have written new extraction files — refresh the Data tab.
        this.postDataFiles();
      }
      this.post({ type: "agentEvent", event });
    });
    rpc.onUiRequest((request) => void this.handleUiRequest(request));
    rpc.onExit((code, stderrTail) => {
      this.isStreaming = false;
      this.agentStatus = "exited";
      this.lastError = stderrTail.trim();
      this.post({ type: "agentExited", code, stderr: stderrTail.trim() });
    });

    try {
      this.agentStatus = "starting";
      const state = await rpc.start();
      this.agentStatus = "ready";
      this.seedWebview(state);
    } catch (err) {
      this.agentStatus = "failed";
      this.lastError = (err as Error).message;
      console.error("[chronos-panel] pi startup failed:", (err as Error).message);
      this.post({ type: "agentExited", code: null, stderr: (err as Error).message });
      vscode.window.showErrorMessage(`Chronos: failed to start pi — ${(err as Error).message}`);
    }
  }

  private seedWebview(state: RpcSessionState): void {
    this.isStreaming = state.isStreaming;
    this.post({ type: "state", state });
    this.post({ type: "yolo", enabled: readChronosSettings(this.workspaceDir).yolo === true });
    this.postSources();
    this.postCollections();
    this.postSessions();
    void this.postHistory(state);
    void this.rpc
      ?.request<{ models: ModelInfo[] }>({ type: "get_available_models" })
      .then((data) => {
        const models = data.models ?? [];
        this.post({ type: "models", models });
        // No models means no provider is authenticated — surface the login CTA.
        this.post({ type: "loginRequired", required: models.length === 0 });
      })
      .catch(() => {
        // The agent already started (rpc.start resolved), so a transient
        // get_available_models failure shouldn't strand a stale "logged out"
        // banner after a successful login — clear it; the next re-seed corrects it.
        this.post({ type: "loginRequired", required: false });
      });
    void this.rpc
      ?.request<{ commands: RpcSlashCommand[] }>({ type: "get_commands" })
      .then((data) => this.post({ type: "commands", commands: (data.commands ?? []).filter(isUserCommand) }))
      .catch(() => {});
  }

  // Vision tool results embed base64 page images — multi-MB payloads the chat
  // never renders. Strip them before crossing the postMessage bridge.
  private static stripImages(messages: any[]): any[] {
    return messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg;
      if (!msg.content.some((block: any) => block?.type === "image")) return msg;
      return {
        ...msg,
        content: msg.content.map((block: any) =>
          block?.type === "image" ? { type: "text", text: "[image]" } : block,
        ),
      };
    });
  }

  // History from the session file when it's richer than the agent context
  // (compaction trims the context on long sessions; the file keeps all turns).
  private async postHistory(state: RpcSessionState): Promise<void> {
    const filePath = state.sessionFile
      ? isAbsolute(state.sessionFile)
        ? state.sessionFile
        : join(this.workspaceDir, state.sessionFile)
      : undefined;
    const fromFile = filePath ? readSessionMessages(filePath) : undefined;
    try {
      const data = await this.rpc?.request<{ messages: any[] }>({ type: "get_messages" });
      const fromContext = data?.messages ?? [];
      const messages =
        fromFile && fromFile.length > fromContext.length ? fromFile : fromContext;
      this.post({ type: "history", messages: ChronosPanel.stripImages(messages) });
    } catch {
      if (fromFile) this.post({ type: "history", messages: ChronosPanel.stripImages(fromFile) });
    }
  }

  private postSources(): void {
    const sourcesDir = join(this.workspaceDir, "sources");
    const sources = existsSync(sourcesDir) ? discoverSources(sourcesDir) : [];
    this.post({
      type: "sources",
      sources: sources.map((s) => ({ name: s.name, pageCount: countPages(s.path) })),
    });
  }

  private postCollections(): void {
    this.post({
      type: "collections",
      collections: discoverCollections(this.workspaceDir),
      active: this.activeCollection,
    });
  }

  private postSessions(): void {
    this.post({ type: "sessions", sessions: listSessions(this.workspaceDir) });
  }

  private async refreshState(): Promise<void> {
    if (!this.rpc?.isRunning) return;
    try {
      const state = await this.rpc.request<RpcSessionState>({ type: "get_state" });
      this.isStreaming = state.isStreaming;
      this.post({ type: "state", state });
    } catch {
      // ignore
    }
  }

  private async restartAgent(): Promise<void> {
    await this.rpc?.stop();
    this.rpc = null;
    await this.startAgent();
    this.post({ type: "agentRestarted" });
  }

  /**
   * Connect an AI provider without leaving the panel: pick a provider, enter its
   * API key, persist it to .chronos/.env, and restart the agent so pi picks it
   * up. Provider-agnostic — pi reads <PROVIDER>_API_KEY from the subprocess env.
   * (pi's own /login is a TUI-only flow with no RPC equivalent.)
   */
  async promptLogin(): Promise<void> {
    type LoginItem = vscode.QuickPickItem & {
      action: "oauth-anthropic" | "api-key" | "other";
      envVar?: string;
      provider?: string;
    };
    const items: LoginItem[] = [
      {
        label: "Anthropic — Claude Pro/Max (subscription sign-in)",
        detail: "OAuth — uses your Claude subscription, no API key",
        action: "oauth-anthropic",
      },
      ...LOGIN_PROVIDERS.map((p): LoginItem => ({
        label: `${p.label} — API key`,
        detail: p.envVar,
        action: "api-key",
        envVar: p.envVar,
        provider: p.label,
      })),
      { label: "Other provider — API key…", detail: "Enter the environment variable name", action: "other" },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Connect an AI provider" });
    if (!picked) return;

    if (picked.action === "oauth-anthropic") {
      await this.loginAnthropicSubscription();
      return;
    }

    let envVar = picked.envVar ?? "";
    let providerLabel = picked.provider ?? "provider";
    if (picked.action === "other") {
      envVar = (
        await vscode.window.showInputBox({
          prompt: "API-key environment variable name",
          placeHolder: "e.g. TOGETHER_API_KEY",
        })
      )?.trim() ?? "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) return;
      providerLabel = envVar;
    }

    const key = (
      await vscode.window.showInputBox({
        prompt: `Enter your ${providerLabel} API key`,
        password: true,
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!key) return;

    try {
      upsertEnvVar(join(this.workspaceDir, ".chronos", ".env"), envVar, key);
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Could not write .chronos/.env: ${(err as Error).message}` });
      return;
    }
    // Make the new key live for the next spawn and restart so models populate.
    this.agentEnv[envVar] = key;
    this.post({ type: "notify", level: "info", message: `Saved ${envVar}. Restarting agent…` });
    await this.restartAgent();
  }

  /**
   * Anthropic subscription (Claude Pro/Max) login via OAuth, driven entirely
   * from the panel: open the browser, capture the redirect on a localhost
   * callback (or accept a pasted code), exchange it for tokens, write the
   * credential to ~/.pi/agent/auth.json (what pi reads), and restart the agent.
   */
  private async loginAnthropicSubscription(): Promise<void> {
    let codeRes: AuthCode | undefined;
    let verifier = "";
    try {
      const begun = await beginAnthropicLogin();
      verifier = begun.verifier;
      let server: CallbackServer | undefined;
      try {
        server = await startCallbackServer();
      } catch {
        server = undefined; // port unavailable → fall back to manual code entry
      }
      try {
        codeRes = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, cancellable: true, title: "Connect Claude (Pro/Max)" },
          async (progress, token) => {
            await vscode.env.openExternal(vscode.Uri.parse(begun.authUrl));
            progress.report({
              message: server
                ? "Approve access in your browser — you'll return here automatically. Cancel to paste the code instead."
                : "Approve access in your browser, then paste the code.",
            });
            if (!server) return undefined;
            token.onCancellationRequested(() => server!.cancel());
            return await server.waitForCode();
          },
        );
      } finally {
        server?.close();
      }
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Claude sign-in failed: ${(err as Error).message}` });
      return;
    }

    // No automatic redirect (cancelled, remote browser, or port busy) → paste it.
    if (!codeRes) {
      const pasted = (
        await vscode.window.showInputBox({
          prompt: "Paste the authorization code or the full redirect URL from your browser",
          ignoreFocusOut: true,
        })
      )?.trim();
      if (!pasted) return; // cancelled
      const parsed = parseAuthorizationInput(pasted);
      if (!parsed.code) {
        this.post({ type: "notify", level: "error", message: "No authorization code found in the pasted value." });
        return;
      }
      if (parsed.state && parsed.state !== verifier) {
        this.post({ type: "notify", level: "error", message: "OAuth state mismatch — please retry the sign-in." });
        return;
      }
      codeRes = { code: parsed.code, state: parsed.state ?? verifier };
    }

    let creds: AnthropicOAuthCredentials;
    try {
      creds = await completeAnthropicLogin({ code: codeRes.code, state: codeRes.state ?? verifier, verifier });
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Claude sign-in failed: ${(err as Error).message}` });
      return;
    }

    try {
      writeAnthropicOAuth(creds);
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Could not write auth.json: ${(err as Error).message}` });
      return;
    }
    this.post({ type: "notify", level: "info", message: "Connected to Claude (Pro/Max). Restarting agent…" });
    await this.restartAgent();
  }

  // ── viewer ────────────────────────────────────────────────────────────────

  /** Messages from the chronos pi-package arriving over HTTP. */
  handleHttpMessage(msg: AgentToExtensionMessage): void {
    switch (msg.type) {
      case "show_page":
        this.showPage(msg.sourceDir, msg.sourceName, msg.pageId, msg.bbox, msg.totalPages);
        break;
      case "page_list":
        this.firstPage = msg.firstPage;
        this.lastPage = msg.lastPage;
        this.post({ type: "viewer/updateRange", firstPage: msg.firstPage, lastPage: msg.lastPage });
        break;
      case "show_text":
        this.currentSourceName = msg.sourceName;
        this.post({
          type: "viewer/showText",
          filePath: msg.filePath,
          content: msg.content,
          highlight: msg.highlight,
          sourceName: msg.sourceName,
        });
        break;
      case "collection":
        this.activeCollection = msg.name;
        this.activeCollectionDataDir = msg.dataDir;
        this.postCollections();
        // The collection's entity index etc. may now be visible — refresh the tab.
        this.postDataFiles();
        break;
      // text_delta/tool_start/tool_end/turn_end are RPC-event duplicates — dropped
    }
  }

  showPage(sourceDir: string, sourceName: string, pageId: number, bbox: Bbox | null, totalPages?: number): void {
    this.currentSourceDir = sourceDir;
    this.currentSourceName = sourceName || this.currentSourceName;
    if (totalPages && totalPages > 0) {
      this.firstPage = 1;
      this.lastPage = totalPages;
    }

    this.post({
      type: "viewer/showPage",
      imageUri: this.pageImageUri(sourceDir, pageId),
      pageId,
      sourceName: this.currentSourceName ?? sourceName,
      firstPage: this.firstPage,
      lastPage: this.lastPage,
      bbox,
    });

    // Refresh the Data tab's file list when the active source changes.
    if (this.currentSourceName !== this.lastDataSource) this.postDataFiles();
  }

  // Resolve a page's image file (png/jpg/jpeg) to a webview URI.
  private pageImageUri(sourceDir: string, pageId: number): string {
    const pageBase = `page_${String(pageId).padStart(4, "0")}`;
    let pagePath = join(sourceDir, "png", pageBase + ".png");
    for (const ext of [".png", ".jpg", ".jpeg"]) {
      const candidate = join(sourceDir, "png", pageBase + ext);
      if (existsSync(candidate)) {
        pagePath = candidate;
        break;
      }
    }
    return this.panel.webview.asWebviewUri(vscode.Uri.file(pagePath)).toString();
  }

  // A cited source (from a [view …@path] link or a data row's chronos_source) to
  // its absolute dir. Accepts an absolute path, a workspace-relative path
  // (sources/Frankfurt_1864), or a bare ref (Frankfurt_1864) — trying the
  // sources/ tree as a fallback so entity-index citations resolve either way.
  private resolveCitedSource(sourcePath: string): string {
    if (isAbsolute(sourcePath)) return sourcePath;
    const direct = join(this.workspaceDir, sourcePath);
    if (existsSync(join(direct, "png"))) return direct;
    const underSources = join(this.workspaceDir, "sources", sourcePath);
    if (existsSync(join(underSources, "png"))) return underSources;
    return direct;
  }

  // Resolve a cited page's image for the Data tab's inline crop preview, WITHOUT
  // touching the page viewer or current source — the data and source viewers are
  // independent; only "Show full page" (openViewLink) crosses over.
  private previewSource(pageId: number, bbox: Bbox | null, sourcePath?: string): void {
    let sourceDir = this.currentSourceDir;
    let sourceName = this.currentSourceName;
    if (sourcePath) {
      sourceDir = this.resolveCitedSource(sourcePath);
      sourceName = basename(sourceDir);
    }
    if (!sourceDir) return;
    this.post({
      type: "data/sourcePreview",
      imageUri: this.pageImageUri(sourceDir, pageId),
      pageId,
      bbox,
      sourceName: sourceName ?? "",
    });
  }

  private openViewLink(pageId: number, bbox: Bbox | null, sourcePath?: string): void {
    let sourceDir = this.currentSourceDir;
    let sourceName = this.currentSourceName;
    if (sourcePath) {
      sourceDir = this.resolveCitedSource(sourcePath);
      sourceName = basename(sourceDir);
    }
    if (!sourceDir || !sourceName) return;
    const totalPages = sourceDir === this.currentSourceDir ? undefined : countPages(sourceDir);
    this.showPage(sourceDir, sourceName, pageId, bbox, totalPages);
  }

  // Re-open a text file the agent showed earlier (show_text). The chat doesn't
  // keep the content, so re-read it here and push it to the viewer.
  private openTextView(filePath: string, highlight: string | null): void {
    const resolved = isAbsolute(filePath)
      ? filePath
      : this.currentSourceDir
        ? join(this.currentSourceDir, filePath)
        : undefined;
    if (!resolved) return;
    try {
      const content = readFileSync(resolved, "utf-8");
      this.post({
        type: "viewer/showText",
        filePath: resolved,
        content,
        highlight,
        sourceName: this.currentSourceName ?? basename(resolved),
      });
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Could not open ${filePath}: ${(err as Error).message}` });
    }
  }

  // ── dataset viewer ─────────────────────────────────────────────────────────
  // The agent writes extraction outputs to data/<dataKey>/ and sends that dataKey
  // as the viewer event's `sourceName` (basename for flat sources, a slug for
  // nested ones), so data/<sourceName> here always matches the agent's output dir.
  // We surface those files in the Data tab; row provenance reuses openViewLink.

  private dataDir(): string | undefined {
    return this.currentSourceName ? join(this.workspaceDir, "data", this.currentSourceName) : undefined;
  }

  private filesIn(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  // The active source's files plus, when a collection is active, its
  // collection-level files (entity index, cross-source summaries). Records each
  // file's directory so data/load reads it back from the right place; the source
  // dir wins on a name clash.
  private listDataFiles(): string[] {
    this.dataFileDirs.clear();
    const collectionDir = this.activeCollectionDataDir;
    if (collectionDir) {
      for (const name of this.filesIn(collectionDir)) this.dataFileDirs.set(name, collectionDir);
    }
    const sourceDir = this.dataDir();
    if (sourceDir) {
      for (const name of this.filesIn(sourceDir)) this.dataFileDirs.set(name, sourceDir);
    }
    return [...this.dataFileDirs.keys()].sort((a, b) => a.localeCompare(b));
  }

  private postDataFiles(): void {
    this.lastDataSource = this.currentSourceName;
    this.post({ type: "data/list", sourceName: this.currentSourceName ?? "", files: this.listDataFiles() });
  }

  private postDataFile(filename: string): void {
    // filenames come from listDataFiles (basenames); reject anything path-like.
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return;
    const dir = this.dataFileDirs.get(filename) ?? this.dataDir();
    if (!dir) return;
    try {
      const content = readFileSync(join(dir, filename), "utf-8");
      this.post({ type: "data/show", sourceName: this.currentSourceName ?? "", filename, content });
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Could not read ${filename}: ${(err as Error).message}` });
    }
  }

  // ── webview → extension ──────────────────────────────────────────────────

  private async handleWebviewMessage(msg: WebviewToExt): Promise<void> {
    try {
      switch (msg.type) {
        case "ready": {
          // Webview (re)booted — re-seed if the agent is already up
          this.webviewReady = true;
          if (this.rpc?.isRunning) {
            const state = await this.rpc.request<RpcSessionState>({ type: "get_state" });
            this.seedWebview(state);
          }
          break;
        }
        case "prompt": {
          if (this.isStreaming) {
            await this.rpc?.request({ type: "steer", message: msg.text });
          } else {
            // No timeout: slash-command prompts (/select-source) only respond
            // after their handler finishes, which may wait on a user dialog.
            await this.rpc?.request({ type: "prompt", message: msg.text }, 0);
          }
          break;
        }
        case "abort":
          await this.rpc?.request({ type: "abort" });
          break;
        case "restartAgent":
          await this.restartAgent();
          break;
        case "newSession": {
          const result = await this.rpc?.request<{ cancelled: boolean }>({ type: "new_session" }, 60_000);
          if (result && !result.cancelled) {
            this.currentSourceDir = undefined;
            this.currentSourceName = undefined;
            // Re-arm the Data-tab refresh guard so re-selecting the same source
            // (or restoring it on resume) repopulates the (now-cleared) Data tab.
            this.lastDataSource = undefined;
            // New session starts on the auto collection; the agent re-emits the
            // active collection on its session_start, which corrects this if needed.
            this.activeCollection = null;
            this.activeCollectionDataDir = undefined;
            this.postCollections();
            this.post({ type: "history", messages: [] });
            // The new session has no source bound — clear the viewer + dropdown so
            // the display matches (don't leave the previous source showing).
            this.post({ type: "viewer/clearSource" });
            await this.refreshState();
            this.postSessions();
          }
          break;
        }
        case "login":
          await this.promptLogin();
          break;
        case "resumeSession": {
          try {
            const result = await this.rpc?.request<{ cancelled: boolean }>(
              { type: "switch_session", sessionPath: msg.sessionPath },
              120_000,
            );
            if (result && !result.cancelled && this.rpc) {
              const state = await this.rpc.request<RpcSessionState>({ type: "get_state" });
              this.isStreaming = state.isStreaming;
              this.post({ type: "state", state });
              await this.postHistory(state);
              this.post({ type: "resumeResult", ok: true });
            } else {
              this.post({ type: "resumeResult", ok: false });
            }
          } catch (err) {
            this.post({ type: "resumeResult", ok: false });
            throw err;
          }
          break;
        }
        case "setModel": {
          await this.rpc?.request({ type: "set_model", provider: msg.provider, modelId: msg.modelId });
          await this.refreshState();
          break;
        }
        case "setThinkingLevel":
          await this.rpc?.request({ type: "set_thinking_level", level: msg.level });
          await this.refreshState();
          break;
        case "selectSource":
          // Runs the chronos pi-package command; with an argument it selects
          // directly, with an older package it opens the interactive picker
          // (which arrives back here as an extension_ui_request).
          await this.rpc?.request({ type: "prompt", message: `/select-source ${msg.name}` }, 0);
          break;
        case "selectCollection": {
          // null → the auto "all sources" collection. "(all sources)" is the exact
          // sentinel the pi-package's /select-collection maps back to null.
          const arg = msg.name ?? "(all sources)";
          await this.rpc?.request({ type: "prompt", message: `/select-collection ${arg}` }, 0);
          break;
        }
        case "refreshSessions":
          this.postSessions();
          break;
        case "refreshSources":
          this.postSources();
          break;
        case "uiResponse":
          this.pendingUiRequestIds.delete(msg.response.id);
          this.rpc?.sendUiResponse(msg.response);
          break;
        case "permissionResponse": {
          this.pendingUiRequestIds.delete(msg.id);
          if (msg.action === "always") {
            const settings = readChronosSettings(this.workspaceDir);
            const prefix = msg.prefix ?? "";
            if (prefix) {
              settings.allowedCommands = [...new Set([...(settings.allowedCommands ?? []), prefix])];
              writeChronosSettings(this.workspaceDir, settings);
            }
          }
          this.rpc?.sendUiResponse({
            type: "extension_ui_response",
            id: msg.id,
            confirmed: msg.action !== "deny",
          });
          break;
        }
        case "editMessage": {
          try {
            const data = await this.rpc?.request<{ messages: { entryId: string; text: string }[] }>({
              type: "get_fork_messages",
            });
            const wanted = msg.originalText.trim();
            const matches = (data?.messages ?? []).filter((m) => m.text.trim() === wanted);
            const target = matches[msg.occurrence] ?? matches[matches.length - 1];
            if (!target) {
              throw new Error("Could not locate this message in the session — it may predate a fork.");
            }
            const forkResult = await this.rpc?.request<{ cancelled: boolean }>(
              { type: "fork", entryId: target.entryId },
              60_000,
            );
            if (!forkResult || forkResult.cancelled) {
              this.post({ type: "resumeResult", ok: false });
              break;
            }
            const state = await this.rpc!.request<RpcSessionState>({ type: "get_state" });
            this.isStreaming = state.isStreaming;
            this.post({ type: "state", state });
            await this.postHistory(state);
            this.post({ type: "resumeResult", ok: true });
            this.postSessions();
            // Now run the edited message on the rewound branch
            await this.rpc?.request({ type: "prompt", message: msg.newText }, 0);
          } catch (err) {
            this.post({ type: "resumeResult", ok: false });
            throw err;
          }
          break;
        }
        case "setYolo": {
          const settings = readChronosSettings(this.workspaceDir);
          settings.yolo = msg.enabled;
          writeChronosSettings(this.workspaceDir, settings);
          this.post({ type: "yolo", enabled: msg.enabled });
          break;
        }
        case "viewer/navigate": {
          if (this.currentSourceDir && this.currentSourceName) {
            this.showPage(this.currentSourceDir, this.currentSourceName, msg.pageId, null);
          }
          break;
        }
        case "openViewLink":
          this.openViewLink(msg.pageId, msg.bbox, msg.sourcePath);
          break;
        case "openTextView":
          this.openTextView(msg.filePath, msg.highlight);
          break;
        case "data/listRequest":
          this.postDataFiles();
          break;
        case "data/load":
          this.postDataFile(msg.filename);
          break;
        case "data/previewSource":
          this.previewSource(msg.pageId, msg.bbox, msg.sourcePath);
          break;
        case "__test/state":
          this.testDumpResolvers.shift()?.(msg.state);
          break;
      }
    } catch (err) {
      this.post({ type: "notify", level: "error", message: (err as Error).message });
    }
  }

  // ── extension UI requests → webview dialogs ───────────────────────────────

  private async handleUiRequest(request: RpcExtensionUIRequest): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    switch (request.method) {
      case "confirm": {
        // Bash confirmations from the chronos pi-package hook get the inline
        // approval flow with a persistent allowlist instead of a dialog.
        const bashCommand =
          request.title === "Bash Command" && request.message.startsWith("Allow: ")
            ? request.message.slice("Allow: ".length)
            : undefined;
        if (bashCommand !== undefined) {
          const allowed = readChronosSettings(this.workspaceDir).allowedCommands ?? [];
          if (allowed.some((prefix) => commandMatchesPrefix(bashCommand, prefix))) {
            rpc.sendUiResponse({ type: "extension_ui_response", id: request.id, confirmed: true });
            return;
          }
          this.pendingUiRequestIds.add(request.id);
          this.post({
            type: "permissionRequest",
            id: request.id,
            command: bashCommand,
            suggestedPrefix: suggestPrefix(bashCommand),
          });
          this.panel.reveal(undefined, true);
          return;
        }
        this.pendingUiRequestIds.add(request.id);
        this.post({ type: "uiRequest", request });
        this.panel.reveal(undefined, true);
        break;
      }
      case "select":
      case "input":
      case "editor":
        this.pendingUiRequestIds.add(request.id);
        this.post({ type: "uiRequest", request });
        this.panel.reveal(undefined, true);
        break;
      case "notify": {
        this.post({
          type: "notify",
          level: request.notifyType ?? "info",
          message: request.message,
        });
        break;
      }
      case "setTitle":
        this.panel.title = request.title;
        break;
      default:
        // setStatus/setWidget/set_editor_text: fire-and-forget, no reply expected
        break;
    }
  }

  // ── webview HTML ──────────────────────────────────────────────────────────

  private getHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "webview", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "webview", "main.css"));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Chronos</title>
</head>
<body>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ChronosPanel.current = undefined;
    // Unblock any agent-side ctx.ui.* call still waiting on the webview
    for (const id of this.pendingUiRequestIds) {
      this.rpc?.sendUiResponse({ type: "extension_ui_response", id, cancelled: true });
    }
    this.pendingUiRequestIds.clear();
    void this.rpc?.stop();
    this.rpc = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
