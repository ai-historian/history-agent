import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { piAgentDir } from "../pi-env";
import type { ChronosSessionInfo } from "./webview-protocol";

// Lightweight scan of pi session JSONL files in <workspace>/sessions.
// Format (session-manager v3): line 1 is {type:"session", id, timestamp, cwd},
// then entries; "message" entries carry conversation messages, "session_info"
// entries carry an optional user-defined display name.

function firstTextOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
    }
  }
  return undefined;
}

// Session files can reach tens of MB (vision tool results embed base64 page
// images), so the drawer scan avoids JSON.parse on bulk lines: it counts by
// line prefix and only parses the header, the first user message, and
// session_info entries. Results are cached by (mtime, size).
const sessionInfoCache = new Map<string, { mtime: number; size: number; info: ChronosSessionInfo }>();

function parseSessionFile(filePath: string): ChronosSessionInfo | undefined {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }
  const cached = sessionInfoCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    return cached.info;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return undefined;
  }
  if (header?.type !== "session") return undefined;

  let name: string | undefined;
  let firstUserMessage: string | undefined;
  let messageCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Count only USER prompts — assistant/tool messages inflate the number on an
    // agent that fans out many expert turns per prompt and tell the user nothing.
    // The substring is just a cheap pre-filter (it avoids parsing the multi-MB
    // base64 lines); confirm the real role so a tool/assistant line that merely
    // embeds `"role":"user"` (e.g. an echoed sub-conversation) isn't miscounted.
    if (line.startsWith('{"type":"message"') && line.includes('"role":"user"')) {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.role === "user") {
          messageCount++;
          if (!firstUserMessage) {
            const text = firstTextOf(entry.message?.content);
            // Skip the synthetic "Source selected: …" follow-up that /select-source
            // injects, so it never becomes the session label (the agent-side namer
            // skips it too; this keeps the degraded fallback meaningful).
            if (text && !text.startsWith("Source selected:")) {
              firstUserMessage = text.slice(0, 200);
            }
          }
        }
      } catch {
        // skip malformed line
      }
    } else if (line.startsWith('{"type":"session_info"')) {
      try {
        const entry = JSON.parse(line);
        if (entry.name) name = entry.name;
      } catch {
        // skip malformed line
      }
    }
  }

  const info: ChronosSessionInfo = {
    path: filePath,
    // Sidecar-generated name is overlaid in scanDir (it can change after this
    // file's mtime/size last did, so it must stay out of the per-file cache).
    name: name ?? firstUserMessage?.slice(0, 80) ?? "(empty session)",
    timestamp: Date.parse(header.timestamp) || stat.mtimeMs,
    messageCount,
    firstUserMessage,
    sizeBytes: stat.size,
    sessionId: typeof header.id === "string" ? header.id : undefined,
    userName: name,
  };
  sessionInfoCache.set(filePath, { mtime: stat.mtimeMs, size: stat.size, info });
  return info;
}

// Auto-generated session names written by the pi-package (.chronos/session-names.json),
// keyed by pi session id. Read fresh per listing — the file is tiny and updates
// independently of the session JSONL, so it can't be folded into the file cache.
// Each value is `{ name, fromPrompts }` (a bare string is also accepted for
// forward/backward tolerance).
function readGeneratedNames(workspaceDir: string): Record<string, { name?: string } | string> {
  try {
    const parsed = JSON.parse(readFileSync(join(workspaceDir, ".chronos", "session-names.json"), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function generatedName(entry: { name?: string } | string | undefined): string | undefined {
  if (typeof entry === "string") return entry || undefined;
  return entry?.name || undefined;
}

// pi's default per-project session location: <agent-dir>/sessions/--<cwd>--
// (used by sessions created before the extension started pinning
// PI_CODING_AGENT_SESSION_DIR to <workspace>/sessions).
function defaultPiSessionDir(workspaceDir: string): string {
  const encoded = `--${resolve(workspaceDir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(piAgentDir(), "sessions", encoded);
}

function scanDir(
  dir: string,
  sessions: Map<string, ChronosSessionInfo>,
  generatedNames: Record<string, { name?: string } | string>,
): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }
  for (const file of files) {
    let info = parseSessionFile(join(dir, file));
    // Key by file basename (timestamp_sessionId) so the same session never
    // shows twice if both locations somehow contain it
    if (!info || sessions.has(file)) continue;
    // Overlay the auto-generated name when the user hasn't set one explicitly.
    if (!info.userName && info.sessionId) {
      const gen = generatedName(generatedNames[info.sessionId]);
      if (gen) info = { ...info, name: gen };
    }
    sessions.set(file, info);
  }
}

// Full transcript of a session file. The RPC get_messages command returns the
// agent's LLM *context*, which loses early turns to compaction on long
// sessions — the JSONL file keeps everything. Entries form a parent-linked
// tree; walking up from the last entry yields the active branch only.
export function readSessionMessages(sessionFile: string): any[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined;
  }
  const entries: any[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  if (entries.length === 0) return undefined;

  const byId = new Map<string, any>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }
  const path: any[] = [];
  const seen = new Set<any>();
  let current: any = entries[entries.length - 1];
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  const messages: any[] = [];
  for (const entry of path) {
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message);
    } else if (entry.type === "compaction") {
      // Synthetic marker so the UI can show where context was compacted.
      // Uses a custom role — renderers ignore unknown roles by default.
      messages.push({
        role: "compaction_marker",
        summary: entry.summary ?? "",
        tokensBefore: entry.tokensBefore,
        timestamp: Date.parse(entry.timestamp) || undefined,
      });
    }
  }
  return messages;
}

export function listSessions(workspaceDir: string): ChronosSessionInfo[] {
  const sessions = new Map<string, ChronosSessionInfo>();
  const generatedNames = readGeneratedNames(workspaceDir);
  scanDir(join(workspaceDir, "sessions"), sessions, generatedNames);
  scanDir(defaultPiSessionDir(workspaceDir), sessions, generatedNames);
  return [...sessions.values()].sort((a, b) => b.timestamp - a.timestamp);
}
