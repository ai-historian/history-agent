import { request } from "node:http";

// Agent → Extension messages

export interface ShowPageMessage {
  type: "show_page";
  pageId: number;
  totalPages: number;
  sourceDir: string;
  sourceName: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
}

export interface PageListMessage {
  type: "page_list";
  sourceDir: string;
  sourceName: string;
  firstPage: number;
  lastPage: number;
  totalPages: number;
}

export interface ShowTextMessage {
  type: "show_text";
  filePath: string;
  content: string;
  highlight: string | null;
  sourceName: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

/** The active collection: its name (null = the auto "all sources" collection)
 * for the picker, and its collection-level output dir so the Data tab can
 * surface cross-source files (e.g. the entity index). */
export interface CollectionMessage {
  type: "collection";
  name: string | null;
  dataDir: string;
}

export type AgentToExtensionMessage =
  | ShowPageMessage
  | PageListMessage
  | ShowTextMessage
  | CollectionMessage
  | ErrorMessage;

// Extension → Agent messages

export interface PromptMessage {
  type: "prompt";
  text: string;
}

export type ExtensionToAgentMessage = PromptMessage;

let httpPort = 0;
let connected = false;

export function connectHttp(): boolean {
  const portStr = process.env.CHRONOS_HTTP_PORT;
  if (!portStr) {
    console.warn("[chronos-http] CHRONOS_HTTP_PORT not set — viewer disabled");
    return false;
  }

  httpPort = parseInt(portStr, 10);
  if (!httpPort) {
    console.warn("[chronos-http] CHRONOS_HTTP_PORT invalid:", portStr);
    return false;
  }

  connected = true;
  console.log(`[chronos-http] Connected to VS Code extension on port ${httpPort}`);
  return true;
}

export function isHttpConnected(): boolean {
  return connected;
}

export function sendToExtension(msg: AgentToExtensionMessage): void {
  if (!connected) return;

  const body = JSON.stringify(msg);
  const req = request(
    {
      hostname: "127.0.0.1",
      port: httpPort,
      path: "/message",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => { res.resume(); }, // drain response
  );
  req.on("error", (err) => {
    console.warn(`[chronos-http] Send failed (${msg.type}):`, err.message);
  });
  req.end(body);
}

export function disconnectHttp(): void {
  httpPort = 0;
  connected = false;
}
