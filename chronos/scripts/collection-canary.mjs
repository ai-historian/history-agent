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

// --- Task 5: change_source additions survive a session_start ---------------
{
  const store = await import("../dist/utils/session-collection-store.js");
  const ws = workspace();
  const out = makeSource(ws, "InTree");
  const sid = "sess-1";

  store.saveSessionExtraMember(ws, sid, "/mnt/archive/Koeln_1871");
  check("extra member persists", store.loadSessionExtraMembers(ws, sid).includes("/mnt/archive/Koeln_1871"),
        JSON.stringify(store.loadSessionExtraMembers(ws, sid)));

  store.saveSessionExtraMember(ws, sid, "/mnt/archive/Koeln_1871");
  check("extra member add is idempotent", store.loadSessionExtraMembers(ws, sid).length === 1,
        JSON.stringify(store.loadSessionExtraMembers(ws, sid)));

  // THE TRAP: selecting a named collection then "all sources" must not wipe them.
  store.saveSessionCollection(ws, sid, "frankfurt");
  check("name and extraMembers coexist",
        store.loadSessionCollection(ws, sid) === "frankfurt" &&
        store.loadSessionExtraMembers(ws, sid).length === 1);

  store.saveSessionCollection(ws, sid, null);
  check("selecting all-sources clears name but KEEPS extra members",
        store.loadSessionCollection(ws, sid) === undefined &&
        store.loadSessionExtraMembers(ws, sid).length === 1,
        `name=${store.loadSessionCollection(ws, sid)} extras=${JSON.stringify(store.loadSessionExtraMembers(ws, sid))}`);

  // A legacy entry written as {name} must still read.
  const legacy = workspace();
  mkdirSync(join(legacy, ".chronos"), { recursive: true });
  writeFileSync(join(legacy, ".chronos", "session-collections.json"),
    JSON.stringify({ "sess-old": { name: "mainz" } }));
  check("legacy {name} entry still reads",
        store.loadSessionCollection(legacy, "sess-old") === "mainz");
  check("legacy entry has no extra members",
        store.loadSessionExtraMembers(legacy, "sess-old").length === 0);

  // Unknown sessions are empty, not undefined.
  check("unknown session -> empty array",
        Array.isArray(store.loadSessionExtraMembers(ws, "nope")) &&
        store.loadSessionExtraMembers(ws, "nope").length === 0);
  void out;
}

// --- R1: /select-collection must not wipe change_source additions ----------
// Both success branches of /select-collection rebuild/clear ctx.members from
// scratch (buildCollectionFromDiscovery for "all sources", loadCollectionInto's
// ctx.members.clear() for a named collection) — the exact same wipe
// session_start performs. replayExtraMembers must repair either wipe.
{
  const { buildCollectionFromDiscovery, deriveRef, dataKeyForRef, replayExtraMembers } =
    await import("../dist/tools/collection-context.js");
  const store = await import("../dist/utils/session-collection-store.js");

  const ws = workspace();
  makeSource(ws, "InTree");
  const sid = "sess-r1";

  // An out-of-tree source, added the way change_source would (outside sources/).
  const archiveRoot = mkdtempSync(join(tmpdir(), "ch-archive-"));
  const archiveSource = join(archiveRoot, "Koeln_1871");
  mkdirSync(join(archiveSource, "png"), { recursive: true });
  writeFileSync(join(archiveSource, "png", "page_0001.png"), Buffer.alloc(8));

  // A once-added source whose png/ has since vanished — replay must skip it.
  const goneRoot = mkdtempSync(join(tmpdir(), "ch-gone-"));
  const goneSource = join(goneRoot, "Vanished_1900"); // deliberately no png/ dir

  store.saveSessionExtraMember(ws, sid, archiveSource);
  store.saveSessionExtraMember(ws, sid, goneSource);
  // A persisted extra member whose deriveRef genuinely COLLIDES with a source
  // discovered under sources/ — this is the only thing that can make the
  // `ctx.members.has(ref)` guard's absence observable. Without this, "InTree"
  // is never reachable from extraMembers, so removing the guard is invisible.
  store.saveSessionExtraMember(ws, sid, join(ws, "sources", "InTree"));

  // The ref/dataDir a real change_source call would have produced for it.
  const expectRef = deriveRef(ws, archiveSource);
  const expectDataDir = join(ws, "data", dataKeyForRef(expectRef, archiveSource));

  const ctx = createCollectionContext();
  buildCollectionFromDiscovery(ctx, ws); // the wipe both call sites perform
  check("sanity: catalog fresh from discovery has no archive member yet",
        !ctx.members.has(expectRef));

  const inTreeBefore = ctx.members.get("InTree");

  replayExtraMembers(ctx, ws, sid);

  check("replay adds the extra member back",
        ctx.members.has(expectRef));
  const replayed = ctx.members.get(expectRef);
  check("replayed member has the same ref change_source would derive",
        replayed?.ref === expectRef, replayed?.ref);
  check("replayed member has the same dataDir change_source would derive",
        replayed?.dataDir === expectDataDir,
        `got ${replayed?.dataDir}`);
  check("replayed member's path is the archive source",
        replayed?.path === archiveSource);

  check("a path whose png/ vanished is skipped, not added",
        !ctx.members.has(deriveRef(ws, goneSource)));

  // extraMembers also persisted a path deriving to "InTree", which collides
  // with the source discovery already put in ctx.members — this is a REAL
  // collision test (unlike a ref that's never in extraMembers): if the
  // `ctx.members.has(ref)` guard in replayExtraMembers were removed, this
  // would overwrite the entry with a freshly-constructed (but field-identical)
  // object, so an identity (===) comparison is required to catch it.
  check("an already-present ref (from discovery) is not overwritten by replay",
        ctx.members.get("InTree") === inTreeBefore);

  // Simulate the second wipe a named-collection switch performs, and replay
  // again — the already-restored extra member must not be duplicated/replaced.
  const archiveAfterFirstReplay = ctx.members.get(expectRef);
  buildCollectionFromDiscovery(ctx, ws);
  replayExtraMembers(ctx, ws, sid);
  check("replaying again after another wipe still restores exactly one entry",
        ctx.members.has(expectRef) && ctx.members.size === 2,
        `size=${ctx.members.size}`);
  // The wipe reconstructs the member from scratch (a new object, since nothing
  // caches the old one across a full catalog rebuild) — so assert the fields
  // survive unchanged rather than object identity, which is expected to differ.
  const archiveAfterSecondReplay = ctx.members.get(expectRef);
  check("second replay reconstructs the same member fields as the first",
        archiveAfterSecondReplay?.ref === archiveAfterFirstReplay?.ref &&
        archiveAfterSecondReplay?.path === archiveAfterFirstReplay?.path &&
        archiveAfterSecondReplay?.dataDir === archiveAfterFirstReplay?.dataDir,
        JSON.stringify({ first: archiveAfterFirstReplay, second: archiveAfterSecondReplay }));
}

// --- R2: saveSessionExtraMember is defensive against a corrupted store -----
// loadSessionExtraMembers already filters non-string entries out of a corrupt
// extraMembers array; saveSessionExtraMember must be equally defensive when
// extraMembers itself isn't an array at all (hand-edited/corrupted sidecar).
{
  const store = await import("../dist/utils/session-collection-store.js");
  const ws = workspace();
  const chronosDir = join(ws, ".chronos");
  mkdirSync(chronosDir, { recursive: true });
  const storeFile = join(chronosDir, "session-collections.json");

  // extraMembers is a bare string rather than an array.
  const sidStr = "sess-corrupt-string";
  const fakePathA = join(tmpdir(), "ch-fake-archive", "A");
  const fakePathB = join(tmpdir(), "ch-fake-archive", "B");
  writeFileSync(storeFile, JSON.stringify({ [sidStr]: { extraMembers: fakePathA } }));

  let threwString = false;
  try {
    store.saveSessionExtraMember(ws, sidStr, fakePathB);
  } catch {
    threwString = true;
  }
  check("saveSessionExtraMember does not throw when extraMembers is a string", !threwString);
  check("saveSessionExtraMember replaces a corrupt string extraMembers with a clean single-entry array",
        store.loadSessionExtraMembers(ws, sidStr).length === 1 &&
        store.loadSessionExtraMembers(ws, sidStr)[0] === fakePathB,
        JSON.stringify(store.loadSessionExtraMembers(ws, sidStr)));

  // extraMembers is an object rather than an array.
  const sidObj = "sess-corrupt-object";
  const fakePathC = join(tmpdir(), "ch-fake-archive", "C");
  writeFileSync(storeFile, JSON.stringify({ [sidObj]: { extraMembers: { oops: true } } }));

  let threwObject = false;
  try {
    store.saveSessionExtraMember(ws, sidObj, fakePathC);
  } catch {
    threwObject = true;
  }
  check("saveSessionExtraMember does not throw when extraMembers is an object", !threwObject);
  check("saveSessionExtraMember replaces a corrupt object extraMembers with a clean single-entry array",
        store.loadSessionExtraMembers(ws, sidObj).length === 1 &&
        store.loadSessionExtraMembers(ws, sidObj)[0] === fakePathC,
        JSON.stringify(store.loadSessionExtraMembers(ws, sidObj)));
}

console.log(failures === 0 ? "\ncollection canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
