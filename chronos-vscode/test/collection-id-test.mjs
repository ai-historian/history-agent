// The host duplicates the agent's collection discovery (see sources.ts), so it
// needs the same id/name split or the picker sends a value the agent cannot
// resolve.
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
};

const outfile = join(mkdtempSync(join(tmpdir(), "ch-src-")), "sources.mjs");
await build({
  entryPoints: [join(here, "../src/panel/sources.ts")],
  outfile, bundle: true, format: "esm", platform: "node",
});
const { discoverCollections } = await import(outfile);

const ws = mkdtempSync(join(tmpdir(), "ch-ws-"));
mkdirSync(join(ws, "collections"), { recursive: true });
writeFileSync(join(ws, "collections", "frankfurt.json"),
  JSON.stringify({ name: "Frankfurt Directories", members: [{ path: "sources/x" }] }));
writeFileSync(join(ws, "collections", "mainz.json"),
  JSON.stringify({ members: [{ path: "sources/y" }] }));

const list = discoverCollections(ws);
const fr = list.find((c) => c.name === "Frankfurt Directories");
check("host exposes the filename stem as id", fr?.id === "frankfurt", JSON.stringify(fr));
check("host keeps the display name", fr?.name === "Frankfurt Directories", JSON.stringify(fr));
const mz = list.find((c) => c.id === "mainz");
check("nameless manifest -> name falls back to the stem", mz?.name === "mainz", JSON.stringify(mz));

console.log(failures === 0 ? "\ncollection id test OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
