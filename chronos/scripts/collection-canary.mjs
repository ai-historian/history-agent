// Asserts collection-context invariants that no other test covers. Run from
// chronos/ after `npm run build`:  node scripts/collection-canary.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCollectionContext } = await import("../dist/tools/collection-context.js");

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

console.log(failures === 0 ? "\ncollection canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
