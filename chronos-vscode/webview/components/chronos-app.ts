import { LitElement, html, nothing, type TemplateResult } from "lit";
import type {
  ModelInfo,
  RpcExtensionUIRequest,
  RpcSessionState,
} from "../../src/rpc/rpc-types";
import type {
  ChronosSessionInfo,
  ExtToWebview,
  WebviewToExt,
} from "../../src/panel/webview-protocol";
import type { ChronosChat } from "./chronos-chat";
import type { ChronosPageViewer } from "./page-viewer";
import type { ChronosDataViewer } from "./data-viewer";
import "./chronos-chat";
import "./page-viewer";
import "./data-viewer";
import brandIcon from "../assets/chronos-icon.png";

interface Toast {
  id: number;
  level: "info" | "warning" | "error";
  message: string;
}

export class ChronosApp extends LitElement {
  static properties = {
    state: { state: true },
    models: { state: true },
    sources: { state: true },
    sessions: { state: true },
    drawerOpen: { state: true },
    uiRequest: { state: true },
    toasts: { state: true },
    splitPct: { state: true },
    currentSource: { state: true },
    collections: { state: true },
    activeCollection: { state: true },
    yolo: { state: true },
    contextTokens: { state: true },
    sessionLoading: { state: true },
    viewerTab: { state: true },
    loginRequired: { state: true },
  };

  declare state: RpcSessionState | null;
  declare models: ModelInfo[];
  declare sources: { name: string; pageCount: number }[];
  declare sessions: ChronosSessionInfo[];
  declare drawerOpen: boolean;
  declare uiRequest: RpcExtensionUIRequest | null;
  declare toasts: Toast[];
  declare splitPct: number;
  declare currentSource: string;
  declare collections: { id: string; name: string; description?: string; memberCount: number }[];
  /** The active collection's id (null = the auto "all sources" collection). */
  declare activeCollection: string | null;
  declare yolo: boolean;
  declare contextTokens: number;
  declare sessionLoading: { title?: string; name: string; sizeBytes?: number } | null;
  declare viewerTab: "page" | "data";
  declare loginRequired: boolean;

  private postMessage: (msg: WebviewToExt) => void = () => {};
  private uiRequestQueue: RpcExtensionUIRequest[] = [];
  private toastSeq = 0;

  constructor() {
    super();
    this.state = null;
    this.models = [];
    this.sources = [];
    this.sessions = [];
    this.drawerOpen = false;
    this.uiRequest = null;
    this.toasts = [];
    this.splitPct = 52;
    this.currentSource = "";
    this.collections = [];
    this.activeCollection = null;
    this.yolo = false;
    this.contextTokens = 0;
    this.sessionLoading = null;
    this.viewerTab = "page";
    this.loginRequired = false;
  }

  // Context occupancy = what the next request will carry: fresh input +
  // cache-read (the cached prefix) + the latest output.
  private static usageTokens(message: any): number | undefined {
    const usage = message?.usage;
    if (!usage) return undefined;
    const tokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.output ?? 0);
    return tokens > 0 ? tokens : undefined;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  setPostMessage(fn: (msg: WebviewToExt) => void): void {
    this.postMessage = fn;
  }

  restoreUiState(saved: { splitPct?: number } | undefined): void {
    if (saved?.splitPct) this.splitPct = saved.splitPct;
  }

  getUiState(): { splitPct: number } {
    return { splitPct: this.splitPct };
  }

  private get chat(): ChronosChat | null {
    return this.querySelector("chronos-chat");
  }

  private get viewer(): ChronosPageViewer | null {
    return this.querySelector("chronos-page-viewer");
  }

  private get dataViewer(): ChronosDataViewer | null {
    return this.querySelector("chronos-data-viewer");
  }

  handleMessage(msg: ExtToWebview): void {
    switch (msg.type) {
      case "agentEvent": {
        this.chat?.handleAgentEvent(msg.event);
        const event = msg.event;
        if (event.type === "message_end" && (event.message as any)?.role === "assistant") {
          const tokens = ChronosApp.usageTokens(event.message);
          if (tokens) this.contextTokens = tokens;
        }
        break;
      }
      case "state":
        this.state = msg.state;
        this.chat?.applyState(msg.state);
        break;
      case "models":
        this.models = msg.models;
        break;
      case "loginRequired":
        this.loginRequired = msg.required;
        break;
      case "viewer/clearSource":
        // New session has no source bound — reset the display to match.
        this.currentSource = "";
        this.viewer?.clearSource();
        this.dataViewer?.clearSource();
        this.viewerTab = "page";
        break;
      case "commands":
        this.chat?.setCommands(msg.commands);
        break;
      case "history": {
        this.chat?.loadHistory(msg.messages);
        // Seed the context meter from the newest assistant usage on record
        this.contextTokens = 0;
        for (let i = msg.messages.length - 1; i >= 0; i--) {
          const tokens = ChronosApp.usageTokens(msg.messages[i]);
          if (tokens && (msg.messages[i] as any).role === "assistant") {
            this.contextTokens = tokens;
            break;
          }
        }
        // Keep the loading overlay up until the transcript is actually
        // painted — Lit commit first, then two frames for layout/paint.
        if (this.sessionLoading) {
          void this.chat?.updateComplete.then(() => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                this.sessionLoading = null;
              }),
            );
          });
        }
        break;
      }
      case "agentExited":
        this.chat?.handleAgentExited(msg.code, msg.stderr);
        break;
      case "agentRestarted":
        this.chat?.handleAgentRestarted();
        break;
      case "uiRequest":
        if (this.uiRequest) {
          this.uiRequestQueue.push(msg.request);
        } else {
          this.uiRequest = msg.request;
        }
        break;
      case "notify":
        this.pushToast(msg.level, msg.message);
        break;
      case "permissionRequest":
        this.chat?.addPermissionRequest({ id: msg.id, command: msg.command, suggestedPrefix: msg.suggestedPrefix });
        break;
      case "yolo":
        this.yolo = msg.enabled;
        break;
      case "sources":
        this.sources = msg.sources;
        break;
      case "collections":
        this.collections = msg.collections;
        this.activeCollection = msg.active;
        break;
      case "sessions":
        this.sessions = msg.sessions;
        break;
      case "resumeResult":
        if (!msg.ok) {
          // Failure/cancel: nothing else will arrive — drop the overlay now.
          this.sessionLoading = null;
        } else if (this.sessionLoading) {
          // Success: the history handler clears after paint; this is a backstop
          // in case no history message ever lands.
          setTimeout(() => {
            this.sessionLoading = null;
          }, 15_000);
        }
        break;
      case "viewer/showPage":
        this.currentSource = msg.sourceName;
        // An explicit page (agent or a data-row "view source" click) brings the
        // Page tab forward so the cited region is visible.
        this.viewerTab = "page";
        this.viewer?.showPage(msg.imageUri, msg.pageId, msg.sourceName, msg.firstPage, msg.lastPage, msg.bbox);
        break;
      case "viewer/showText":
        this.viewerTab = "page";
        this.viewer?.showText(
          { filePath: msg.filePath, content: msg.content, highlight: msg.highlight },
          msg.sourceName,
        );
        break;
      case "viewer/updateRange":
        this.viewer?.updateRange(msg.firstPage, msg.lastPage);
        break;
      case "data/list":
        this.dataViewer?.setFiles(msg.sourceName, msg.files);
        break;
      case "data/show":
        this.dataViewer?.showFile(msg.filename, msg.content);
        break;
      case "data/sourcePreview":
        this.dataViewer?.showSourcePreview(msg.imageUri, msg.pageId, msg.bbox, msg.sourceName);
        break;
      case "__test/invoke":
        this.runTestAction(msg.action, msg.arg);
        break;
      case "__test/dump":
        this.postMessage({ type: "__test/state", state: this.collectTestState() });
        break;
    }
  }

  // ── test seam (integration tests drive the UI via the host) ───────────────

  private runTestAction(action: string, arg?: string): void {
    switch (action) {
      case "sendPrompt":
        this.chat?.testSubmit(arg ?? "");
        break;
      case "openDataTab":
        this.viewerTab = "data";
        this.postMessage({ type: "data/listRequest" });
        break;
      case "openPageTab":
        this.viewerTab = "page";
        break;
      case "newSession":
        this.postMessage({ type: "newSession" });
        break;
      case "injectExpertTools":
        this.chat?.testInjectExpertWithTools();
        break;
      case "selectDataFile":
        if (arg) this.dataViewer?.testSelect(arg);
        break;
      case "viewFirstRow":
        this.dataViewer?.testViewFirstRow();
        break;
      case "showFullPage":
        this.dataViewer?.testShowFullPage();
        break;
      case "clickReopen":
        this.querySelector<HTMLButtonElement>(".view-reopen")?.click();
        break;
    }
  }

  private collectTestState(): unknown {
    return {
      currentSource: this.currentSource,
      viewerTab: this.viewerTab,
      chat: this.chat?.testSnapshot() ?? null,
      viewer: this.viewer?.testSnapshot() ?? null,
      data: this.dataViewer?.testSnapshot() ?? null,
    };
  }

  private pushToast(level: Toast["level"], message: string): void {
    const toast: Toast = { id: ++this.toastSeq, level, message };
    this.toasts = [...this.toasts, toast];
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== toast.id);
    }, level === "error" ? 10_000 : 5_000);
  }

  private answerUiRequest(response: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
    if (!this.uiRequest) return;
    this.postMessage({
      type: "uiResponse",
      response: { type: "extension_ui_response", id: this.uiRequest.id, ...response } as any,
    });
    this.uiRequest = this.uiRequestQueue.shift() ?? null;
  }

  // ── splitter ──────────────────────────────────────────────────────────────

  private onSplitterDown(e: PointerEvent): void {
    e.preventDefault();
    const root = this.querySelector<HTMLElement>("#app-main");
    if (!root) return;
    // Capture on the splitter so a pointerup released outside the webview still
    // tears the listeners down (a missed window pointerup would leak onMove).
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      this.splitPct = Math.max(25, Math.min(75, ((ev.clientX - rect.left) / rect.width) * 100));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      this.dispatchEvent(new CustomEvent("ui-state-changed", { bubbles: true }));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("lostpointercapture", onUp); // also covers pointercancel
  }

  // ── render ────────────────────────────────────────────────────────────────

  render(): TemplateResult {
    return html`
      <div id="app-root" @keydown=${(e: KeyboardEvent) => { if (this.viewerTab === "page") this.viewer?.handleKeydown(e); }}>
        ${this.renderHeader()}
        ${this.loginRequired ? this.renderLoginBanner() : nothing}
        <div id="app-main">
          <div id="pane-viewer" style="flex-basis:${this.splitPct}%">
            <div class="pv-tabs">
              <button class="pv-tab ${this.viewerTab === "page" ? "is-active" : ""}" @click=${() => (this.viewerTab = "page")}>Page</button>
              <button class="pv-tab ${this.viewerTab === "data" ? "is-active" : ""}" @click=${() => {
                this.viewerTab = "data";
                this.postMessage({ type: "data/listRequest" });
              }}>Data</button>
            </div>
            <div class="pv-tab-body">
              <chronos-page-viewer ?hidden=${this.viewerTab !== "page"}></chronos-page-viewer>
              <chronos-data-viewer ?hidden=${this.viewerTab !== "data"}></chronos-data-viewer>
            </div>
          </div>
          <div id="splitter" @pointerdown=${this.onSplitterDown} title="Drag to resize"></div>
          <div id="pane-chat" style="flex-basis:${100 - this.splitPct}%">
            <chronos-chat></chronos-chat>
          </div>
        </div>
        ${this.drawerOpen ? this.renderDrawer() : nothing}
        ${this.uiRequest ? this.renderUiRequest() : nothing}
        ${this.sessionLoading ? this.renderSessionLoading() : nothing}
        ${this.toasts.length ? this.renderToasts() : nothing}
      </div>
    `;
  }

  private renderHeader(): TemplateResult {
    const model = this.state?.model;
    return html`
      <header id="app-header">
        <div class="brand">
          <img class="brand-mark" src=${brandIcon} width="18" height="18" alt="" aria-hidden="true" />
          <span class="brand-name">Chronos</span>
        </div>
        <div class="header-controls">
          ${this.collections.length > 0
            ? html`<label class="control">
                <span class="control-label">Collection</span>
                <select
                  class="control-select"
                  .value=${this.activeCollection ?? ""}
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    this.postMessage({ type: "selectCollection", id: v === "" ? null : v });
                  }}
                >
                  <option value="" ?selected=${this.activeCollection === null}>All sources</option>
                  ${this.collections.map(
                    (c) => html`<option value=${c.id} ?selected=${c.id === this.activeCollection}>
                      ${c.name} (${c.memberCount})
                    </option>`,
                  )}
                </select>
              </label>`
            : nothing}
          <label class="control">
            <span class="control-label">Source</span>
            <select
              class="control-select"
              .value=${this.currentSource}
              @change=${(e: Event) => {
                const name = (e.target as HTMLSelectElement).value;
                if (name) this.postMessage({ type: "selectSource", name });
              }}
            >
              <option value="" ?selected=${!this.currentSource}>— none —</option>
              ${this.sources.map(
                (s) => html`<option value=${s.name} ?selected=${s.name === this.currentSource || s.name.endsWith("/" + this.currentSource)}>
                  ${s.name} (${s.pageCount} pp.)
                </option>`,
              )}
            </select>
          </label>
          <label class="control">
            <span class="control-label">Model</span>
            <select
              class="control-select"
              @change=${(e: Event) => {
                const value = (e.target as HTMLSelectElement).value;
                const [provider, ...rest] = value.split("/");
                if (provider && rest.length) {
                  this.postMessage({ type: "setModel", provider, modelId: rest.join("/") });
                }
              }}
            >
              ${!model
                ? html`<option selected disabled>${this.loginRequired ? "— log in —" : "loading…"}</option>`
                : nothing}
              ${this.models.map((m) => {
                const id = `${m.provider}/${m.id}`;
                const current = model ? `${model.provider}/${model.id}` === id : false;
                return html`<option value=${id} ?selected=${current}>${id}</option>`;
              })}
            </select>
          </label>
          ${this.renderContextMeter()}
          <button
            class="header-btn login-btn ${this.loginRequired ? "is-attn" : ""}"
            title="Connect an AI provider (Claude subscription sign-in, or an API key)"
            @click=${() => this.postMessage({ type: "login" })}
          >
            Log in
          </button>
          <button
            class="header-btn yolo-toggle ${this.yolo ? "is-on" : ""}"
            title=${this.yolo
              ? "Auto-approve is ON — commands run without asking"
              : "Auto-approve is OFF — commands ask for permission"}
            @click=${() => this.postMessage({ type: "setYolo", enabled: !this.yolo })}
          >
            <span class="yolo-dot"></span>Auto-approve
          </button>
          <button class="header-btn" title="Past sessions" @click=${() => {
            this.postMessage({ type: "refreshSessions" });
            this.drawerOpen = true;
          }}>History</button>
          <button class="header-btn" title="Start a fresh session" @click=${() => this.postMessage({ type: "newSession" })}>New</button>
        </div>
      </header>
    `;
  }

  private renderLoginBanner(): TemplateResult {
    return html`
      <div class="login-banner">
        <span class="login-banner-text">
          <strong>No AI models available.</strong>
          Connect a provider to get started — sign in with your Claude subscription, or add an API key.
        </span>
        <button class="login-banner-btn" @click=${() => this.postMessage({ type: "login" })}>
          Connect provider
        </button>
      </div>
    `;
  }

  private renderContextMeter(): TemplateResult | typeof nothing {
    const window = this.state?.model?.contextWindow;
    if (!window || !this.contextTokens) return nothing;
    const pct = Math.min(100, Math.round((this.contextTokens / window) * 100));
    const level = pct >= 90 ? "is-critical" : pct >= 70 ? "is-high" : "";
    // SVG ring: r=5.5 → circumference ≈ 34.56
    const circumference = 34.56;
    const offset = circumference * (1 - pct / 100);
    const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    return html`
      <div
        class="ctx-meter ${level}"
        title="Context window: ${this.contextTokens.toLocaleString()} of ${window.toLocaleString()} tokens used (${pct}%)${pct >= 70 ? " — pi will compact automatically when full" : ""}"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.18"/>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" transform="rotate(-90 7 7)"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
        </svg>
        <span class="ctx-meter-label">${fmt(this.contextTokens)} · ${pct}%</span>
      </div>
    `;
  }

  private renderDrawer(): TemplateResult {
    const fmt = (ts: number) =>
      new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return html`
      <div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>
      <aside class="drawer">
        <div class="drawer-header">
          <span class="drawer-title">Sessions</span>
          <button class="icon-btn" title="Close" @click=${() => (this.drawerOpen = false)}>✕</button>
        </div>
        <div class="drawer-list">
          ${this.sessions.length === 0 ? html`<div class="drawer-empty">No past sessions in this workspace.</div>` : nothing}
          ${this.sessions.map(
            (s) => html`
              <button
                class="session-row ${s.path === this.state?.sessionFile ? "is-current" : ""}"
                @click=${() => {
                  this.drawerOpen = false;
                  if (s.path !== this.state?.sessionFile) {
                    this.sessionLoading = { name: s.name, sizeBytes: s.sizeBytes };
                    this.postMessage({ type: "resumeSession", sessionPath: s.path });
                  }
                }}
              >
                <span class="session-name">${s.name}</span>
                <span class="session-meta">${fmt(s.timestamp)} · ${s.messageCount} messages</span>
              </button>
            `,
          )}
        </div>
      </aside>
    `;
  }

  private renderUiRequest(): TemplateResult {
    const req = this.uiRequest!;
    let body: TemplateResult = html``;
    switch (req.method) {
      case "select":
        body = html`
          <div class="dialog-options">
            ${req.options.map(
              (opt) => html`<button class="dialog-option" @click=${() => this.answerUiRequest({ value: opt })}>${opt}</button>`,
            )}
          </div>
        `;
        break;
      case "confirm":
        body = html`
          <div class="dialog-message">${req.message}</div>
          <div class="dialog-actions">
            <button class="btn-secondary" @click=${() => this.answerUiRequest({ confirmed: false })}>Deny</button>
            <button class="btn-send" @click=${() => this.answerUiRequest({ confirmed: true })}>Allow</button>
          </div>
        `;
        break;
      case "input":
      case "editor": {
        const isEditor = req.method === "editor";
        body = html`
          ${isEditor
            ? html`<textarea id="dialog-input" class="dialog-textarea" rows="8">${(req as any).prefill ?? ""}</textarea>`
            : html`<input id="dialog-input" class="dialog-input" placeholder=${(req as any).placeholder ?? ""} @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  this.answerUiRequest({ value: (e.target as HTMLInputElement).value });
                }
              }} />`}
          <div class="dialog-actions">
            <button class="btn-secondary" @click=${() => this.answerUiRequest({ cancelled: true })}>Cancel</button>
            <button class="btn-send" @click=${() => {
              const el = this.querySelector<HTMLInputElement | HTMLTextAreaElement>("#dialog-input");
              this.answerUiRequest({ value: el?.value ?? "" });
            }}>OK</button>
          </div>
        `;
        break;
      }
      default:
        body = html`<div class="dialog-actions"><button class="btn-secondary" @click=${() => this.answerUiRequest({ cancelled: true })}>Dismiss</button></div>`;
    }
    return html`
      <div class="dialog-backdrop"></div>
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-title">${"title" in req ? req.title : "Chronos"}</div>
        ${body}
        ${req.method === "select"
          ? html`<div class="dialog-actions"><button class="btn-secondary" @click=${() => this.answerUiRequest({ cancelled: true })}>Cancel</button></div>`
          : nothing}
      </div>
    `;
  }

  private renderSessionLoading(): TemplateResult {
    const loading = this.sessionLoading!;
    const sizeMb = loading.sizeBytes ? loading.sizeBytes / (1024 * 1024) : 0;
    const isBig = sizeMb >= 5;
    return html`
      <div class="dialog-backdrop"></div>
      <div class="session-loading" role="status">
        <span class="spinner spinner-lg"></span>
        <div class="session-loading-title">${loading.title ?? "Opening session"}</div>
        <div class="session-loading-name">${loading.name}</div>
        ${isBig
          ? html`<div class="session-loading-hint">
              Large session (${sizeMb.toFixed(0)} MB) — rebuilding the agent's context can take a few seconds.
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderToasts(): TemplateResult {
    return html`
      <div class="toasts">
        ${this.toasts.map((t) => html`<div class="toast toast-${t.level}">${t.message}</div>`)}
      </div>
    `;
  }

  protected firstUpdated(): void {
    this.chat?.setPostMessage((msg) => this.postMessage(msg));
    this.viewer?.setPostMessage((msg) => this.postMessage(msg));
    this.dataViewer?.setPostMessage((msg) => this.postMessage(msg));
    this.addEventListener("rewind-start", (e) => {
      const preview = (e as CustomEvent).detail?.preview ?? "";
      this.sessionLoading = {
        title: "Rewinding conversation",
        name: preview.length > 60 ? preview.slice(0, 60) + "…" : preview,
      };
    });
  }
}

customElements.define("chronos-app", ChronosApp);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-app": ChronosApp;
  }
}
