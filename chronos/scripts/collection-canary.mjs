// Asserts collection-context invariants that no other test covers. Run from
// chronos/ after `npm run build`:  node scripts/collection-canary.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCollectionContext, resolveSource } = await import("../dist/tools/collection-context.js");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
};

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "ch-coll-"));
  mkdirSync(join(ws, "sources"), { recursive: true });
  return ws;
}
function makeSource(ws, rel) {
  const p = join(ws, "sources", rel);
  mkdirSync(join(p, "png"), { recursive: true });
  writeFileSync(join(p, "png", "page_0001.png"), Buffer.alloc(8));
  return p;
}

// --- Task 3: output_file resolution for an inherited source -----------------
// A task_id follow-up inherits session.sourceRef, so the output dir must follow
// the EFFECTIVE source, not only an explicitly-passed one. Falling back to the
// workspace root writes a follow-up's output outside the source's data dir
// while the expert still views the inherited source.
{
  const { outputBaseDir } = await import("../dist/tools/view-page.js");
  const ws = workspace();
  const p = makeSource(ws, "Frankfurt_1864");
  const ctx = createCollectionContext(ws);
  const dataDir = join(ws, "data", "Frankfurt_1864");
  ctx.members.set("Frankfurt_1864", { ref: "Frankfurt_1864", path: p, dataDir });

  check("explicit source -> its data dir",
        outputBaseDir(ctx, "Frankfurt_1864", undefined) === dataDir,
        outputBaseDir(ctx, "Frankfurt_1864", undefined));

  // THE BUG: no explicit source, but the session remembers one.
  check("inherited source -> its data dir (not the workspace root)",
        outputBaseDir(ctx, undefined, "Frankfurt_1864") === dataDir,
        `got ${outputBaseDir(ctx, undefined, "Frankfurt_1864")} — workspace root is ${ws}`);

  check("explicit wins over inherited",
        outputBaseDir(ctx, "Frankfurt_1864", "Other") === dataDir);

  // A genuine plain task (no source anywhere) still targets the workspace root.
  check("no source at all -> workspace root",
        outputBaseDir(ctx, undefined, undefined) === ws,
        outputBaseDir(ctx, undefined, undefined));

  // An unresolvable ref yields "" so runExpertTurn reports the source error.
  check("unresolvable ref -> empty string",
        outputBaseDir(ctx, "Nope", undefined) === "",
        outputBaseDir(ctx, "Nope", undefined));
}

// --- R1: details.source for an inherited source (task_id follow-up) --------
// A sourceless task_id follow-up still self-zooms (view_page/view_region)
// against the session's inherited source, so details.source/the @path
// citation must reflect that effective source, not params.source alone —
// otherwise a citation chip from such a turn opens whatever source the panel
// currently happens to have open.
{
  const { effectiveSourceRel } = await import("../dist/tools/view-page.js");
  const ws = workspace();
  makeSource(ws, "Frankfurt_1864");
  const ctx = createCollectionContext(ws);
  const p = join(ws, "sources", "Frankfurt_1864");
  ctx.members.set("Frankfurt_1864", { ref: "Frankfurt_1864", path: p, dataDir: join(ws, "data", "Frankfurt_1864") });

  // Composed from the same primitive relative() uses (join), not a literal —
  // relative() returns platform-native separators (sources\Frankfurt_1864 on
  // win32), so a hardcoded "sources/Frankfurt_1864" would false-fail there.
  const expectRel = join("sources", "Frankfurt_1864");

  check("explicit source -> its rel path",
        effectiveSourceRel(ctx, "Frankfurt_1864", undefined) === expectRel,
        effectiveSourceRel(ctx, "Frankfurt_1864", undefined));

  // THE BUG: sourceless follow-up must still report the inherited source, not "".
  check("inherited source (sourceless follow-up) -> its rel path, not blank",
        effectiveSourceRel(ctx, undefined, "Frankfurt_1864") === expectRel,
        `got "${effectiveSourceRel(ctx, undefined, "Frankfurt_1864")}"`);

  check("explicit wins over inherited",
        effectiveSourceRel(ctx, "Frankfurt_1864", "Other") === expectRel);

  // A genuine plain task (no source anywhere) is blank, not an error.
  check("no source at all -> blank",
        effectiveSourceRel(ctx, undefined, undefined) === "",
        `"${effectiveSourceRel(ctx, undefined, undefined)}"`);

  // An unresolvable ref is blank too (mirrors outputBaseDir's error handling).
  check("unresolvable ref -> blank",
        effectiveSourceRel(ctx, "Nope", undefined) === "",
        `"${effectiveSourceRel(ctx, "Nope", undefined)}"`);
}

// --- Task 4: ambiguous bare basenames must error, not guess -----------------
{
  const ws = workspace();
  const a = makeSource(ws, join("frankfurt", "Adressbuch_1864"));
  const b = makeSource(ws, join("mainz", "Adressbuch_1864"));
  const ctx = createCollectionContext(ws);
  ctx.members.set("frankfurt/Adressbuch_1864",
    { ref: "frankfurt/Adressbuch_1864", path: a, dataDir: join(ws, "data", "frankfurt--Adressbuch_1864") });
  ctx.members.set("mainz/Adressbuch_1864",
    { ref: "mainz/Adressbuch_1864", path: b, dataDir: join(ws, "data", "mainz--Adressbuch_1864") });

  let msg = "";
  try { resolveSource(ctx, "Adressbuch_1864"); } catch (e) { msg = e.message; }
  check("ambiguous basename throws", msg !== "", "resolved silently instead of throwing");
  check("ambiguous error names both refs",
        msg.includes("frankfurt/Adressbuch_1864") && msg.includes("mainz/Adressbuch_1864"), msg);

  // An exact ref still resolves.
  check("exact ref still resolves",
        resolveSource(ctx, "mainz/Adressbuch_1864").path === b);
}

// An UNambiguous basename must still resolve — the lenient alias is a feature.
{
  const ws = workspace();
  const p = makeSource(ws, join("city", "Frankfurt_1864"));
  const ctx = createCollectionContext(ws);
  ctx.members.set("city/Frankfurt_1864",
    { ref: "city/Frankfurt_1864", path: p, dataDir: join(ws, "data", "city--Frankfurt_1864") });
  check("unambiguous basename still resolves",
        resolveSource(ctx, "Frankfurt_1864").path === p);
}

console.log(failures === 0 ? "\ncollection canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
