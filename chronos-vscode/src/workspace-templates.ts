// Curated default workspace content seeded by initWorkspace (writeIfMissing, so
// re-running "Init Workspace" adds new templates without touching edited files).

// A long-horizon skill that orchestrates the collection + entity-index features:
// select a collection, sweep its sources for an entity, and accumulate a cited
// entity index plus narrative progress in collection memory. Read live by pi
// from the workspace skills/ dir — no rebuild needed to edit it.
export const TRACE_ENTITY_SKILL = `---
name: trace-entity
description: Follow a person, family, property, business, or institution across every source in a collection and build a cited, cross-source entity index.
requires:
---

# Trace an entity across sources

Use this when the user wants to follow one entity — a person, family, property, business, or
institution — across many sources over time (e.g. "trace the Vogt family through the Frankfurt
directories 1850–1900"). The goal is a **cited entity index** plus a narrative timeline, with
every claim traceable to a source page.

This is long-horizon work: it spans many sources and often outlives a single context window, so
you **persist as you go** and design for resa resume. Never hold the whole trace in your head.

## 0. Scope the task

- Confirm the **active collection** (see the catalog in your system prompt). If the relevant
  sources are not in the active collection, ask the user to run \`/select-collection\`.
- Pin down the entity and its bounds with the user if ambiguous: exact name(s) and spelling
  variants, time range, place, and what counts as a match (same person vs. same household).
- Read **collection memory** (already injected) and, if it exists, the current entity index at
  \`data/_collections/<collection>/entities.json\` — you may be resuming an earlier run.

## 1. Choose which sources to sweep

- Use the catalog's \`meta\` (year, place, type) to pick the candidate sources — do **not** scan
  every page of every source blindly. Order them (usually chronologically).
- For each candidate, if its **mem** column is ✓, \`read\` \`memory/<ref>.md\` first — it may already
  record where the entity appears or the source's layout/section ranges.

## 2. Sweep each source, one at a time

For each chosen source \`S\`:

1. \`list_pages(source: S)\` to learn its extent.
2. Narrow to likely pages using per-source memory, the source's structure (indices,
   alphabetical sections), or a cheap first pass — don't batch the whole book if you can help it.
3. Extract candidate mentions with \`task\` (a few pages) or **\`task_batch\`** (many pages of the
   SAME source — one batch targets one \`source\`; iterate sources with separate batches). Prompt
   the expert to return, for each mention: the surface form of the name, surrounding attributes
   (trade, address, dates, relations), the \`chronos_page\`, and a tight \`chronos_bbox\`.
   - \`task_batch\` is high-cost and needs explicit user confirmation — follow the mandatory
     confirmation protocol in your system prompt (propose → ask → stop). Do not call it until the
     user approves.

## 3. Reconcile into the entity index

Maintain \`data/_collections/<collection>/entities.json\` — a JSON array of entity rows. Each row
aggregates every place the entity appears, using the reserved keys as **index-aligned lists**:

\`\`\`json
[
  { "entity": "Karl Vogt", "type": "person", "attributes": { "trade": "baker" },
    "chronos_source": ["sources/Frankfurt_1858", "sources/Frankfurt_1861"],
    "chronos_page": [42, 51],
    "chronos_bbox": [[0.10,0.32,0.80,0.05], [0.10,0.41,0.80,0.05]],
    "notes": "1861 entry drops the 'jun.' suffix — likely the same man." }
]
\`\`\`

- **Read the file, then \`edit\` to append** a new reference or a new entity — never blind-overwrite.
- **Do not over-merge.** If it's unclear whether two mentions are the same entity, keep them
  distinct and record the doubt in \`notes\`, or add a \`candidate\` flag — flag uncertainty rather
  than inventing continuity. Entity resolution is a judgement call; surface it, don't hide it.
- Every reference must have a \`chronos_page\`; add a \`chronos_bbox\` whenever you can so the
  historian can verify at a glance. The Data tab renders each reference as its own "view source"
  button.

## 4. Checkpoint — every source, not just at the end

After finishing each source (or every ~5–10 pages within a large one), write to **collection
memory**: which sources are done, what you found, spelling variants seen, and open questions.
This is what lets a compacted or resumed session continue instead of starting over.

## 5. Synthesize

When the sweep is done, give the user a chronological summary of the entity's trajectory. Cite
each claim with a source-qualified link — \`[view p.42@sources/Frankfurt_1858]\` — so they can
click through to the evidence. Point them at the entity index in the Data tab. State plainly
where the trail is uncertain or goes cold.
`;
