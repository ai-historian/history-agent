#!/usr/bin/env node
// Mock `pi --mode rpc` for chat-UI integration tests. Speaks the JSONL contract
// (src/rpc/rpc-types.ts): reads commands on stdin, writes responses + agent
// events on stdout. Behavior for `prompt` is keyed off the message text so one
// mock covers several scenarios. Never writes non-JSON to stdout.
//
// Scenarios (by message prefix):
//   "select: …"        → POST a show_page over HTTP (establishes the active
//                         source), then reply with assistant text "source selected".
//   "select-nested: …" → same, but for the nested fixture source
//                         (sources/city/Nested_1900), sending the sourceName the
//                         real agent would send for it: the slugged data key
//                         "city--Nested_1900" (basename(dataDir), not basename(path)).
//   "tool: …"    → emit a tool_execution_start/end (list_pages), then "done".
//   anything     → emit assistant text "echo: <message>".
import { createInterface } from "node:readline";
import { request } from "node:http";
import { join } from "node:path";

const MODEL = {
  id: "mock-model",
  name: "Mock Model",
  provider: "mock",
  reasoning: false,
  contextWindow: 100000,
  input: ["text", "image"],
};
let model = MODEL;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(command, id, data) {
  if (!id) return;
  send({ type: "response", command, id, success: true, data });
}

function state() {
  return {
    model,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    sessionId: "mock-session-1",
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

// Push a viewer event back to the extension (the agent→ext HTTP channel).
function httpPost(msg) {
  const port = process.env.CHRONOS_HTTP_PORT;
  if (!port) return;
  const body = JSON.stringify(msg);
  const req = request(
    {
      hostname: "127.0.0.1",
      port: Number(port),
      path: "/message",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.end(body);
}

function assistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "mock",
    model: "mock-model",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emitAssistant(text) {
  const msg = assistant(text);
  send({ type: "agent_start" });
  send({ type: "message_start", message: msg });
  send({ type: "message_end", message: msg });
  send({ type: "agent_end", messages: [msg] });
}

function emitToolThenAssistant(toolName, text) {
  send({ type: "agent_start" });
  send({ type: "tool_execution_start", toolCallId: "tc-1", toolName, args: {} });
  send({
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName,
    result: { content: [{ type: "text", text: "tool ok" }] },
    isError: false,
  });
  const msg = assistant(text);
  send({ type: "message_end", message: msg });
  send({ type: "agent_end", messages: [msg] });
}

function handlePrompt(message) {
  const m = (message || "").trim();
  if (m.startsWith("select-nested:")) {
    httpPost({
      type: "show_page",
      pageId: 1,
      totalPages: 1,
      sourceDir: join(process.cwd(), "sources", "city", "Nested_1900"),
      sourceName: "city--Nested_1900",
      bbox: null,
    });
    emitAssistant("nested source selected");
  } else if (m.startsWith("select:")) {
    httpPost({
      type: "show_page",
      pageId: 1,
      totalPages: 1,
      sourceDir: join(process.cwd(), "sources", "TestSource"),
      sourceName: "TestSource",
      bbox: null,
    });
    emitAssistant("source selected");
  } else if (m.startsWith("tool:")) {
    emitToolThenAssistant("list_pages", "done");
  } else if (m.startsWith("showpage:")) {
    // A show_page tool call — the chat renders a re-open icon on its entry.
    send({ type: "agent_start" });
    send({
      type: "tool_execution_start",
      toolCallId: "tc-2",
      toolName: "show_page",
      args: { page_id: 1, bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 } },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "tc-2",
      toolName: "show_page",
      result: { content: [{ type: "text", text: "[view p.1]" }] },
      isError: false,
    });
    const msg = assistant("shown page 1");
    send({ type: "message_end", message: msg });
    send({ type: "agent_end", messages: [msg] });
  } else {
    emitAssistant(`echo: ${m}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  const { id, type } = cmd;
  switch (type) {
    case "get_state":
      respond(type, id, state());
      break;
    case "get_available_models":
      respond(type, id, { models: [model] });
      break;
    case "get_commands":
      respond(type, id, { commands: [] });
      break;
    case "get_messages":
    case "get_fork_messages":
      respond(type, id, { messages: [] });
      break;
    case "set_model":
      model = { ...model, id: cmd.modelId, provider: cmd.provider };
      respond(type, id, {});
      break;
    case "prompt":
    case "steer":
    case "follow_up":
      handlePrompt(cmd.message);
      respond(type, id, {});
      break;
    case "new_session":
    case "switch_session":
    case "fork":
      respond(type, id, { cancelled: false });
      break;
    case "abort":
    case "compact":
    case "set_thinking_level":
    case "set_session_name":
      respond(type, id, {});
      break;
    default:
      respond(type || "unknown", id, {});
  }
});

// Stay alive until the parent kills us, even if stdin drains.
process.stdin.resume();
