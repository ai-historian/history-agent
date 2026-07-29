#!/usr/bin/env node
// Equivalence test for the source data-dir key (Task 7, finding F3/duplication
// risk): chronos-vscode cannot import chronos/'s TS sources directly (this
// package's tsconfig sets rootDir: "src", and the two packages are built and
// published independently — see CLAUDE.md), so
// chronos-vscode/src/panel/data-key.ts duplicates the trivial slug transform
// the agent uses to name a source's data/<key>/ directory. That duplication
// is only safe as long as the two implementations agree.
//
// This test proves they agree — for a table of cases, not a single hardcoded
// string — by importing BOTH sides of the boundary and comparing their output
// directly, with no expected-value literal anywhere:
//   - the agent's real, compiled `deriveRef`/`dataKeyForRef` from
//     chronos/dist/tools/collection-context.js (run `cd chronos && npm run
//     build` first — this test reads the build output, same as
//     chronos/scripts/collection-canary.mjs and test/suite.js do)
//   - the host's `deriveDataKeyFallback` from
//     chronos-vscode/src/panel/data-key.ts, compiled on the fly with esbuild
//     (already a devDependency here) since it's plain TypeScript, not part of
//     the extension bundle
//
// If chronos/'s derivation ever changes without a matching update to
// data-key.ts, this test fails instead of the two silently drifting apart.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const chronosDist = join(here, "..", "..", "chronos", "dist");
const hostSrc = join(here, "..", "src", "panel", "data-key.ts");
const hostSourcesSrc = join(here, "..", "src", "panel", "sources.ts");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else {
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
};

// ── load the agent's real functions from the build output ──────────────────
let agent;
try {
  agent = await import(pathToFileURL(join(chronosDist, "tools", "collection-context.js")).href);
} catch (err) {
  console.log(
    `FAIL  could not import chronos/dist/tools/collection-context.js — run "cd chronos && npm run build" first (${err.message})`,
  );
  process.exit(1);
}
const { deriveRef: agentDeriveRef, dataKeyForRef: agentDataKeyForRef } = agent;

// ── compile the host's mirror on the fly (it's plain TS, not bundled) ──────
const built = await esbuild.build({
  entryPoints: [hostSrc],
  bundle: false,
  write: false,
  format: "esm",
  platform: "node",
  target: "node18",
});
const hostModuleSource = built.outputFiles[0].text;
const hostModule = await import(
  `data:text/javascript;base64,${Buffer.from(hostModuleSource).toString("base64")}`
);
const { deriveDataKeyFallback: hostDeriveDataKeyFallback } = hostModule;

// ── compile the host's real discoverSources (sources.ts), same technique ───
// bundle: true, unlike data-key.ts above: sources.ts imports refFromRelative from
// ./data-key.js (deliberately — one copy of the separator normalization, not a
// third), and a bare compile leaves that relative specifier unresolvable from the
// data: URL this is imported through. Bundling inlines it; node builtins stay
// external under platform: "node".
const builtSources = await esbuild.build({
  entryPoints: [hostSourcesSrc],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node18",
});
const hostSourcesModule = await import(
  `data:text/javascript;base64,${Buffer.from(builtSources.outputFiles[0].text).toString("base64")}`
);
const { discoverSources: hostDiscoverSources } = hostSourcesModule;

// ── table of cases: every branch dataKeyForRef(deriveRef(...)) distinguishes ─
const tmpDirs = [];
function mktemp() {
  const dir = mkdtempSync(join(tmpdir(), "ch-datakey-eq-"));
  tmpDirs.push(dir);
  return dir;
}
const ws = mktemp();

function agentDataKey(workspaceDir, sourceDir) {
  return agentDataKeyForRef(agentDeriveRef(workspaceDir, sourceDir), sourceDir);
}

const cases = [
  {
    label: "in-tree flat source",
    sourceDir: join(ws, "sources", "Frankfurt_1864"),
  },
  {
    label: "in-tree nested source (one level)",
    sourceDir: join(ws, "sources", "city", "Nested_1900"),
  },
  {
    label: "in-tree nested source (two levels)",
    sourceDir: join(ws, "sources", "region", "city", "Deep_1850"),
  },
  {
    label: "in-tree nested source (three levels, different basename collision)",
    sourceDir: join(ws, "sources", "a", "b", "c", "Frankfurt_1864"),
  },
  {
    label: "out-of-tree source (absolute path outside the workspace, added via change_source)",
    sourceDir: join(mktemp(), "elsewhere", "Imported_Archive_1900"),
  },
];

for (const { label, sourceDir } of cases) {
  const expected = agentDataKey(ws, sourceDir);
  const actual = hostDeriveDataKeyFallback(ws, sourceDir);
  check(`${label}: host matches agent`, actual === expected, `agent=${expected} host=${actual} sourceDir=${sourceDir}`);
}

// Sanity: the table actually exercises both the slugged and basename branches
// (otherwise every case above could pass vacuously if both sides always fell
// back to the same branch by coincidence).
const nestedCase = agentDataKey(ws, join(ws, "sources", "city", "Nested_1900"));
const flatCase = agentDataKey(ws, join(ws, "sources", "Frankfurt_1864"));
check(
  "table exercises both a slugged (nested) and a bare-basename (flat) case",
  nestedCase.includes("--") && !flatCase.includes("--"),
  `nested=${nestedCase} flat=${flatCase}`,
);

// Sanity: no path-separator assumption leaked in either implementation — the
// derived key never contains the raw OS separator.
for (const { label, sourceDir } of cases) {
  const key = hostDeriveDataKeyFallback(ws, sourceDir);
  check(`${label}: data key has no raw path separator`, !key.includes(sep), key);
}

// ── F1: a case whose sourceDir comes from ACTUAL discoverSources output, not
// a hand-built path. Every case above hand-joins its own sourceDir and calls
// the normalizing agentDeriveRef directly — which is exactly why they can't
// see a bug in discoverSources' own `name` derivation (chronos-vscode's
// discoverSources normalizes `relative()`'s output to forward slashes so it
// matches the agent's ref verbatim; before that fix, a nested source's `name`
// would be platform-native and diverge from the agent's ref on win32). This
// exercises the real (compiled) host discoverSources against real nested
// fixture directories, then checks BOTH that the derived data keys still
// agree and that the discovered `name` itself agrees with the agent's ref —
// the exact string /select-source round-trips through the RPC.
{
  const realWs = mktemp();
  mkdirSync(join(realWs, "sources", "city", "Nested_1900", "png"), { recursive: true });
  writeFileSync(join(realWs, "sources", "city", "Nested_1900", "png", "page_0001.png"), Buffer.alloc(8));
  mkdirSync(join(realWs, "sources", "Flat_1864", "png"), { recursive: true });
  writeFileSync(join(realWs, "sources", "Flat_1864", "png", "page_0001.png"), Buffer.alloc(8));

  const discovered = hostDiscoverSources(join(realWs, "sources"));
  const nested = discovered.find((s) => s.path.endsWith(join("city", "Nested_1900")));
  const flat = discovered.find((s) => s.path.endsWith("Flat_1864"));
  check("real discoverSources found the nested fixture", !!nested, JSON.stringify(discovered));
  check("real discoverSources found the flat fixture", !!flat, JSON.stringify(discovered));

  for (const s of [nested, flat]) {
    if (!s) continue;
    const expected = agentDataKey(realWs, s.path);
    const actual = hostDeriveDataKeyFallback(realWs, s.path);
    check(`real discoverSources output "${s.name}": host data key matches agent`,
          actual === expected, `agent=${expected} host=${actual}`);
  }

  // The discovered `name` itself — not just the derived data key — must equal
  // the agent's ref exactly, since chronos-panel.ts sends it verbatim as the
  // /select-source argument and the agent matches it against member.ref.
  check('discovered nested "name" matches the agent\'s ref (what /select-source compares against)',
        nested && nested.name === agentDeriveRef(realWs, nested.path),
        `name=${nested?.name} agentRef=${nested ? agentDeriveRef(realWs, nested.path) : undefined}`);
  check("discovered name has no raw path separator character other than the canonical forward slash",
        !nested || !nested.name.includes("\\"), nested?.name);
}

// ── the win32 separator branch, which a POSIX host cannot reach via the FS ──
// This is the half of the nested-source fix that lives on the HOST, and it had
// NO coverage: on Linux `relative()` never emits a backslash, so deleting the
// host's normalization left every check above green. Both packages now expose
// refFromRelative with an injectable separator precisely so the win32 branch is
// executable here — and so the two are compared on it, not just on POSIX input.
{
  const { refFromRelative: agentRefFromRelative } = agent;
  const { refFromRelative: hostRefFromRelative } = hostModule;

  check("host exposes refFromRelative (the shared separator normalization)",
        typeof hostRefFromRelative === "function", typeof hostRefFromRelative);
  check("agent exposes refFromRelative",
        typeof agentRefFromRelative === "function", typeof agentRefFromRelative);

  if (typeof hostRefFromRelative === "function" && typeof agentRefFromRelative === "function") {
    const cases = [
      ["city\\Nested_1900", "\\", "city/Nested_1900", "win32 nested source"],
      ["a\\b\\c\\D_1900", "\\", "a/b/c/D_1900", "win32 deeply nested"],
      ["Flat_1864", "\\", "Flat_1864", "win32 flat source"],
      ["city/Nested_1900", "/", "city/Nested_1900", "posix nested source"],
      // The regression guard: on POSIX a backslash is a legal FILENAME character,
      // so it must survive — folding it collided a dir named `city\Nested` with a
      // genuinely nested `city/Nested` and silently dropped one of them.
      ["city\\Nested_1900", "/", "city\\Nested_1900", "posix literal backslash is preserved"],
    ];
    for (const [rel, pathSep, expected, label] of cases) {
      const a = agentRefFromRelative(rel, pathSep);
      const h = hostRefFromRelative(rel, pathSep);
      check(`${label}: agent and host agree`, a === h, `agent=${a} host=${h}`);
      check(`${label}: result is ${JSON.stringify(expected)}`, a === expected, a);
    }

    // The property that actually matters: a nested source gets ONE ref regardless
    // of which platform derived it.
    check("a nested source's ref is platform-independent (win32 sep == posix sep)",
          hostRefFromRelative("city\\Nested_1900", "\\") === hostRefFromRelative("city/Nested_1900", "/"));
  }
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "\ndata-key equivalence OK" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
