# feat/archive-support blocker fixes — design

Date: 2026-07-28
Status: approved, not yet implemented
Branch: `fix/archive-support-blockers` (off `feat/archive-support` + `dev`)

## Purpose

`feat/archive-support` is 18 commits of collection/archive work that must land in
`dev` before any other work proceeds — it overlaps every file the image
normalization and Import button work touches. Review found six logic blockers.
**Decision taken: fix all six before the branch lands**, so `dev` never contains
known silently-corrupting code.

Problem statements, failure scenarios and file:line references for all six live in
[the image-normalization spec's Phase 0 section](2026-07-28-image-normalization-and-import-button-design.md).
This document records only the **design decisions** for the fixes, so it does not
restate them.

## What review already established

Merge into `dev` is **clean** and all eight gates pass on the merged result
(both builds, both typechecks, `rpc-spike` 7/7, `run-ui-test` 18/18, both
canaries). Protocol wiring is exhaustively clean, there is no XSS, and
`initWorkspace` cannot clobber a user workspace.

**Every blocker is a logic/path bug no existing test exercises.** Green tests are
not evidence here — each fix below ships with a test that fails first.

## Scope

**In:** the six blockers, plus two issues that fixing blocker 6 makes *reachable*
(see D2/D3 below) — without them, the blocker-6 fix introduces an uncaught
exception and silently disables retries.

**Deferred** (real, but not triggered by anything changed here):

- `manifestPath` builds a path from an unsanitized collection name, so `../`
  escapes `collections/`. Note: the fix in **C** incidentally closes this, because
  ids originate from `readdirSync` and are resolved by lookup against the
  enumerated list rather than by string concatenation. No extra work is spent on
  it and no regex validation is added.
- A collection literally named `all` or `All` can never be selected —
  `requested.toLowerCase() === "all"` claims it as the "all sources" sentinel.
- `/select-collection ${arg}` passes a name as a slash-command argument, so a
  name containing a newline injects into the prompt.
- Batch robustness (a worker throw discarding completed results, cancelled items
  vanishing from the summary, duplicate `page_ids` colliding on the `live` map
  key, colliding `{name}` templates).
- `chronos.piAgentDir` is non-functional (`agentEnv` never sets
  `PI_CODING_AGENT_DIR`; 1 of 4 agent-home reads honours it).
- Stale `CLAUDE.md` / `DOCS.md` / `README.md` describing the deleted
  `SourceContext` contract.
- `.expert-chip-task` ellipsis CSS is inert (flex item, default
  `min-width: auto`).
- `scripts/rpc-spike.mjs` no longer reflects the pi launch contract (missing
  `--skill`); `skill-canary.mjs` and the two new canaries are wired to nothing.

## Design decisions

### A. Blocker 3 — persisting `change_source` additions

**Chosen: a session-scoped sidecar**, by extending
`chronos/utils/session-collection-store.ts`.

`change_source` adds a member to the in-memory catalog only, while
`buildCollectionFromDiscovery` clears and repopulates from `sources/` on every
`session_start` (which fires for startup, switch, resume *and* fork). So an
out-of-tree source is wiped with nothing to restore it from.

Rejected — **write into a collection manifest.** `ManifestMember.path` already
accepts absolute paths and an explicit `ref`, so no schema change would be
needed, and additions would be permanent across sessions. But when the
auto-collection is active `ctx.name === null`, so there is no manifest to append
to; materializing one silently converts the session to a *named* collection,
which changes `collectionKey` / `collectionDataDir` / `collectionMemoryPath` and
makes existing collection-level memory and data appear to vanish. Too much blast
radius for a bug fix.

Rejected — **reject out-of-tree paths.** Removes a capability the tool
advertises, and pushes users toward symlinks, which `discoverSources` follows
with no depth cap.

**Trap to design around.** `saveSessionCollection(ws, id, null)` currently
*deletes the whole entry* to mean "auto-collection". Naively hanging
`extraMembers` off that entry would make selecting "all sources" wipe the user's
added sources. So `Selection` becomes `{ name?: string; extraMembers?: string[] }`,
passing `null` clears only `name`, and the entry is removed only when both fields
are empty. Existing `{ name }` entries stay readable.

Additions are replayed immediately *after* `buildCollectionFromDiscovery` and the
named-collection restore, since that function unconditionally resets
`name`/`description`/`members`.

Accepted limitation: additions are per-session. A brand-new session will not see
a source added in an older one. That matches how the selection it sits beside
already behaves.

`chronos/utils/session-source-store.ts` is **deleted** — it has zero importers on
this branch (master had two), and its `Record<id, string>` shape is too narrow to
reuse.

### B. Blocker 4 — nested-source data key mismatch

**Chosen: a `sourceDir → dataKey` lookup in the host.** Do not duplicate the
slug logic.

The agent already sends the correct data key as `sourceName` on every
viewer message (`show_page`, `list_pages`, `show_text` all send
`basename(m.dataDir)`). Only the **host-initiated** click paths recompute it
locally and get it wrong: `openViewLink` and `previewSource` both do
`sourceName = basename(sourceDir)`, while the agent uses
`dataKeyForRef(ref, path)` = `ref.includes("/") ? toSlug(ref) : basename(path)`.

Rejected — **duplicate `toSlug` / `dataKeyForRef` / `deriveRef` into
`chronos-vscode`.** It would match precedent (`protocol.ts` is already a verbatim
hand-copy of `chronos/http/http-client.ts`'s types, and `sources.ts` already
duplicates `discoverSources`), and cross-package import is genuinely not viable —
`chronos-vscode/tsconfig.json` has `rootDir: "src"` and its build is esbuild-only.
But it means keeping **three coupled functions** in sync, including
`dataKeyForRef`'s asymmetry and `deriveRef`'s workspace-relative derivation. The
lookup removes that hazard entirely.

The host populates the map from the messages it already receives and falls back
to `basename` only for a genuinely unknown directory.

### C. Blocker 5 — collection name vs filename

**Chosen: an explicit `id` (the filename stem) separate from the display `name`.**

Today `listCollections` reads filenames but reports the in-JSON `name`,
discarding the filename; `loadCollection` then resolves that value *as* a
filename. So `collections/frankfurt.json` containing
`{"name": "Frankfurt Directories"}` is **unselectable**, and restore fails the
same way — silently, via a `console.warn` the user never sees.

`id` becomes the option **value**, `name` stays the **label**, `manifestPath` is
keyed on `id`, and `id` is what `session-collections.json` persists. This fixes
selection, restore, and the picker's active-selection comparison in one move.

Rejected — **have the loader scan all manifests for a matching `name`.** Needs a
duplicate scan per load, has no defined behaviour when two manifests declare the
same `name`, and leaves already-persisted values ambiguous.

Must be applied in **three** places, because `discoverCollections` is duplicated:
`chronos/utils/collection-manifest.ts`, `chronos-vscode/src/panel/sources.ts`, and
the webview option value. The picker's `activeCollection` comparison must switch
to the same identity or the dropdown will display the wrong selection.

Migration: an existing `session-collections.json` holds display names. On load, a
value that matches no id is resolved against display names once and rewritten as
an id; failing that it is dropped and the session falls back to all-sources —
which is what already happens today, so this is not a regression.

### D. Blocker 6 — the expert timeout is a no-op on Gemini/Vertex

**Chosen: express the timeout as an abort, per attempt, inside
`completeWithRetry`.**

Verified against the installed pi-ai: `providers/google.js`,
`google-shared.js` and `google-vertex.js` never reference `timeoutMs` — they
honour only `signal` (`google.js:307-311` sets `config.abortSignal`).
`anthropic.js`, `openai-completions.js`, `openai-responses.js`,
`azure-openai-responses.js` and `openai-codex-responses.js` do consume it. So a
stalled Gemini expert holds its batch concurrency slot indefinitely, and
`completeWithRetry` blocks on an attempt that never resolves — meaning `retries`
offers no protection against a hang at all.

`signal` is the one mechanism every provider honours, so a timeout expressed as
an abort works uniformly with no per-provider special-casing and no dependency on
which pi-ai version fixed which provider. Each attempt gets its own controller,
composed with the caller's user-cancel signal.

Rejected — **build the timeout into `expert-turn.ts`'s `attempt` closure.** It
would work, but puts timeout bookkeeping at the call site, and `expert-turn.ts`
already has two separate abort checks around this call that would each need to
distinguish user-cancel from attempt-timeout.

The comment at `expert-turn.ts:44-50`, which asserts the timeout bounds each
attempt because "pi-ai forwards it to the provider SDK", is false and must be
corrected in the same change.

#### D2. Timeout-abort must be distinguishable from user-abort (in scope)

An aborted attempt surfaces as `stopReason === "aborted"`, not `"error"`. The
retry loop only retries `"error"`, so without this the fix silently reduces
`CHRONOS_EXPERT_RETRIES` to 0 for timeouts — and `expert-turn.ts:384` would
report a timeout as "Expert turn aborted", indistinguishable from a user cancel.
The loop must check the *user* signal specifically, not the composed one, and
treat a timeout-abort as retryable.

#### D3. `completeWithRetry` needs a `try`/`catch` (in scope)

`google.js:308-309` **throws** `new Error("Request aborted")` when the signal is
already aborted on entry, violating the resolve-with-`stopReason` contract the
retry design is built on (`expert-retry.ts:4-5`). `completeWithRetry` has no
`try`/`catch`, so once a timeout-abort exists, a retry beginning after the
composed signal fired throws straight out of the expert turn. A thrown attempt
must be converted into the same shape as a failed one and remain retryable.

## Testing

Agent-side fixes are tested with node canaries importing `chronos/dist/`, matching
the existing `retry-canary.mjs` / `downscale-canary.mjs` convention. Host-side
logic is tested by bundling the module with esbuild's JS API and importing it,
the pattern introduced in the image-normalization plan.

Landing gate (all must pass): both builds, both typechecks, `rpc-spike`,
`run-ui-test`, and every canary including the new ones.
