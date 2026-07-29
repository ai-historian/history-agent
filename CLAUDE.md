# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chronos is an AI agent that helps historians extract structured data from scanned primary sources. It is split into **two independently-built npm packages**:

- **`chronos/`** — a [`pi`](https://github.com/badlogic/pi-mono) **pi-package**: the agent itself (custom tools, prompts, lifecycle hooks). It is *not* a standalone program — it is loaded into the user's globally-installed `pi` agent at runtime.
- **`chronos-vscode/`** — the VS Code extension: a host process (`src/`) plus a Lit web-component UI (`webview/`) that drives a `pi` subprocess and renders the page viewer + chat.

The repo root is also a pi-package wrapper (`package.json` `pi` field points into `chronos/`), so `pi install <repo>` registers the agent.

## Build / test / typecheck

```bash
# chronos pi-package — compiles TS to dist/ (pi loads from dist/, see gotcha below)
cd chronos && npm run build            # = tsc

# VS Code extension — esbuild bundles BOTH the host and the webview into out/
cd chronos-vscode && npm run build     # one-shot
cd chronos-vscode && npm run watch     # rebuild on change
cd chronos-vscode && npm run package   # vsce package -> .vsix
```

**esbuild does not type-check.** After editing extension/webview TS, verify types explicitly — there are two tsconfigs:

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json          # host (src/)
cd chronos-vscode && npx tsc --noEmit -p webview/tsconfig.json  # webview/
```

There is no unit-test runner — tests are plain node scripts, split across both packages. Each
package's `npm test` runs its own set:

```bash
cd chronos && npm test                 # builds dist/, then all four agent canaries
cd chronos-vscode && npm test          # builds the agent + bundle, then host tests + the UI test
```

Individually:

```bash
# chronos/ — canaries import the BUILD OUTPUT (dist/), so they need `npm run build` first
node scripts/downscale-canary.mjs    # image long-edge cap
node scripts/retry-canary.mjs        # expert retry/backoff policy
node scripts/timeout-canary.mjs      # per-attempt timeout enforced by abort, not pi-ai timeoutMs
node scripts/collection-canary.mjs   # collection context, ids, session sidecar, source precedence

# chronos-vscode/
node scripts/rpc-spike.mjs [path-to-pi]        # asserts the pi --mode rpc JSONL contract. Run after upgrading the global pi.
node test/collection-id-test.mjs               # host reads collection id vs display name
node test/data-key-equivalence-test.mjs        # host's data-key mirror vs the agent's real derivation (needs chronos/dist)
node test/run-ui-test.mjs                      # launches VS Code against a fixture workspace; panel + webview + RPC boot + nested sources
```

`test/suite.js` and `test/data-key-equivalence-test.mjs` import `chronos/dist/` to derive their
expected values instead of hardcoding them, so **a stale `dist` makes them agree with themselves**.
`npm test` builds the agent first for that reason; if you invoke the scripts directly, build it
yourself. Note `chronos/dist` is gitignored and survives branch switches.

See `chronos-vscode/TESTING.md` for the manual smoke checklist.

## Architecture — the big picture

### Two communication channels (this is the crux)

The extension host talks to the `pi` agent subprocess over **two distinct channels** — confusing them is the most common source of bugs:

1. **RPC (JSONL over stdin/stdout)** — extension → agent. `src/rpc/pi-rpc-session.ts` spawns `pi --mode rpc` and speaks a JSONL protocol (`src/rpc/rpc-types.ts`) for prompts, steering, state, model/command lists, session switching, and `extension_ui_request`/`extension_ui_response` (so the agent can pop VS Code dialogs). This is the control plane.
2. **HTTP** — agent → extension. On session start the host opens an HTTP server on a dynamic port and passes it via the `CHRONOS_HTTP_PORT` env var; the pi-package's `chronos/http/http-client.ts` POSTs viewer events (show page, text deltas, tool status) back. This is the one-way push channel for the viewer.

The webview never talks to either directly — it exchanges typed `postMessage` envelopes (`ExtToWebview` / `WebviewToExt` in `src/panel/webview-protocol.ts`) with the host, which bridges to RPC/HTTP. `src/panel/chronos-panel.ts` is the hub that owns the `PiRpcSession` and the webview.

### The webview (`chronos-vscode/webview/`)

Plain **Lit web components** (no React), bundled by esbuild to `out/webview/main.{js,css}`. Entry `main.ts`; root `components/chronos-app.ts` holds app state and forwards messages to `components/chronos-chat.ts` (transcript + composer) and `components/page-viewer.ts`. Styling is one CSS file (`styles.css`) driven by VS Code theme variables plus a `--ch-*` design system (bronze accent reserved for provenance/citations).

### The agent (`chronos/`)

`chronos/extensions/index.ts` is the pi-package entrypoint: it registers tools, the `/select-source` and `/yolo` commands, and lifecycle hooks. Tools live in `chronos/tools/` and share a mutable `SourceContext` (`tools/source-context.ts`) so `change_source` can redirect all source-bound tools at runtime. The system prompt is **rebuilt every turn** by the `before_agent_start` hook from `prompts/system-prompt.md` + the current `SourceContext` — it is never part of the persisted message history.

Key tools: `task`/`task_batch` (spawn persistent vision-expert subagents per page, follow-up-able via `task_id`; the expert runs a bounded tool loop and can `view_region`/`view_page` to self-zoom), `list_pages`, `show_page`/`show_text` (viewer), `change_source`. Expert models are any `provider/model-id` pi has auth for; no provider is hardcoded — they default to the orchestrator's current model.

### Important runtime facts

- **pi loads the agent from `dist/`, not the TS source.** The `pi` field points extensions at `./dist/extensions`. After editing anything under `chronos/{extensions,tools,utils,http}/*.ts` you MUST `cd chronos && npm run build` or the change won't take effect. Prompts and skills (`chronos/prompts/`, workspace `skills/`) are read live — no rebuild needed.
- **Which package pi runs is set in `~/.pi/agent/settings.json` `packages`.** Released use points at the GitHub repo (cloned under `~/.pi/agent/git/`). For local development, point that entry at the absolute path of the `chronos/` dir so sessions run your working copy (after building). Sessions snapshot at startup — restart the session to pick up agent changes.
- **pi packages were renamed.** `@mariozechner/pi-{coding-agent,ai}` are deprecated (frozen at 0.73.x); the maintained packages are `@earendil-works/pi-{coding-agent,ai}` (same author, a scope rename). Both the pi-package's peer deps and the installed `pi` binary now use `@earendil-works`. **Runtime pi ≠ build-time pi:** the build-time package in `chronos/node_modules` and the globally-installed `pi` binary can still drift in version — when debugging pi behavior, read the binary's actual install, not `chronos/node_modules`. The 0.79 API differs from 0.73 (e.g. `session_switch`/`session_directory` hooks were dropped — `session_start` now carries a `reason`, and `PI_CODING_AGENT_SESSION_DIR` replaces the session-dir hook).
- **Every `.md` in `chronos/prompts/` becomes a slash command** because pi auto-registers prompt templates. Only `select-source` and `yolo` are real user commands; the rest are tool text / the system prompt. The webview slash-command menu therefore filters out `source: "prompt"` entries with `sourceInfo.origin === "package"` (see `chronos-panel.ts`).

### Workspace layout (user-facing, created by `Chronos: Init Workspace`)

A Chronos *workspace* (separate from this repo) contains `sources/<name>/png/page_NNNN.png`, `data/` (outputs), `memory/` (`MEMORY.MD` + per-source `.md`, injected into the system prompt), `skills/<name>/SKILL.md`, `sessions/`, and `.chronos/` (`.env` with provider API keys e.g. `ANTHROPIC_API_KEY`/`GEMINI_API_KEY`, written by the panel's "Log in" flow; `settings.json` for the `yolo` flag; `session-collections.json` mapping session id → `{ name?, extraMembers? }` — the selected collection plus any sources added mid-session via `change_source`, replayed on resume; `session-names.json` caching auto-generated session titles). The workspace `skills/` dir is bridged into pi via `.pi/settings.json` (`{ "skills": ["../skills"] }`).

## Reference

- `README.md` — install + getting-started (extension auto-installs `pi` and the pi-package on first run).
- `DOCS.md` — tool reference, SKILL.md format, memory system, bbox cropping.
- `chronos-vscode/TESTING.md` — test commands + manual smoke checklist.
