// Runs INSIDE the VS Code extension host (launched by run-ui-test.mjs).
// Asserts the chat-UI startup path AND interaction flows end to end:
// command → ChronosPanel webview → mock pi RPC subprocess → rendered UI.
const vscode = require("vscode");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for: ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
}

function findChronosTab() {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.label.startsWith("Chronos")) return tab;
    }
  }
  return undefined;
}

exports.run = async function run() {
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // Sanity: the dev extension is present
  const ext = vscode.extensions.getExtension("AI-Historian.chronos-ai-historian");
  check("extension present", !!ext, ext?.packageJSON.version);

  const api = await ext.activate();

  await vscode.commands.executeCommand("chronos.startSession");
  check("chronos.startSession executed", true);

  await waitFor("Chronos tab", () => !!findChronosTab());
  check("Chronos webview tab opened", true);

  // pi renames its process title to plain "pi", so don't pgrep — ask the
  // extension for its own status (exposed for exactly this purpose).
  await waitFor("agent ready", () => {
    const status = api.getChronosStatus();
    if (status?.agentStatus === "failed" || status?.agentStatus === "exited") {
      throw new Error(`agent ${status.agentStatus}: ${status.lastError}`);
    }
    return status?.agentStatus === "ready";
  });
  const status = api.getChronosStatus();
  check("pi RPC agent ready", true, `pid ${status?.agentPid}`);

  // The webview posts "ready" once its bundle executed without crashing
  await waitFor("webview ready handshake", () => api.getChronosStatus()?.webviewReady === true);
  check("webview bundle booted (ready handshake)", true);

  // ── interaction flows (driven through the test seam against the mock pi) ──
  const dump = () => api.chronosTest.dump();

  // 1. Prompt → assistant message renders in the chat
  api.chronosTest.invoke("sendPrompt", "hello world");
  await waitFor("assistant reply rendered", async () => {
    const s = await dump();
    return s?.chat?.userCount >= 1 && (s?.chat?.lastAssistant || "").includes("hello world");
  });
  check("prompt → assistant message renders", true);

  // 2. Tool call → a tool card appears
  api.chronosTest.invoke("sendPrompt", "tool: please list");
  await waitFor("tool card rendered", async () => {
    const s = await dump();
    return (s?.chat?.toolNames || []).includes("list_pages");
  });
  check("tool call renders a tool card", true);

  // 3. Source selection (mock pushes show_page over HTTP) → viewer + data dir
  api.chronosTest.invoke("sendPrompt", "select: TestSource");
  await waitFor("source active in viewer", async () => (await dump())?.currentSource === "TestSource");
  check("show_page over HTTP drives the viewer", true);

  // 4. Dataset viewer: write a provenance-bearing file, open the Data tab,
  //    confirm it parses as a table with provenance.
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const dataDir = join(ws, "data", "TestSource");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "entries.json"),
    JSON.stringify(
      [
        { surname: "Müller", trade: "baker", chronos_page: 1, chronos_bbox: [0.1, 0.2, 0.5, 0.1] },
        { surname: "Schmidt", trade: "smith", chronos_page: 1, chronos_bbox: [0.1, 0.35, 0.5, 0.1] },
      ],
      null,
      2,
    ),
  );
  api.chronosTest.invoke("openDataTab");
  await waitFor("data file parsed as table", async () => {
    const s = await dump();
    return (
      s?.viewerTab === "data" &&
      (s?.data?.files || []).includes("entries.json") &&
      s?.data?.selected === "entries.json" &&
      s?.data?.rowCount === 2 &&
      s?.data?.hasProvenance === true &&
      (s?.data?.columns || []).includes("surname") &&
      !(s?.data?.columns || []).includes("chronos_page")
    );
  });
  check("dataset viewer renders table + hides provenance columns", true);

  // 5. Row provenance → inline crop preview in the data viewer (stays on Data —
  //    the source and data viewers are independent).
  api.chronosTest.invoke("viewFirstRow");
  await waitFor("inline source preview shown", async () => {
    const s = await dump();
    return s?.viewerTab === "data" && s?.data?.preview?.pageId === 1 && s?.data?.preview?.hasImage === true;
  });
  check("row 'view source' previews the page inline (no tab switch)", true);

  // 5b. "Show full page" is the only thing that hands off to the source viewer.
  api.chronosTest.invoke("showFullPage");
  await waitFor("show full page opens source viewer", async () => {
    const s = await dump();
    return s?.viewerTab === "page" && s?.viewer?.pageId === 1;
  });
  check("'Show full page' switches to the source viewer", true);

  // 6. Re-open icon on a viewer tool entry (in the reasoning area): a show_page
  //    tool call gets a "view" button; switch away, click it, viewer comes back.
  api.chronosTest.invoke("sendPrompt", "showpage: 1");
  await waitFor("show_page tool entry present", async () => {
    const s = await dump();
    return (s?.chat?.toolNames || []).includes("show_page");
  });
  api.chronosTest.invoke("openDataTab");
  await waitFor("switched to data tab", async () => (await dump())?.viewerTab === "data");
  api.chronosTest.invoke("clickReopen");
  await waitFor("re-open icon restores the page view", async () => {
    const s = await dump();
    return s?.viewerTab === "page" && s?.viewer?.pageId === 1;
  });
  check("re-open icon on a tool entry restores the viewer", true);

  // 7. Multi-reference provenance (#5): a row may cite several (page, bbox)
  //    locations via list-valued reserved keys; each should yield a citation.
  writeFileSync(
    join(dataDir, "multi.json"),
    JSON.stringify(
      [
        // two pages, two regions, one shared source — should parse as 2 refs
        { name: "split entry", chronos_page: [1, 1], chronos_bbox: [[0.1, 0.1, 0.4, 0.1], [0.1, 0.3, 0.4, 0.1]], chronos_source: "TestSource" },
        // scalar (backward compatible) — 1 ref
        { name: "single", chronos_page: 1, chronos_bbox: [0.2, 0.2, 0.3, 0.1] },
      ],
      null,
      2,
    ),
  );
  api.chronosTest.invoke("selectDataFile", "multi.json");
  await waitFor("multi-reference row parsed", async () => {
    const s = await dump();
    const counts = s?.data?.provenanceCounts || [];
    return (
      s?.data?.selected === "multi.json" &&
      s?.data?.rowCount === 2 &&
      counts[0] === 2 &&
      counts[1] === 1
    );
  });
  check("data viewer renders multiple references per row", true);

  // 8. New session (#10): the viewer + source dropdown reset to "nothing
  //    selected" so the display matches the (unbound) selection.
  api.chronosTest.invoke("newSession");
  await waitFor("new-session clears source/viewer", async () => {
    const s = await dump();
    return s?.currentSource === "" && (s?.data?.sourceName ?? "") === "" && (s?.viewer?.sourceName ?? "") === "";
  });
  check("new session clears the viewer + source dropdown", true);

  // 9. Expert oversight (#11): the task/task_batch drawer surfaces the expert's
  //    own view_region/view_page calls as clickable viewer links.
  api.chronosTest.invoke("injectExpertTools");
  await waitFor("expert drawer shows tool-use oversight", async () => {
    const s = await dump();
    return (
      s?.chat?.expertOpen === "task-1" &&
      s?.chat?.expertToolLinks === 2 && // view_region + view_page → clickable links
      s?.chat?.expertToolChips === 4 && // + grep + bash chips
      s?.chat?.expertElevatedChips === 1 // bash flagged as elevated
    );
  });
  check("expert drawer surfaces tool-use viewer links + flagged elevated actions", true);

  // The expected data-dir key for each nested fixture source is computed here
  // from the agent's OWN derivation (chronos/tools/collection-context.js,
  // built to chronos/dist by `cd chronos && npm run build`) rather than
  // hardcoded — a literal like "city--Nested_1900" would just be restating
  // what the mock happens to send, not proving the host derives it correctly.
  // `npm test` builds chronos/ first, so this import is fresh. Invoked directly
  // (node test/run-ui-test.mjs) on a checkout that has never built the agent,
  // chronos/dist does not exist — dist is gitignored — and a bare dynamic
  // import would surface as an opaque ERR_MODULE_NOT_FOUND from inside the
  // extension host. Say what to run instead.
  const collectionContext = join(__dirname, "..", "..", "chronos", "dist", "tools", "collection-context.js");
  let deriveRef, dataKeyForRef;
  try {
    ({ deriveRef, dataKeyForRef } = await import(pathToFileURL(collectionContext).href));
  } catch (err) {
    throw new Error(
      `could not import ${collectionContext} — the agent package is not built. ` +
        `Run "npm test" (which builds it) or "cd chronos && npm run build" first. Cause: ${err.message}`,
    );
  }
  const expectedDataKeyFor = (relSourcePath) => {
    const sourceDir = join(ws, "sources", ...relSourcePath.split("/"));
    return dataKeyForRef(deriveRef(ws, sourceDir), sourceDir);
  };

  // 10. Nested sources (blocker 4): the agent slugs a nested source's data key
  //     (sources/city/Nested_1900 -> data/city--Nested_1900), but the host used
  //     to re-derive sourceName via basename(sourceDir) whenever a citation
  //     carried an explicit chronos_source — even one naming the already-active
  //     source — clobbering currentSource with the raw directory basename.
  const expectedNestedKey = expectedDataKeyFor("city/Nested_1900");
  api.chronosTest.invoke("sendPrompt", "select-nested: city/Nested_1900");
  await waitFor("nested source active in viewer", async () => (await dump())?.currentSource === expectedNestedKey);
  check("agent-initiated show_page resolves the nested source to its slug", true);

  const nestedDataDir = join(ws, "data", expectedNestedKey);
  mkdirSync(nestedDataDir, { recursive: true });
  writeFileSync(
    join(nestedDataDir, "citation.json"),
    JSON.stringify(
      [{ name: "nested row", chronos_page: 1, chronos_bbox: [0.1, 0.1, 0.4, 0.1], chronos_source: "city/Nested_1900" }],
      null,
      2,
    ),
  );
  api.chronosTest.invoke("openDataTab");
  await waitFor("nested data file listed", async () => (await dump())?.data?.files?.includes("citation.json"));
  api.chronosTest.invoke("selectDataFile", "citation.json");
  await waitFor("nested data file selected", async () => (await dump())?.data?.selected === "citation.json");

  // The row cites its own (already-active) source explicitly via chronos_source
  // — this is what drives previewSource/openViewLink down the sourcePath branch
  // even though the cited source is already current. This exercises the WARM
  // cache path only: dataKeyBySourceDir already has an entry for this exact
  // directory from the show_page above.
  api.chronosTest.invoke("viewFirstRow");
  api.chronosTest.invoke("showFullPage");
  await waitFor("citation click round-trips to the source viewer", async () => (await dump())?.viewerTab === "page");
  const afterCitation = await dump();
  check(
    "citation click for a nested source resolves currentSource to the agent's data-dir slug, not basename(sourceDir)",
    afterCitation?.currentSource === expectedNestedKey,
    `currentSource=${afterCitation?.currentSource}, expected=${expectedNestedKey}`,
  );

  // 11. Cold cache (F2 regression): the check above only proves the WARM path
  //     (citing a source right after its own show_page primed the cache).
  //     Resuming a session, or reloading VS Code, then clicking a citation for
  //     a nested source the agent hasn't mentioned yet THIS session is the
  //     ordinary case that hit the bug — dataKeyBySourceDir has no entry for
  //     sources/city/Nested_1875 at all here; nothing above ever sent a
  //     show_page/page_list naming it. The host must fall back to deriving
  //     the key (data-key.ts), not basename(sourceDir).
  const expectedColdKey = expectedDataKeyFor("city/Nested_1875");
  writeFileSync(
    join(nestedDataDir, "cold-citation.json"),
    JSON.stringify(
      [{ name: "cold row", chronos_page: 1, chronos_bbox: [0.1, 0.1, 0.4, 0.1], chronos_source: "city/Nested_1875" }],
      null,
      2,
    ),
  );
  api.chronosTest.invoke("openDataTab");
  await waitFor("cold-cache data file listed", async () => (await dump())?.data?.files?.includes("cold-citation.json"));
  api.chronosTest.invoke("selectDataFile", "cold-citation.json");
  await waitFor("cold-cache data file selected", async () => (await dump())?.data?.selected === "cold-citation.json");

  api.chronosTest.invoke("viewFirstRow");
  api.chronosTest.invoke("showFullPage");
  await waitFor("cold-cache citation click round-trips to the source viewer", async () => (await dump())?.viewerTab === "page");
  const afterColdCitation = await dump();
  check(
    "citation click for a NEVER-VISITED nested source resolves to the agent's data-dir slug (cold cache), not basename(sourceDir)",
    afterColdCitation?.currentSource === expectedColdKey,
    `currentSource=${afterColdCitation?.currentSource}, expected=${expectedColdKey}`,
  );

  // Make sure the subprocess stayed alive throughout
  const after = api.getChronosStatus();
  check("pi subprocess still alive", after?.agentStatus === "ready", after?.lastError);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} checks failed: ${failed.map((c) => c.name).join(", ")}`);
  }
};
