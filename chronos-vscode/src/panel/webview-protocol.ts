// Typed message protocol between the extension host and the Chronos webview.
// Imported by both bundles (src/ and webview/) — single source of truth.

import type {
  AgentEvent,
  AgentMessage,
  ModelInfo,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
  RpcSlashCommand,
  ThinkingLevel,
} from "../rpc/rpc-types";

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChronosSessionInfo {
  path: string;
  name: string;
  timestamp: number;
  /** Count of USER prompts in the session (not assistant/tool messages). */
  messageCount: number;
  firstUserMessage?: string;
  sizeBytes?: number;
  /** pi session id (header.id) — keys the auto-name sidecar. */
  sessionId?: string;
  /** Explicit user-set name (pi session_info), if any. Absent → name is a fallback. */
  userName?: string;
}

export type ExtToWebview =
  // chat / agent
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "state"; state: RpcSessionState }
  | { type: "models"; models: ModelInfo[] }
  | { type: "commands"; commands: RpcSlashCommand[] }
  | { type: "history"; messages: AgentMessage[] }
  | { type: "agentExited"; code: number | null; stderr: string }
  | { type: "agentRestarted" }
  | { type: "uiRequest"; request: RpcExtensionUIRequest }
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  // inline tool-call approval (bash confirms intercepted from uiRequest)
  | { type: "permissionRequest"; id: string; command: string; suggestedPrefix: string }
  | { type: "yolo"; enabled: boolean }
  // workspace data
  | { type: "sources"; sources: { name: string; pageCount: number }[] }
  | {
      type: "collections";
      collections: { id: string; name: string; description?: string; memberCount: number }[];
      // Active collection id; null = the auto "all sources" collection.
      active: string | null;
    }
  | { type: "sessions"; sessions: ChronosSessionInfo[] }
  | { type: "resumeResult"; ok: boolean }
  // auth: no models are available until the user connects a provider
  | { type: "loginRequired"; required: boolean }
  // new session: clear the viewer + source dropdown so display matches selection
  | { type: "viewer/clearSource" }
  // viewer (image URI already resolved via asWebviewUri)
  | {
      type: "viewer/showPage";
      imageUri: string;
      pageId: number;
      sourceName: string;
      firstPage: number;
      lastPage: number;
      bbox: Bbox | null;
    }
  | {
      type: "viewer/showText";
      filePath: string;
      content: string;
      highlight: string | null;
      sourceName: string;
    }
  | { type: "viewer/updateRange"; firstPage: number; lastPage: number }
  // dataset viewer: files under the current source's data/ dir, and one file's content
  | { type: "data/list"; sourceName: string; files: string[] }
  | { type: "data/show"; sourceName: string; filename: string; content: string }
  // resolved page image for the data viewer's inline crop preview
  | { type: "data/sourcePreview"; imageUri: string; pageId: number; bbox: Bbox | null; sourceName: string }
  // test-only seam (integration tests): simulate a user action / request a state snapshot
  | { type: "__test/invoke"; action: string; arg?: string }
  | { type: "__test/dump" };

export type WebviewToExt =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "restartAgent" }
  | { type: "newSession" }
  // connect an AI provider: pick a provider, enter its API key, restart the agent
  | { type: "login" }
  | { type: "resumeSession"; sessionPath: string }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: ThinkingLevel }
  | { type: "selectSource"; name: string }
  // pick the active collection; id null = the auto "all sources" collection
  | { type: "selectCollection"; id: string | null }
  | { type: "refreshSessions" }
  | { type: "refreshSources" }
  | { type: "uiResponse"; response: RpcExtensionUIResponse }
  | { type: "permissionResponse"; id: string; action: "allow" | "always" | "deny"; prefix?: string }
  // edit a past user message: fork the session to just before it, then send
  // the edited text. occurrence disambiguates identical message texts.
  | { type: "editMessage"; originalText: string; occurrence: number; newText: string }
  | { type: "setYolo"; enabled: boolean }
  | { type: "viewer/navigate"; pageId: number }
  | { type: "openViewLink"; pageId: number; bbox: Bbox | null; sourcePath?: string }
  // re-open a text file the agent showed earlier (the content isn't in the chat)
  | { type: "openTextView"; filePath: string; highlight: string | null }
  // dataset viewer requests
  | { type: "data/listRequest" }
  | { type: "data/load"; filename: string }
  // ask the host to resolve a cited page's image for the inline crop preview
  | { type: "data/previewSource"; pageId: number; bbox: Bbox | null; sourcePath?: string }
  // test-only seam: the webview's state snapshot, in reply to __test/dump
  | { type: "__test/state"; state: unknown };
