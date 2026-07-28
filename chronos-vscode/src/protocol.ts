// Agent → Extension messages, pushed over HTTP. This is the one-way viewer
// channel: the agent's viewer tools (show_page / list_pages / show_text /
// change_source) POST these to the extension, which bridges them to the chat
// panel's page viewer. Chat/tool streaming travels over RPC instead.

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

// The active collection: its id (the stable identity the picker matches
// against; null = the auto "all sources" collection), its display name, and
// its collection-level output dir so the Data tab can surface cross-source
// files (e.g. the entity index) alongside the current source's.
export interface CollectionMessage {
  type: "collection";
  id: string | null;
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
