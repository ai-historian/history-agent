# Chronos Extension — Testing

## Automated: RPC spike / version canary

```
node scripts/rpc-spike.mjs [path-to-pi]
```

Spawns `pi --mode rpc` in a throwaway fixture workspace and asserts the JSONL
protocol contract the extension depends on: readiness via `get_state`, chronos
pi-package loading (`select-source` registered), `get_available_models`, and
the `extension_ui_request`/`extension_ui_response` round trip (including the
fact that slash-command `prompt` responses arrive only after the handler
finishes). Run this after upgrading the global `pi` install to detect protocol
drift. Last verified: pi 0.79.1 (2026-06-11).

## Agent canaries (`chronos/`)

```
cd ../chronos && npm test
```

Builds `dist/` then runs all four canaries — image downscaling, expert
retry/backoff, per-attempt timeout-as-abort, and collection context (ids,
session sidecar, source precedence). They import the **build output**, so the
build step is not optional.

## Host tests

```
node test/collection-id-test.mjs          # collection id vs display name
node test/data-key-equivalence-test.mjs   # host data-key mirror vs the agent's real derivation
```

`data-key-equivalence-test.mjs` imports the agent's compiled `deriveRef`/
`dataKeyForRef` from `chronos/dist` and compares them against the host's
`src/panel/data-key.ts` mirror over a case table, with no expected-value literal
— so the unavoidable duplication across the two packages is self-policing.
It needs `chronos/dist` built (`npm run build:agent`).

## VS Code integration test

```
npm test            # builds the agent + bundle, then host tests, then the UI test
node test/run-ui-test.mjs
```

`npm test` builds `chronos/` first because `test/suite.js` derives its expected
nested-source data keys from `chronos/dist` rather than hardcoding them — a
**stale or missing `dist` makes the test agree with itself** (or fail with an
opaque module error). `chronos/dist` is gitignored and survives branch switches,
so it can silently hold another branch's build.

Launches VS Code (local binary) with the dev extension against a fixture
workspace and drives it against **`test/mock-pi.mjs`** — a stub that speaks the
`pi --mode rpc` JSONL contract, so no real pi binary or API keys are needed. The
fixture points `chronos.piPath` at the mock and the run sets
`CHRONOS_SKIP_BOOTSTRAP=1` to skip the install prompts.

It asserts the startup path **and** interaction flows: `chronos.startSession`
opens the combined panel, the webview boots (ready handshake), the agent reaches
ready, a prompt renders an assistant message, a tool call renders a tool card, a
`show_page` pushed over HTTP drives the viewer, the **Data** tab renders a
provenance-bearing JSON file as a table (hiding the `chronos_*` columns), a
row's "view source" shows an inline crop preview in the Data tab (and "Show full
page" hands off to the independent source viewer), and the re-open icon on a
`show_page` tool entry restores that view after switching tabs. The webview cooperates
via a test-only `__test/invoke` / `__test/dump` message pair (see
`webview-protocol.ts`); the mock varies behavior by prompt prefix
(`select:` / `tool:` / anything → echo).

**Known flake:** this test failed roughly 1 run in 4 on unchanged code when last
measured (2026-07-28) — it drives a real VS Code instance with `waitFor` polling,
so it is timing-sensitive. Treat a single red run as inconclusive: re-run before
concluding a change broke it, and do not treat one green run as a release gate.

## Manual smoke checklist (combined viewer + chat UI)

Chat is the only UI. The automated test above covers prompt/assistant rendering,
tool cards, the HTTP→viewer bridge, and the Data tab + provenance; the items
below need a real workspace with an imported source and a real pi/model.

1. `Chronos: Start Agent Session` → one panel: page viewer left, chat right,
   header with Source/Model selectors and History/New buttons.
2. Pick a source in the header → viewer shows page 1, model acknowledges the
   selection in chat.
3. Send a prompt → user note appears, assistant text streams as markdown with
   a caret; tool calls render as ledger-style cards (spinner → result).
4. Click a `❏ p. N` provenance chip in an answer → viewer jumps to that page
   (with the region crop if the chip carries a `§` selection). Tool entries that
   drove the viewer (`show_page`, `show_text`) carry a small eye icon — visible
   when you expand the reasoning/activity group — that re-opens that exact view
   (page + crop, or the text file); expert `task` cards expose the same via
   their `p. N` chip.
5. Navigate in the viewer (arrows, page input, ±10, zoom, Fit, Ctrl+scroll);
   "Full page" appears when a crop is shown.
6. Press Stop while streaming → agent aborts; Send becomes Steer while running.
7. Trigger a bash tool (non-yolo) → in-panel Allow/Deny dialog; both unblock.
8. History → drawer lists past sessions; Resume rebuilds the chat; New starts
   a fresh session.
9. Switch model in the header → header reflects it; next turn uses it.
10. Kill the pi pid → exit banner + Restart revives with history intact.
11. `show_text` from the agent renders the text view with highlight scrolled
    into view.
12. Data tab: after the agent writes a JSON array to `data/<source>/`, the
    viewer's **Data** tab lists the file and renders it as a sortable table;
    `chronos_page`/`chronos_bbox` columns are hidden and shown instead as a
    "view source" button per row. Clicking it shows a zoomed view of the cited
    region (the bbox + ~40% margin, not the whole page) in a resizable preview
    panel docked at the bottom of the Data tab — the region is outlined and the
    margin dimmed (~30% of the height, drag the divider to resize; no tab
    switch). **Show full page** on that panel opens the full page in the
    independent source viewer. Free-form/non-JSON files render as text.
13. Expert subagents: a prompt that triggers the `task` tool renders a
    standalone bronze-railed card ("Expert task-1 — prompt…", spinner →
    ✓ with model and turn count) instead of an activity-group entry. A
    follow-up `task` call shows a "follow-up" tag on its own card.
14. Click an expert card → full-pane transcript drawer: orchestrator
    questions right-aligned (with clickable `p. N` chips), expert replies as
    markdown, live "thinking…" bubble while a follow-up streams. Esc or ✕
    closes; the footer names the `task-N` id. A failed `task` call (bad
    model / unknown task_id) falls back to a plain expandable tool card.
15. Batch subagents: confirm a `task_batch` call (after the mandatory
    confirmation protocol) renders one batch card ("Batch · N experts ·
    model  ✓X ✗Y") with a chip grid (one chip per page: `task-K` · `p.N` ✓/✗).
    Clicking a chip opens that page's expert transcript drawer — the first
    turn comes from the batch result, and any later `task` follow-up on that
    `task_id` appears as a subsequent turn in the same drawer. A batch that
    errors before spawning (no source, bad output_file template) falls back
    to a plain tool card.
16. Import recovery: start `Chronos: Import Sources` on a multi-page PDF and
    kill VS Code (or the window) mid-conversion. The source must NOT appear in
    the source picker (it has no `png/`, only `.png.partial/` + `.importing.json`).
    Relaunch → a warning offers **Resume**/**Discard**/**Later**. Resume finishes
    the conversion (skipping already-rendered pages) and the source then appears;
    Discard removes the partial data. Re-running **Import Sources** also surfaces
    the prompt.
