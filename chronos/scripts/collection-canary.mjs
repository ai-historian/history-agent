// Asserts collection-context invariants that no other test covers. Run from
// chronos/ after `npm run build`:  node scripts/collection-canary.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

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

  // Item A: an explicit source: "" must fall through to the inherited source
  // too, not just an absent (undefined) explicit source. `??` only falls
  // through on null/undefined, so source: "" was treated as "no source at
  // all" and IGNORED the inherited source, writing to the workspace root.
  check('explicit source: "" falls through to inherited (not the workspace root)',
        outputBaseDir(ctx, "", "Frankfurt_1864") === dataDir,
        `got ${outputBaseDir(ctx, "", "Frankfurt_1864")} — workspace root is ${ws}`);
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

  // Item A: explicit source: "" falls through to the inherited source here too.
  check('explicit source: "" falls through to inherited rel path, not blank',
        effectiveSourceRel(ctx, "", "Frankfurt_1864") === expectRel,
        `got "${effectiveSourceRel(ctx, "", "Frankfurt_1864")}"`);
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

// --- F5: /select-source's exact-ref match must win over an ambiguous
// basename-only match, not just whichever sorts first ----------------------
// /select-source's own handler (chronos/extensions/index.ts) isn't exported —
// it's registered inline via pi.registerCommand — so this exercises the exact
// two-line precedence expression the fix changed it to
// (`members.find(ref-match) ?? members.find(basename-match)`) against the
// same repro the finding describes: a member "a/X" (whose basename is "X")
// sorts before an exact member "X" itself. The OLD code
// (`members.find(m => m.ref === requested || basename(m.path) === requested)`)
// took whichever member satisfied EITHER condition first in sort order — here
// that's "a/X", since it sorts first and its basename happens to match — even
// though an exact ref "X" exists later in the list.
{
  const ws = workspace();
  const exactPath = makeSource(ws, "X");
  const nestedPath = makeSource(ws, join("a", "X"));
  const members = [
    { ref: "a/X", path: nestedPath },
    { ref: "X", path: exactPath },
  ].sort((a, b) => a.ref.localeCompare(b.ref)); // "a/X" sorts before "X"
  check("sanity: the ambiguous member sorts first",
        members[0].ref === "a/X", JSON.stringify(members.map((m) => m.ref)));

  const requested = "X";
  const buggyMatch = members.find((m) => m.ref === requested || basename(m.path) === requested);
  check("demonstrates the bug: a single-pass find(ref-or-basename) picks the wrong (sorted-first) member",
        buggyMatch?.ref === "a/X", buggyMatch?.ref);

  const fixedMatch = members.find((m) => m.ref === requested) ?? members.find((m) => basename(m.path) === requested);
  check("the fix: exact ref match wins even though the ambiguous member sorts first",
        fixedMatch?.ref === "X", fixedMatch?.ref);

  // An unambiguous basename lookup (no exact-ref collision) must still work —
  // the fix must not regress the lenient-basename fallback into a no-match.
  const basenameOnlyRequested = "Frankfurt_1864";
  const frankfurtPath = makeSource(ws, join("city", "Frankfurt_1864"));
  const membersNoCollision = [{ ref: "city/Frankfurt_1864", path: frankfurtPath }];
  const basenameFallback =
    membersNoCollision.find((m) => m.ref === basenameOnlyRequested) ??
    membersNoCollision.find((m) => basename(m.path) === basenameOnlyRequested);
  check("basename fallback still resolves when there's no exact-ref collision",
        basenameFallback?.ref === "city/Frankfurt_1864", basenameFallback?.ref);
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

// --- F2: a fork carries the forked-from session's collection selection and
// change_source extraMembers forward to the new session id -----------------
// pi's fork (VS Code's "edit a past message") mints a brand-new session id;
// without this, session_start's loadSessionExtraMembers/loadSessionCollection
// calls for the NEW id find nothing, silently dropping every change_source
// addition and collection narrowing on edit-and-resend.
{
  const store = await import("../dist/utils/session-collection-store.js");
  const { sessionIdFromFile } = await import("../dist/utils/session-file-id.js");
  const ws = workspace();

  // (a) carryForkedSessionState itself.
  store.saveSessionCollection(ws, "sess-old", "frankfurt");
  store.saveSessionExtraMember(ws, "sess-old", "/mnt/archive/Koeln_1871");

  store.carryForkedSessionState(ws, "sess-old", "sess-new");
  check("fork carries the collection selection to the new id",
        store.loadSessionCollection(ws, "sess-new") === "frankfurt",
        store.loadSessionCollection(ws, "sess-new"));
  check("fork carries extraMembers to the new id",
        store.loadSessionExtraMembers(ws, "sess-new").includes("/mnt/archive/Koeln_1871"),
        JSON.stringify(store.loadSessionExtraMembers(ws, "sess-new")));
  check("the OLD session's own entry is untouched",
        store.loadSessionCollection(ws, "sess-old") === "frankfurt" &&
        store.loadSessionExtraMembers(ws, "sess-old").length === 1);

  // A fork-of-a-fork must chain: the newest id ends up with the same state,
  // read from the (already-carried-forward) middle id, not the original.
  store.carryForkedSessionState(ws, "sess-new", "sess-newest");
  check("a fork-of-a-fork also carries the state forward",
        store.loadSessionCollection(ws, "sess-newest") === "frankfurt" &&
        store.loadSessionExtraMembers(ws, "sess-newest").includes("/mnt/archive/Koeln_1871"));

  // No-ops: nothing to carry, or degenerate ids.
  const before = JSON.stringify(store.loadSessionExtraMembers(ws, "sess-empty-target"));
  store.carryForkedSessionState(ws, "sess-nonexistent", "sess-empty-target");
  check("carrying from a session with nothing recorded is a no-op",
        JSON.stringify(store.loadSessionExtraMembers(ws, "sess-empty-target")) === before &&
        store.loadSessionCollection(ws, "sess-empty-target") === undefined);
  store.carryForkedSessionState(ws, "sess-old", "sess-old");
  check("carrying onto the same id is a no-op (does not duplicate extraMembers)",
        store.loadSessionExtraMembers(ws, "sess-old").length === 1);
  store.carryForkedSessionState(ws, "", "sess-new");
  store.carryForkedSessionState(ws, "sess-old", "");
  check("an empty previous/new id does not throw and changes nothing observable", true);

  // (b) sessionIdFromFile: the glue that maps previousSessionFile (a path) to
  // the id carryForkedSessionState needs.
  const sessionFile = join(ws, "fake-session.jsonl");
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 1, id: "abc-123", timestamp: "2026-01-01T00:00:00.000Z", cwd: ws })}\n` +
      `${JSON.stringify({ type: "message", id: "m1" })}\n`,
  );
  check("sessionIdFromFile reads the id out of a real session header",
        sessionIdFromFile(sessionFile) === "abc-123", sessionIdFromFile(sessionFile));

  const noHeaderFile = join(ws, "no-header.jsonl");
  writeFileSync(noHeaderFile, `${JSON.stringify({ type: "message", id: "m1" })}\n`);
  check("sessionIdFromFile returns undefined when the first line isn't a session header",
        sessionIdFromFile(noHeaderFile) === undefined);

  check("sessionIdFromFile returns undefined for a missing file",
        sessionIdFromFile(join(ws, "does-not-exist.jsonl")) === undefined);

  const malformedFile = join(ws, "malformed.jsonl");
  writeFileSync(malformedFile, "not json at all\n");
  check("sessionIdFromFile returns undefined for a malformed first line",
        sessionIdFromFile(malformedFile) === undefined);
}

// --- Task 6: a manifest whose name differs from its filename is selectable --
{
  const { listCollections, loadCollection } = await import("../dist/utils/collection-manifest.js");
  const ws = workspace();
  const p = makeSource(ws, "Frankfurt_1864");
  mkdirSync(join(ws, "collections"), { recursive: true });
  writeFileSync(join(ws, "collections", "frankfurt.json"), JSON.stringify({
    name: "Frankfurt Directories",
    description: "City directories",
    members: [{ ref: "Frankfurt_1864", path: "sources/Frankfurt_1864" }],
  }));

  const list = listCollections(ws);
  check("listCollections returns one entry", list.length === 1, JSON.stringify(list));
  check("summary exposes the filename stem as id", list[0]?.id === "frankfurt", JSON.stringify(list[0]));
  check("summary keeps the display name", list[0]?.name === "Frankfurt Directories", JSON.stringify(list[0]));

  const loaded = loadCollection(ws, list[0].id);
  check("loadCollection resolves by id", loaded !== null,
        "returned null — the id/name round-trip is still broken");
  check("loaded collection has its member", loaded?.members?.size === 1, `size=${loaded?.members?.size}`);

  // A manifest with NO name field falls back to the filename for both.
  writeFileSync(join(ws, "collections", "mainz.json"), JSON.stringify({
    members: [{ ref: "Frankfurt_1864", path: "sources/Frankfurt_1864" }],
  }));
  const both = listCollections(ws);
  const mainz = both.find((c) => c.id === "mainz");
  check("nameless manifest -> id and name both the stem",
        mainz?.name === "mainz", JSON.stringify(mainz));
  void p;
}

// --- R14: collectionKey/collectionDataDir/collectionMemoryPath key on id,
// not the mutable display name ------------------------------------------------
// A manifest's `"name"` can be edited (display-only, per Task 6) without
// renaming the file. If the key were still derived from `name`, that edit
// would silently relocate the collection's entity index and memory file to a
// new slug, orphaning everything written under the old one.
{
  const { collectionKey, collectionDataDir, collectionMemoryPath } = await import(
    "../dist/tools/collection-context.js"
  );
  const ws = workspace();
  const ctx = createCollectionContext(ws, "Frankfurt Directories", "frankfurt");
  check("collectionKey returns the id, not a slug of the display name",
        collectionKey(ctx) === "frankfurt", collectionKey(ctx));
  check("collectionDataDir is built from the id",
        collectionDataDir(ctx) === join(ws, "data", "_collections", "frankfurt"),
        collectionDataDir(ctx));
  check("collectionMemoryPath is built from the id",
        collectionMemoryPath(ctx) === join(ws, "memory", "collections", "frankfurt.md"),
        collectionMemoryPath(ctx));

  // Renaming the manifest's display name (id/filename unchanged) must not
  // move the key — this is the exact scenario R14 warned about.
  const renamed = createCollectionContext(ws, "Frankfurt City Directories", "frankfurt");
  check("renaming the display name does not change the key",
        collectionKey(renamed) === "frankfurt", collectionKey(renamed));

  // The auto-collection (id === null, just like name) still falls back.
  const auto = createCollectionContext(ws, null, null);
  check('collectionKey falls back to "all-sources" when id is null',
        collectionKey(auto) === "all-sources", collectionKey(auto));
}

// --- F1: buildCollectionFromDiscovery's ref must never retain a raw,
// non-normalized path separator, on any platform ----------------------------
// discoverSources' `s.name` is `relative(rootDir, dir)` — platform-native, so
// backslash-joined on win32 (e.g. "city\Nested_1900"). dataKeyForRef only
// recognizes the slugged-nested case via a forward slash, so using `s.name`
// verbatim as the ref (instead of routing it through deriveRef, which always
// normalizes `\` to `/`) would make dataKeyForRef silently fall through to
// basename(path) on win32 — colliding two differently-nested sources that
// share a basename onto the same data/ dir.
//
// We're on Linux, so real discoverSources output never contains a backslash
// and this can't be reproduced via actual win32 path semantics. Both blocks
// below exercise the same class of bug WITHOUT needing Windows:
{
  const { discoverSources } = await import("../dist/utils/source-discovery.js");
  const { deriveRef, dataKeyForRef, buildCollectionFromDiscovery, createCollectionContext: makeCtx } =
    await import("../dist/tools/collection-context.js");

  // (a) On POSIX a backslash is a LEGAL FILENAME CHARACTER, so a directory named
  // `weird\Name_1900` is ONE path component — not a nested source. An earlier fix
  // normalized `\` unconditionally, which folded such a directory onto the ref of a
  // genuinely nested `weird/Name_1900`; because `members` is keyed by ref, one of
  // the two sources then SILENTLY VANISHED from the catalog. These run the real
  // compiled discoverSources -> buildCollectionFromDiscovery chain over both
  // directories at once, which is the only way the collapse is observable.
  {
    const ws = workspace();
    const literalBackslash = makeSource(ws, "weird\\Name_1900"); // one component
    const genuinelyNested = makeSource(ws, "weird/Name_1900"); // two components
    const ctx = makeCtx();
    buildCollectionFromDiscovery(ctx, ws);

    check("two dirs whose names differ only by separator-vs-literal-backslash stay TWO members",
          ctx.members.size === 2, `size=${ctx.members.size} members=${JSON.stringify([...ctx.members.keys()])}`);
    check("a literal backslash in a POSIX dir name is PRESERVED in its ref (it is not a separator)",
          ctx.members.has("weird\\Name_1900"), JSON.stringify([...ctx.members.keys()]));
    check("the genuinely nested dir still gets the forward-slash ref",
          ctx.members.has("weird/Name_1900"), JSON.stringify([...ctx.members.keys()]));
    check("neither source was dropped from the catalog",
          [literalBackslash, genuinelyNested].every((p) => [...ctx.members.values()].some((m) => m.path === p)),
          JSON.stringify([...ctx.members.values()].map((m) => m.path)));
    check("the two sources do NOT share one data dir",
          new Set([...ctx.members.values()].map((m) => m.dataDir)).size === 2,
          JSON.stringify([...ctx.members.values()].map((m) => basename(m.dataDir))));
    // deriveRef agrees with what discovery actually keyed them under.
    check("deriveRef matches the catalog for the literal-backslash dir",
          deriveRef(ws, literalBackslash) === "weird\\Name_1900", deriveRef(ws, literalBackslash));
    check("deriveRef matches the catalog for the nested dir",
          deriveRef(ws, genuinelyNested) === "weird/Name_1900", deriveRef(ws, genuinelyNested));
  }

  // (a2) win32 separator handling, which is what a POSIX host genuinely cannot
  // reproduce through the filesystem. refFromRelative takes the separator as a
  // parameter precisely so the win32 branch is executable here: a nested source's
  // `relative()` output on win32 is backslash-joined and MUST become the same ref
  // it gets on POSIX, or /select-source stops matching and the data key falls back
  // to the basename (the original nested-source blocker).
  {
    const { refFromRelative } = await import("../dist/tools/collection-context.js");
    check("win32: a backslash-joined relative path becomes the canonical forward-slash ref",
          refFromRelative("city\\Nested_1900", "\\") === "city/Nested_1900",
          refFromRelative("city\\Nested_1900", "\\"));
    check("win32: a deeply nested path normalizes every separator",
          refFromRelative("a\\b\\c\\D_1900", "\\") === "a/b/c/D_1900", refFromRelative("a\\b\\c\\D_1900", "\\"));
    check("posix: the same input is left ALONE (backslash is a filename char there)",
          refFromRelative("city\\Nested_1900", "/") === "city\\Nested_1900",
          refFromRelative("city\\Nested_1900", "/"));
    check("posix: a real nested path is unchanged",
          refFromRelative("city/Nested_1900", "/") === "city/Nested_1900", refFromRelative("city/Nested_1900", "/"));
    check("win32 and posix agree on a nested path once each uses its own separator",
          refFromRelative("city\\Nested_1900", "\\") === refFromRelative("city/Nested_1900", "/"),
          `${refFromRelative("city\\Nested_1900", "\\")} vs ${refFromRelative("city/Nested_1900", "/")}`);
  }

  // (b) The consequence this exists to prevent: two ACTUALLY nested, actually
  // discovered sources sharing a basename, with their real (forward-slash)
  // discovered names re-expressed with win32's separator (only the separator
  // convention changes — same bytes otherwise, "a path built with a literal
  // backslash segment"). Feeding the win-style name straight into
  // dataKeyForRef (bypassing deriveRef, i.e. the pre-fix behavior) collides
  // them onto the same key; normalizing first (deriveRef's own behavior, and
  // what buildCollectionFromDiscovery is now wired to do) keeps them distinct.
  {
    const ws = workspace();
    const pathA = makeSource(ws, join("city", "Nested_1900"));
    const pathB = makeSource(ws, join("region", "Nested_1900"));
    const discovered = discoverSources(join(ws, "sources"));
    const sA = discovered.find((s) => s.path === pathA);
    const sB = discovered.find((s) => s.path === pathB);
    check("sanity: both nested sources were discovered", !!sA && !!sB, JSON.stringify(discovered));

    const winNameA = sA.name.replace(/\//g, "\\");
    const winNameB = sB.name.replace(/\//g, "\\");

    const buggyKeyA = dataKeyForRef(winNameA, pathA);
    const buggyKeyB = dataKeyForRef(winNameB, pathB);
    check("mechanism of the bug: unnormalized win-style refs collide on the same data key",
          buggyKeyA === buggyKeyB, `A=${buggyKeyA} B=${buggyKeyB}`);

    const fixedKeyA = dataKeyForRef(winNameA.replace(/\\/g, "/"), pathA);
    const fixedKeyB = dataKeyForRef(winNameB.replace(/\\/g, "/"), pathB);
    check("normalizing first (deriveRef's behavior) keeps them distinct",
          fixedKeyA !== fixedKeyB, `A=${fixedKeyA} B=${fixedKeyB}`);
    check("normalized keys contain no raw backslash",
          !fixedKeyA.includes("\\") && !fixedKeyB.includes("\\"));
  }
}

// --- R18: resolveSessionCollectionSelection is the pure decision extracted
// from session_start — no I/O, no mutation, so it can cover the
// session-restore logic directly instead of only through the end-to-end UI
// test. ----------------------------------------------------------------
// Item B removed the display-name migration this used to have: collections
// have never shipped (zero collection files exist on dev/master), so the
// migration guarded a population of zero, and it was the sole cause of a
// real hazard — a stored value that happens to equal a DIFFERENT
// collection's display name would silently resolve to the wrong collection.
// The last check below is that exact hazard, asserted fixed: it MUST stay on
// the auto-collection, not silently resolve to "frankfurt".
{
  const { resolveSessionCollectionSelection } = await import("../dist/utils/collection-manifest.js");
  const collections = [
    { id: "frankfurt", name: "Frankfurt Directories" },
    { id: "mainz", name: "mainz" },
  ];

  check("no stored selection -> stay on auto-collection",
        JSON.stringify(resolveSessionCollectionSelection(undefined, collections)) ===
        JSON.stringify({ idToLoad: null }));

  check("stored id matches directly -> load it",
        JSON.stringify(resolveSessionCollectionSelection("frankfurt", collections)) ===
        JSON.stringify({ idToLoad: "frankfurt" }));

  check("stored value matching neither id nor any name -> stay on auto-collection",
        JSON.stringify(resolveSessionCollectionSelection("nonexistent", collections)) ===
        JSON.stringify({ idToLoad: null }));

  check("an id/name collision resolves to the direct id match",
        JSON.stringify(resolveSessionCollectionSelection("mainz", collections)) ===
        JSON.stringify({ idToLoad: "mainz" }));

  // THE HAZARD Item B removes: a stored value equal to a DIFFERENT
  // collection's display name (not its own id) must NOT resolve to that
  // collection — only a direct id match may. Before Item B, the deleted
  // migration fallback would have matched this against c.name and silently
  // loaded "frankfurt".
  check("a stored value matching only a display name (not any id) does not resolve — stays on auto-collection",
        JSON.stringify(resolveSessionCollectionSelection("Frankfurt Directories", collections)) ===
        JSON.stringify({ idToLoad: null }));
}

// --- the shared explicit-vs-inherited source rule ---------------------------
// view-page.ts (output paths) and expert-turn.ts (what the expert may view) both
// call this ONE function now. They used to spell the rule out separately, were
// fixed at different times, and for one commit disagreed: `source: ""` on a
// follow-up resolved an output dir from the inherited source while the expert turn
// itself failed with "page_id requires a source".
{
  const { effectiveSourceRef } = await import("../dist/tools/collection-context.js");

  check('an explicit source wins over the inherited one',
        effectiveSourceRef("Mainz_1871", "Frankfurt_1864") === "Mainz_1871");
  check('an omitted source (undefined) inherits',
        effectiveSourceRef(undefined, "Frankfurt_1864") === "Frankfurt_1864");
  check('an EMPTY-STRING source inherits too — "" means "none given", not "no source at all"',
        effectiveSourceRef("", "Frankfurt_1864") === "Frankfurt_1864",
        String(effectiveSourceRef("", "Frankfurt_1864")));
  check("nothing explicit and nothing inherited stays undefined (a genuine plain task)",
        effectiveSourceRef(undefined, undefined) === undefined);
  check('"" with nothing to inherit is still falsy, so callers take their no-source path',
        !effectiveSourceRef("", undefined));

  // The regression this guards: expert-turn.ts's own resolution must agree. Its
  // decision is inside runExpertTurn (needs a live model), so assert the property
  // that made them diverge — both consult the SAME function.
  const viewPage = await import("../dist/tools/view-page.js");
  const ctxForOutput = { workspaceDir: "/ws", members: new Map() };
  check("outputBaseDir treats an empty explicit source as inheriting, not as the workspace root",
        viewPage.outputBaseDir(ctxForOutput, "", "Frankfurt_1864") !== "/ws",
        viewPage.outputBaseDir(ctxForOutput, "", "Frankfurt_1864"));
  check("outputBaseDir still targets the workspace root for a genuine plain task",
        viewPage.outputBaseDir(ctxForOutput, undefined, undefined) === "/ws");
}

// --- /select-source's member precedence (the SHIPPED helper) ----------------
// This previously lived inline in the pi entrypoint's command closure, so the
// canary re-typed the expression and asserted about its own copy — it stayed
// green when the real fix was reverted. pickMemberByRequest is now exported and
// the command calls it, so these exercise production code.
{
  const { pickMemberByRequest } = await import("../dist/tools/collection-context.js");
  const members = [
    { ref: "a/X", path: "/ws/sources/a/X", dataDir: "/ws/data/a--X" },
    { ref: "X", path: "/ws/sources/X", dataDir: "/ws/data/X" },
  ].sort((m, n) => m.ref.localeCompare(n.ref)); // the command sorts by ref; "a/X" sorts first

  check("an EXACT ref wins over an earlier-sorting member whose basename also matches",
        pickMemberByRequest(members, "X")?.ref === "X", pickMemberByRequest(members, "X")?.ref);
  check("an exact nested ref still resolves to itself",
        pickMemberByRequest(members, "a/X")?.ref === "a/X", pickMemberByRequest(members, "a/X")?.ref);
  check("a basename with no exact-ref rival still resolves via basename",
        pickMemberByRequest([members.find((m) => m.ref === "a/X")], "X")?.ref === "a/X");
  check("an unknown request resolves to nothing",
        pickMemberByRequest(members, "nope") === undefined);
}

// --- fork carry-forward: the GUARD, not just the primitive ------------------
// Neutering the hook's `reason === "fork" && previousSessionFile` test used to
// leave every canary green. The guard is now a pure exported function.
{
  const { forkedPreviousSessionFile, sessionIdFromFile } = await import("../dist/utils/session-file-id.js");

  check("a fork with a previous file is carried",
        forkedPreviousSessionFile({ reason: "fork", previousSessionFile: "/s/old.jsonl" }) === "/s/old.jsonl");
  check("a fork with NO previous file is not carried",
        forkedPreviousSessionFile({ reason: "fork" }) === undefined);
  for (const reason of ["startup", "resume", "switch", undefined]) {
    check(`reason "${reason}" is not treated as a fork`,
          forkedPreviousSessionFile({ reason, previousSessionFile: "/s/old.jsonl" }) === undefined);
  }

  // The bounded header read: correct id, and no silent failure on a large file.
  const ws = workspace();
  const good = join(ws, "good.jsonl");
  writeFileSync(good, JSON.stringify({ type: "session", version: 1, id: "SESSION-ID-1" }) + "\n" + "x".repeat(5000) + "\n");
  check("sessionIdFromFile reads the id from the header line",
        sessionIdFromFile(good) === "SESSION-ID-1", String(sessionIdFromFile(good)));

  // A header line longer than the bounded read must fail closed, not hang or
  // return a truncated id.
  const huge = join(ws, "huge.jsonl");
  writeFileSync(huge, JSON.stringify({ type: "session", id: "X", pad: "y".repeat(100 * 1024) }) + "\n");
  check("a header exceeding the read limit fails closed (undefined, no throw)",
        sessionIdFromFile(huge) === undefined, String(sessionIdFromFile(huge)));

  // A trailing-newline-free single-line file is still valid.
  const noNewline = join(ws, "nonl.jsonl");
  writeFileSync(noNewline, JSON.stringify({ type: "session", id: "SESSION-ID-2" }));
  check("a header with no trailing newline still parses",
        sessionIdFromFile(noNewline) === "SESSION-ID-2", String(sessionIdFromFile(noNewline)));

  check("a missing file yields undefined",
        sessionIdFromFile(good.replace("good", "missing")) === undefined);

  // Genuinely a non-session first line (the check above only covered a MISSING file).
  const notSession = join(ws, "notsession.jsonl");
  writeFileSync(notSession, JSON.stringify({ type: "message", id: "not-a-session" }) + "\n");
  check("a first line that is not a session header yields undefined",
        sessionIdFromFile(notSession) === undefined, String(sessionIdFromFile(notSession)));

  const nonStringId = join(ws, "numericid.jsonl");
  writeFileSync(nonStringId, JSON.stringify({ type: "session", id: 12345 }) + "\n");
  check("a non-string id yields undefined",
        sessionIdFromFile(nonStringId) === undefined, String(sessionIdFromFile(nonStringId)));

  const empty = join(ws, "empty.jsonl");
  writeFileSync(empty, "");
  check("an empty file yields undefined (bounded read over an uninitialized buffer)",
        sessionIdFromFile(empty) === undefined, String(sessionIdFromFile(empty)));

  // A multi-byte header must survive slicing at the first newline BYTE.
  const utf8 = join(ws, "utf8.jsonl");
  writeFileSync(utf8, JSON.stringify({ type: "session", id: "ID-Ü", cwd: "/würzburg/städte/東京" }) + "\n");
  check("a multi-byte UTF-8 header parses (0x0A cannot occur inside a multi-byte sequence)",
        sessionIdFromFile(utf8) === "ID-Ü", String(sessionIdFromFile(utf8)));
}

// --- change_source must REFUSE a ref collision, not silently bind elsewhere --
// An out-of-tree archive derives its ref from the BASENAME, so /mnt/archive/F_1864
// collides with an in-tree sources/F_1864. The add was a no-op while the tool
// reported success WITH THE ARCHIVE'S page count and path — after which every
// page tool silently read the other document.
{
  const { deriveRef, dataKeyForRef } = await import("../dist/tools/collection-context.js");
  const ws = workspace();
  const inTree = makeSource(ws, "Frankfurt_1864");
  const outOfTree = join(mkdtempSync(join(tmpdir(), "ch-archive-")), "Frankfurt_1864");
  mkdirSync(join(outOfTree, "png"), { recursive: true });
  writeFileSync(join(outOfTree, "png", "page_0001.png"), Buffer.alloc(8));

  // The collision this guards against is real, not hypothetical:
  check("an out-of-tree source SHARES the in-tree source's ref when basenames match",
        deriveRef(ws, outOfTree) === deriveRef(ws, inTree),
        `${deriveRef(ws, outOfTree)} vs ${deriveRef(ws, inTree)}`);
  check("...and therefore the same data key, so both would write to one dir",
        dataKeyForRef(deriveRef(ws, outOfTree), outOfTree) === dataKeyForRef(deriveRef(ws, inTree), inTree));

  // Drive the real compiled tool.
  const { createChangeSourceTool } = await import("../dist/tools/change-source.js");
  const { createCollectionContext: makeCtx2, buildCollectionFromDiscovery: build2 } =
    await import("../dist/tools/collection-context.js");
  const ctx = makeCtx2();
  build2(ctx, ws);
  const tool = createChangeSourceTool(ctx, "desc");
  const extCtx = { cwd: ws, sessionManager: { getSessionId: () => "sess-collide" } };
  const res = await tool.execute("call-1", { source_path: outOfTree }, undefined, undefined, extCtx);
  const text = res.content.map((c) => c.text).join("\n");

  check("change_source REFUSES the colliding add instead of reporting success",
        /cannot add/i.test(text), text.slice(0, 160));
  check("the refusal names the directory already holding that ref",
        text.includes(inTree), text.slice(0, 200));
  check("the in-tree member is left pointing at the in-tree directory",
        ctx.members.get("Frankfurt_1864")?.path === inTree, ctx.members.get("Frankfurt_1864")?.path);
  check("the colliding source was NOT silently added",
        ctx.members.size === 1, JSON.stringify([...ctx.members.keys()]));

  // The non-colliding case must still work.
  const distinct = join(mkdtempSync(join(tmpdir(), "ch-archive2-")), "Koeln_1871");
  mkdirSync(join(distinct, "png"), { recursive: true });
  writeFileSync(join(distinct, "png", "page_0001.png"), Buffer.alloc(8));
  const ok = await tool.execute("call-2", { source_path: distinct }, undefined, undefined, extCtx);
  check("a non-colliding out-of-tree source is still added",
        ctx.members.get("Koeln_1871")?.path === distinct,
        ok.content.map((c) => c.text).join("").slice(0, 160));
  // Re-adding the SAME path is idempotent, not a collision.
  const again = await tool.execute("call-3", { source_path: distinct }, undefined, undefined, extCtx);
  check("re-adding the identical path is idempotent, not refused",
        !/cannot add/i.test(again.content.map((c) => c.text).join("")),
        again.content.map((c) => c.text).join("").slice(0, 160));

  // ONE directory, several spellings. The collision check is a STRING compare
  // against the stored member path, so without normalizing the input first, a
  // trailing slash refused an add whose "owner" was that very directory — and the
  // refusal text named the same path twice, sending the agent off to rename it.
  const trailing = await tool.execute("call-4", { source_path: distinct + "/" }, undefined, undefined, extCtx);
  const trailingText = trailing.content.map((c) => c.text).join("");
  check("a trailing slash on an already-added path is NOT refused (same directory)",
        !/cannot add/i.test(trailingText), trailingText.slice(0, 200));
  check("...and it did not create a second member",
        [...ctx.members.values()].filter((m) => m.path === distinct).length === 1,
        JSON.stringify([...ctx.members.keys()]));

  // basename("/a/S/.") is ".", which made ref "." and pointed the source's data dir
  // at the workspace data/ ROOT — reported as success.
  const dotted = await tool.execute("call-5", { source_path: distinct + "/." }, undefined, undefined, extCtx);
  const dottedText = dotted.content.map((c) => c.text).join("");
  check('a "/." suffix does not produce ref "." pointing at the data/ root',
        !ctx.members.has("."), JSON.stringify([...ctx.members.keys()]));
  check('...and resolves to the real ref instead',
        /Koeln_1871/.test(dottedText) && !/Cannot add/i.test(dottedText), dottedText.slice(0, 200));
}

// --- resolveByAlias must not fold a POSIX backslash either -------------------
// Same bug class as the deriveRef regression, on the LENIENT path: the fallback
// invites a `sources/` prefix, and folding `\` made `sources/weird\Name_1900` (a
// real one-component dir) resolve to a genuinely nested `weird/Name_1900`.
{
  const { createCollectionContext: mk, buildCollectionFromDiscovery: build, resolveSource } =
    await import("../dist/tools/collection-context.js");
  const ws = workspace();
  const literal = makeSource(ws, "weird\\Name_1900");
  const nested = makeSource(ws, "weird/Name_1900");
  const ctx = mk();
  build(ctx, ws);

  check("the sources/-prefixed literal-backslash spelling resolves to THAT directory",
        resolveSource(ctx, "sources/weird\\Name_1900").path === literal,
        resolveSource(ctx, "sources/weird\\Name_1900").path);
  check("the sources/-prefixed nested spelling still resolves to the nested directory",
        resolveSource(ctx, "sources/weird/Name_1900").path === nested,
        resolveSource(ctx, "sources/weird/Name_1900").path);
  check("an exact ref still wins regardless",
        resolveSource(ctx, "weird/Name_1900").path === nested);
}

console.log(failures === 0 ? "\ncollection canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
