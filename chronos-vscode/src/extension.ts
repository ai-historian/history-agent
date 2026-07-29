import * as vscode from "vscode";
import * as path from "path";
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, renameSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { Worker } from "node:worker_threads";
import { hasPi } from "./pi-env";
// mupdf is ESM-only — loaded via dynamic import() where needed
import { HttpServer } from "./http-server";
import { ChronosPanel } from "./panel/chronos-panel";
import { discoverSources, countPages } from "./panel/sources";
import { withPdfDocument } from "./pdf-stream";
import {
  type IncompleteImport,
  partialPngDir,
  readImportMarker,
  writeImportMarker,
  updateImportMarker,
  clearImportMarker,
  finalizePartialImport,
  countPartialPages,
  findIncompleteImports,
} from "./import-status";
import { TRACE_ENTITY_SKILL } from "./workspace-templates";

// pi's npm package. @mariozechner/pi-coding-agent is deprecated and frozen at
// 0.73.1 ("use @earendil-works/pi-coding-agent going forward"); the renamed
// package is the maintained one. Override per-machine via chronos.piNpmPackage.
const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
const CHRONOS_PI_PACKAGE = "https://github.com/ai-historian/chronos";
// The pi-package repo was renamed history-agent → chronos. GitHub redirects the
// old URL, but pi keys a package's identity on the literal host/path, so an
// existing history-agent entry lingers as a duplicate unless we migrate it.
const LEGACY_PI_PACKAGE = "https://github.com/ai-historian/history-agent";

// pi's user settings list the configured packages (each entry is either a
// source string or a { source } object). Read them so we can detect what's
// installed instead of asking the user a question pi can already answer.
function piPackageSources(): string[] {
  try {
    const settingsPath = join(process.env.HOME ?? "", ".pi", "agent", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!Array.isArray(settings.packages)) return [];
    return settings.packages
      .map((p: unknown) => (typeof p === "string" ? p : (p as { source?: string } | null)?.source))
      .filter((s: unknown): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

// Any settings entry that resolves to the Chronos pi-package: the canonical or
// legacy GitHub URL (any scheme, with or without an `@<ref>` pin suffix), or a
// local dev checkout of chronos/. Matching broadly avoids re-prompting — or
// double-installing on top of a local dev path — when it's already registered.
function isChronosEntry(source: string): boolean {
  if (source.includes("ai-historian/chronos") || source.includes("ai-historian/history-agent")) return true;
  // local dev checkout: a filesystem path ending in /chronos
  return /(^|[\/\\])chronos$/.test(source.replace(/[\/\\]+$/, ""));
}

function hasChronosPiPackage(): boolean {
  return piPackageSources().some(isChronosEntry);
}

function hasLegacyPiPackage(): boolean {
  return piPackageSources().some((s) => s.includes("ai-historian/history-agent"));
}

// A git/https/ssh URL entry, as opposed to a local filesystem path.
function isGitUrlEntry(source: string): boolean {
  return /^(https?:\/\/|git:|git@|ssh:\/\/)/.test(source);
}

// True when the package is registered as a local dev checkout (a path, not a
// URL). Those installs are managed by the developer building from source, so the
// bootstrap must not (re)install the pinned GitHub package on top of them.
function hasLocalChronosCheckout(): boolean {
  return piPackageSources().some((s) => isChronosEntry(s) && !isGitUrlEntry(s));
}

// True when pi + the pi-package are present AND already at the ref this extension
// wants — i.e. ensureBootstrap would early-return true without running any
// install/reinstall task. Auto-start is gated on this (not just deps-present) so
// an unsolicited launch never fires a (re)install terminal — e.g. after an
// extension upgrade leaves the stored ref stale, or an install previously failed.
// A stale / un-set-up workspace falls back to the manual command / walkthrough.
function bootstrapReconciled(context: vscode.ExtensionContext): boolean {
  if (!hasPi() || !hasChronosPiPackage()) return false;
  const cfg = vscode.workspace.getConfiguration("chronos");
  const sourceOverride = cfg.get<string>("piPackageSource")?.trim();
  if (!sourceOverride && hasLocalChronosCheckout()) return true;
  const wantedId = sourceOverride || `v${context.extension.packageJSON.version}`;
  return context.globalState.get("chronos.piPackageRef") === wantedId;
}

// Serialises chronos.startSession so a concurrent invocation (auto-start racing a
// walkthrough/manual click) joins the in-flight start instead of constructing a
// second panel + pi subprocess before ChronosPanel.current is assigned.
let startingSession = false;

// Run setup commands in order, resolving with the first non-zero exit code (0 if
// all succeed). Each command is its own task rather than one `a && b` shell line:
// Windows PowerShell 5.1 — still the default shell on many Windows machines —
// rejects `&&` as a statement separator, and no separator works across
// cmd/PowerShell/POSIX shells. Tasks share a name so they reuse one terminal panel.
function runSetupTask(name: string, commands: string[]): Promise<number> {
  return commands.reduce<Promise<number>>(
    (prev, command, i) =>
      prev.then((code) => (code === 0 ? runShellTask(name, command, i === 0) : code)),
    Promise.resolve(0),
  );
}

// A task runs in the user's shell — login-shell PATH, sudo prompts, visible output,
// just like the integrated terminal — but unlike terminal.sendText it reports
// completion, so the caller can await the install and continue automatically
// instead of asking the user to re-run the command. Never rejects: a failure to
// launch resolves to -1 so callers handle it uniformly via the exit code.
function runShellTask(name: string, command: string, clear: boolean): Promise<number> {
  const task = new vscode.Task(
    { type: "chronos-setup" },
    vscode.TaskScope.Workspace,
    name,
    "Chronos",
    new vscode.ShellExecution(command),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    // Only the first step clears, so a multi-step run reads as one log.
    clear,
    focus: false,
    echo: true,
  };
  return new Promise<number>((resolve) => {
    // Subscribe before executing so a fast-failing task can't end before we listen.
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task === task) {
        sub.dispose();
        resolve(e.exitCode ?? -1);
      }
    });
    vscode.tasks.executeTask(task).then(undefined, () => {
      sub.dispose();
      resolve(-1);
    });
  });
}

async function ensureBootstrap(context: vscode.ExtensionContext): Promise<boolean> {
  // Integration tests drive a mock pi binary and have no real pi/package to
  // install — skip the (modal, test-refused) bootstrap prompts.
  if (process.env.CHRONOS_SKIP_BOOTSTRAP === "1") return true;

  // Pin the pi-package to the git tag matching this extension version, so the
  // agent tracks the extension: installing or upgrading the extension (re)installs
  // the matching pi-package. Requires a `v<version>` tag on the repo per release.
  //
  // Dev overrides: chronos.piPackageSource installs the pi-package from a local
  // path or a branch (".../chronos/chronos" or "<url>@my-branch") instead of the
  // pinned release; chronos.piNpmPackage swaps the npm package for the pi CLI
  // itself (e.g. a fork). Both fall back to the release behaviour when unset.
  const cfg = vscode.workspace.getConfiguration("chronos");
  const sourceOverride = cfg.get<string>("piPackageSource")?.trim();
  const npmPackage = cfg.get<string>("piNpmPackage")?.trim() || PI_NPM_PACKAGE;
  const wantedRef = `v${context.extension.packageJSON.version}`;
  // Pin with `@<ref>`, NOT `#<ref>`: pi's URL parser mishandles the `#` fragment
  // form and passes it straight to `git clone` (which fails). The `@` form is
  // split into a clean repo URL + a checkout ref.
  const wantedSource = sourceOverride || `${CHRONOS_PI_PACKAGE}@${wantedRef}`;
  // Identity stored to decide "already up to date": the version ref for the release
  // default, or the override string itself so changing the override reinstalls.
  const wantedId = sourceOverride || wantedRef;
  const refKey = "chronos.piPackageRef";

  if (!hasPi()) {
    const choice = await vscode.window.showWarningMessage(
      "Chronos requires pi (an AI agent CLI) and the Chronos pi-package. Install them now?",
      { modal: true },
      "Install",
    );
    if (choice !== "Install") return false;
    const code = await runSetupTask(
      "Install pi + Chronos agent",
      [`npm install -g ${npmPackage}`, `pi install ${wantedSource}`],
    );
    if (code !== 0 || !hasPi()) {
      vscode.window.showErrorMessage(
        `Chronos setup failed (exit code ${code}). Check the "Install pi + Chronos agent" task terminal, then run "Chronos: Install Dependencies" to retry.`,
      );
      return false;
    }
    await context.globalState.update(refKey, wantedId);
    return true;
  }

  // A local dev checkout (path entry) is managed by the developer building from
  // source — never reinstall the pinned release on top of it. An explicit
  // chronos.piPackageSource override opts back in (the dev is asking to install
  // that source), so it skips this guard and reconciles the registration below.
  if (!sourceOverride && hasLocalChronosCheckout()) return true;

  // Up to date only when the package is actually registered AND at the ref this
  // extension wants. Gating on actual presence (not just the stored ref) lets a
  // failed prior install recover on the next launch instead of being skipped.
  const installed = hasChronosPiPackage();
  if (installed && context.globalState.get(refKey) === wantedId) return true;

  // (Re)install at the wanted ref. Covers a fresh install, an extension upgrade
  // (stored ref differs), and migrating off the legacy history-agent URL (removed
  // first, since pi keys identity on the URL and would otherwise keep both as
  // distinct packages). Prompt only when nothing is installed yet; else refresh
  // without prompting (the task terminal still shows progress). The old URL
  // redirects to the same repo, so the remove+install is a safe no-op clone if the
  // migration is all that changed.
  if (!installed) {
    const choice = await vscode.window.showInformationMessage(
      "Install the Chronos pi-package? (one-time registration with pi)",
      { modal: true },
      "Install",
      "Already installed",
    );
    if (choice === "Already installed") {
      await context.globalState.update(refKey, wantedId);
      return true;
    }
    if (choice !== "Install") return false;
  }
  // Remove conflicting registrations before installing, so pi never loads two
  // chronos packages. Default: just migrate off the legacy history-agent URL. With
  // an override: drop every other chronos entry (local path, release URL, legacy)
  // so the registration ends up matching the override exactly.
  const removals = sourceOverride
    ? piPackageSources().filter((s) => isChronosEntry(s) && s !== sourceOverride)
    : hasLegacyPiPackage()
      ? [LEGACY_PI_PACKAGE]
      : [];
  const code = await runSetupTask(`Set up Chronos pi-package (${wantedId})`, [
    ...removals.map((r) => `pi remove ${r}`),
    `pi install ${wantedSource}`,
  ]);
  if (code !== 0 || !hasChronosPiPackage()) {
    vscode.window.showErrorMessage(
      `Chronos pi-package setup failed (exit code ${code}). Check the task terminal, then run "Chronos: Install Dependencies" to retry.`,
    );
    return false;
  }
  await context.globalState.update(refKey, wantedId);
  return true;
}

// Walkthrough step checkmarks are driven by context keys: each `completionEvent`
// in package.json watches one of these. Recompute them from real state (pi/pkg
// presence, workspace scaffold, a stored provider key) so steps already satisfied
// show as done. Cheap; called on activation and after the setup/init/login commands.
function refreshWalkthroughContext(workspaceFolder: string | undefined): void {
  const depsInstalled = hasPi() && hasChronosPiPackage();
  const workspaceInitialized = !!workspaceFolder && existsSync(join(workspaceFolder, ".chronos"));
  const providerConnected = !!workspaceFolder && hasProviderKey(join(workspaceFolder, ".chronos", ".env"));
  void vscode.commands.executeCommand("setContext", "chronos.dependenciesInstalled", depsInstalled);
  void vscode.commands.executeCommand("setContext", "chronos.workspaceInitialized", workspaceInitialized);
  void vscode.commands.executeCommand("setContext", "chronos.providerConnected", providerConnected);
}

// True when .chronos/.env holds at least one non-empty *_API_KEY / *_API_TOKEN —
// the signal that a provider has been connected (comment lines don't parse as vars).
function hasProviderKey(envPath: string): boolean {
  return Object.entries(readEnvFile(envPath)).some(([k, v]) => /_API_(KEY|TOKEN)$/.test(k) && v.length > 0);
}

function readEnvFile(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    // Accept mixed-case names so any var the login flow can write (the "Other
    // provider…" path allows [A-Za-z_]…) round-trips on the next session.
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

function writeIfMissing(filePath: string, content: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content, "utf-8");
  }
}

async function initWorkspace(folder: string): Promise<boolean> {
  // Create directory structure
  for (const dir of ["sources", "memory", "skills", "sessions", "collections", ".chronos", ".pi"]) {
    mkdirSync(join(folder, dir), { recursive: true });
  }

  // Bridge the workspace-level skills/ dir into pi's resource discovery
  // (pi auto-discovers from .pi/skills only; we point it at ../skills instead).
  writeIfMissing(
    join(folder, ".pi", "settings.json"),
    JSON.stringify({ skills: ["../skills"] }, null, 2) + "\n",
  );

  // Memory files
  writeIfMissing(join(folder, "memory", "MEMORY.MD"), "");

  // Seed the long-horizon "trace an entity" skill (non-destructive — edits are kept).
  mkdirSync(join(folder, "skills", "trace-entity"), { recursive: true });
  writeIfMissing(join(folder, "skills", "trace-entity", "SKILL.md"), TRACE_ENTITY_SKILL);

  // README
  writeIfMissing(join(folder, "README.md"),
`# Chronos Workspace

This folder is a Chronos workspace for digitizing historical documents.

## Structure

\`\`\`
sources/          Place your source directories here (each with a png/ subfolder)
data/             Per-source extraction results and outputs
collections/      Named collection manifests (<name>.json grouping member sources)
memory/           Agent memory files (MEMORY.MD, per-source notes)
skills/           Skill definitions (markdown task instructions)
sessions/         Agent session logs (auto-generated)
.chronos/.env     Provider API keys (set via "Chronos: Connect AI Provider")
\`\`\`

## Getting Started

1. **Install Chronos**: \`pi install chronos\`

2. **Add a source**: Create a folder inside \`sources/\` with a \`png/\` subfolder containing page images.
   Pages should be named \`page_NNNN.png\` (4-digit zero-padded, 1-indexed).

   Example:
   \`\`\`
   sources/Frankfurt_1864/png/page_0001.png
   sources/Frankfurt_1864/png/page_0002.png
   ...
   \`\`\`

   Or use **"Chronos: Import Sources"** to import PDFs and images automatically.

3. **Start a session**: Open the Command Palette (\`Ctrl+Shift+P\`) and run
   **"Chronos: Start Agent Session"**. This opens the Chronos panel (page viewer
   + chat) in the workspace.

4. **Select a source**: Pick a source from the header dropdown, or type
   \`/select-source\` in the chat. The page viewer opens automatically.

5. **Browse pages**: Run **"Chronos: Show Page"** to jump the viewer to a
   specific page.

## AI provider

Chronos works with any provider \`pi\` supports (Anthropic, Google, OpenAI, …).
Click **Log in** in the Chronos panel header — or run **"Chronos: Connect AI
Provider"** — to store an API key in \`.chronos/.env\`. You can also edit that
file directly (e.g. \`ANTHROPIC_API_KEY=...\`).
`
  );

  // Auth is provider-agnostic and set up from the panel ("Log in" button, or the
  // "Chronos: Connect AI Provider" command), which writes a <PROVIDER>_API_KEY
  // into .chronos/.env. Just ensure the file exists so there's somewhere to write.
  const chronosDir = join(folder, ".chronos");
  const envPath = join(chronosDir, ".env");
  if (!existsSync(envPath)) {
    mkdirSync(chronosDir, { recursive: true });
    writeFileSync(envPath, "# Provider API keys, e.g. ANTHROPIC_API_KEY=... or GEMINI_API_KEY=...\n", "utf-8");
  }

  return true;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"]);
const SUPPORTED_EXTS = new Set([...IMAGE_EXTS, ".pdf", ".txt"]);

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

interface ImportResult {
  imported: number;
  skipped: string[];
  errors: string[];
}

// The bundled mupdf is a 32-bit (wasm32) WASM build: its file offsets are capped at 2^31,
// so it cannot open PDFs >= 2 GiB (their xref/objects live past that offset). Such files are
// first split into <2 GiB parts with pdf-lib (pure JS, 64-bit offsets) — see splitLargePdf.
const MAX_WASM_PDF_BYTES = 2 ** 31;

// Render every page of a (<2 GiB) PDF to PNGs via a pool of worker threads. pageOffset is
// added to each page index for naming, so split parts produce globally-numbered pages.
async function renderPdfFile(
  workerScript: string,
  filePath: string,
  pngDir: string,
  totalPages: number,
  pageOffset: number,
  onProgress: (completedInFile: number) => void,
): Promise<void> {
  const POOL_SIZE = 4;
  const BATCH_SIZE = 50;
  let completed = 0;

  const batches: { start: number; end: number }[] = [];
  for (let i = 0; i < totalPages; i += BATCH_SIZE) {
    batches.push({ start: i, end: Math.min(i + BATCH_SIZE, totalPages) });
  }

  let batchIdx = 0;
  const runNext = (): Promise<void> => {
    const idx = batchIdx++;
    if (idx >= batches.length) return Promise.resolve();
    const { start, end } = batches[idx];
    return new Promise<void>((resolve, reject) => {
      const w = new Worker(workerScript, {
        workerData: { filePath, pngDir, startPage: start, endPage: end, pageOffset, dpi: 200 },
      });
      let workerError = "";
      w.on("message", (msg: { type: string; page?: number; message?: string }) => {
        if (msg.type === "progress") {
          completed++;
          onProgress(completed);
        } else if (msg.type === "error") {
          workerError = msg.message ?? "unknown error";
        }
      });
      w.on("error", reject);
      w.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(workerError || `Worker exited with code ${code}`));
        } else {
          resolve();
        }
      });
    }).then(() => runNext());
  };

  await Promise.all(Array.from({ length: Math.min(POOL_SIZE, batches.length) }, () => runNext()));
}

// Split a >= 2 GiB PDF into <2 GiB part files (in outDir) using a pdf-lib worker thread, so
// the heavy parse runs off the extension's event loop and in its own heap. Returns the parts
// (with their global page offsets) in reading order.
function splitLargePdf(
  filePath: string,
  outDir: string,
  onProgress: (message: string) => void,
): Promise<{ chunks: { path: string; pageOffset: number; pageCount: number }[]; totalPages: number }> {
  const workerScript = join(__dirname, "pdf-split-worker.js");
  return new Promise((resolve, reject) => {
    const w = new Worker(workerScript, {
      workerData: { filePath, outDir, targetChunkBytes: 2 ** 30 }, // ~1 GiB parts (safely < 2 GiB)
      resourceLimits: { maxOldGenerationSizeMb: 8192 }, // headroom for pdf-lib on multi-GiB files
    });
    let result: { chunks: { path: string; pageOffset: number; pageCount: number }[]; totalPages: number } | null = null;
    let workerError = "";
    w.on("message", (msg: { type: string; message?: string; chunks?: any[]; totalPages?: number }) => {
      if (msg.type === "progress") {
        onProgress(msg.message ?? "");
      } else if (msg.type === "done") {
        result = { chunks: msg.chunks ?? [], totalPages: msg.totalPages ?? 0 };
      } else if (msg.type === "error") {
        workerError = msg.message ?? "unknown error";
      }
    });
    w.on("error", reject);
    w.on("exit", (code) => {
      if (code !== 0 || !result) {
        reject(new Error(workerError || `Split worker exited with code ${code}`));
      } else {
        resolve(result);
      }
    });
  });
}

async function importFile(
  filePath: string,
  sourcesDir: string,
  progress: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const ext = extname(filePath).toLowerCase();
  const sourceName = stripExt(basename(filePath));
  const sourceDir = join(sourcesDir, sourceName);
  const marker = readImportMarker(sourceDir);

  if (!SUPPORTED_EXTS.has(ext)) {
    return { ok: false, error: `Unsupported file type: ${ext}` };
  }
  // A finished png-based source has png/. If a marker also lingers (crash between the
  // png.partial->png rename and clearing the marker) the import is in fact done — drop the
  // stray marker and treat it as complete.
  if (existsSync(join(sourceDir, "png"))) {
    if (marker) clearImportMarker(sourceDir);
    return { ok: false, error: `Source "${sourceName}" already exists, skipping` };
  }
  // No png/ yet: a leftover marker means an interrupted import to resume; otherwise any other
  // existing dir (e.g. a .txt source, or something the user placed) must not be clobbered.
  const resuming = marker !== null;
  if (!resuming && existsSync(sourceDir)) {
    return { ok: false, error: `Source "${sourceName}" already exists, skipping` };
  }

  mkdirSync(sourceDir, { recursive: true });
  // Record (or keep) the in-progress marker; cleared only once the import completes.
  if (!resuming) {
    writeImportMarker(sourceDir, { source: sourceName, sourceFile: filePath, dpi: 200, startedAt: new Date().toISOString() });
  }

  try {
    if (ext === ".pdf") {
      const pngPartial = partialPngDir(sourceDir);
      mkdirSync(pngPartial, { recursive: true });
      const workerScript = join(__dirname, "pdf-worker.js");
      progress(`Converting PDF: ${sourceName}${resuming ? " (resuming)" : ""}...`);
      const mupdf = await import("mupdf");

      if (statSync(filePath).size >= MAX_WASM_PDF_BYTES) {
        // mupdf's WASM build can't open files >= 2 GiB (32-bit offsets). Split into
        // <2 GiB parts with pdf-lib (pure JS, 64-bit offsets), then render each part with
        // the normal mupdf worker pool, numbering pages globally via each part's offset.
        const gib = (statSync(filePath).size / 2 ** 30).toFixed(1);
        // Already fully rendered but interrupted before finalize? Clean any leftover parts
        // and finalize.
        if (marker?.expectedPages && countPartialPages(sourceDir) >= marker.expectedPages) {
          rmSync(join(sourceDir, ".parts"), { recursive: true, force: true });
          finalizePartialImport(sourceDir);
          return { ok: true };
        }
        progress(`Converting PDF: ${sourceName} (${gib} GiB — splitting into parts)...`);
        const splitDir = join(sourceDir, ".parts");
        mkdirSync(splitDir, { recursive: true });
        try {
          const { chunks, totalPages } = await splitLargePdf(filePath, splitDir, (msg) =>
            progress(`Converting PDF: ${sourceName} (${msg})...`),
          );
          updateImportMarker(sourceDir, { expectedPages: totalPages });
          let done = 0;
          for (const chunk of chunks) {
            await renderPdfFile(workerScript, chunk.path, pngPartial, chunk.pageCount, chunk.pageOffset, (completed) =>
              progress(`Converting PDF: ${sourceName} (${done + completed}/${totalPages} pages)...`),
            );
            done += chunk.pageCount;
            rmSync(chunk.path, { force: true }); // free the part's disk before rendering the next
          }
        } finally {
          rmSync(splitDir, { recursive: true, force: true });
        }
        finalizePartialImport(sourceDir);
        return { ok: true };
      }

      // < 2 GiB: open through a seekable file stream (see withPdfDocument) so mupdf reads
      // pages on demand instead of slurping the file into memory.
      const totalPages = withPdfDocument(mupdf, filePath, (doc) => doc.countPages());
      updateImportMarker(sourceDir, { expectedPages: totalPages });

      if (totalPages <= 1) {
        // Render directly — no worker overhead
        const dpi = 200;
        const scale = dpi / 72;
        withPdfDocument(mupdf, filePath, (doc) => {
          for (let i = 0; i < totalPages; i++) {
            const target = join(pngPartial, `page_${String(i + 1).padStart(4, "0")}.png`);
            if (existsSync(target)) continue;
            const page = doc.loadPage(i);
            const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
            writeFileSync(target + ".tmp", pixmap.asPNG());
            renameSync(target + ".tmp", target);
            pixmap.destroy();
            page.destroy();
          }
        });
      } else {
        progress(`Converting PDF: ${sourceName} (${totalPages} pages)...`);
        await renderPdfFile(workerScript, filePath, pngPartial, totalPages, 0, (completed) =>
          progress(`Converting PDF: ${sourceName} (${completed}/${totalPages} pages)...`),
        );
      }

      finalizePartialImport(sourceDir);
      return { ok: true };
    }

    if (IMAGE_EXTS.has(ext)) {
      const pngPartial = partialPngDir(sourceDir);
      mkdirSync(pngPartial, { recursive: true });
      progress(`Importing image: ${sourceName}`);
      updateImportMarker(sourceDir, { expectedPages: 1 });
      copyFileSync(filePath, join(pngPartial, `page_0001${ext}`));
      finalizePartialImport(sourceDir);
      return { ok: true };
    }

    // .txt: the file itself is the source content (no png/); marker cleared on success.
    progress(`Importing text: ${sourceName}`);
    copyFileSync(filePath, join(sourceDir, basename(filePath)));
    clearImportMarker(sourceDir);
    return { ok: true };
  } catch (err) {
    // Keep the marker + png.partial in place so the import can be resumed or discarded;
    // record the failure so the recovery prompt can explain it.
    updateImportMarker(sourceDir, { lastError: (err as Error).message });
    return { ok: false, error: `Import failed for "${sourceName}": ${(err as Error).message}` };
  }
}

// List the importable files directly inside a folder (non-recursive, skips dotfiles).
function collectSupportedFiles(folderPath: string): string[] {
  return readdirSync(folderPath)
    .filter((f) => SUPPORTED_EXTS.has(extname(f).toLowerCase()) && !f.startsWith("."))
    .map((f) => join(folderPath, f))
    .filter((f) => statSync(f).isFile());
}

async function importFiles(
  files: string[],
  sourcesDir: string,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: [], errors: [] };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Chronos: Importing sources",
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = basename(file);
        progress.report({
          message: `(${i + 1}/${files.length}) ${name}`,
          increment: (100 / files.length),
        });

        const res = await importFile(
          file,
          sourcesDir,
          (msg) => progress.report({ message: `(${i + 1}/${files.length}) ${msg}` }),
        );

        if (res.ok) {
          result.imported++;
        } else if (res.error?.includes("already exists")) {
          result.skipped.push(name);
        } else {
          result.errors.push(res.error ?? `Failed: ${name}`);
        }
      }
    }
  );

  return result;
}

// Re-run interrupted imports from their recorded source files. importFile resumes (skipping
// pages already rendered into png.partial) and finalizes them.
async function resumeIncompleteImports(incompletes: IncompleteImport[], sourcesDir: string): Promise<void> {
  const result: ImportResult = { imported: 0, skipped: [], errors: [] };
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Chronos: Resuming interrupted imports", cancellable: false },
    async (progress) => {
      for (let i = 0; i < incompletes.length; i++) {
        const inc = incompletes[i];
        if (!existsSync(inc.marker.sourceFile)) {
          result.errors.push(`${inc.name}: original file is gone (${inc.marker.sourceFile}) — discard it and re-import`);
          continue;
        }
        progress.report({ message: `(${i + 1}/${incompletes.length}) ${inc.name}` });
        const res = await importFile(inc.marker.sourceFile, sourcesDir, (msg) =>
          progress.report({ message: `(${i + 1}/${incompletes.length}) ${msg}` }),
        );
        if (res.ok) result.imported++;
        else result.errors.push(res.error ?? `Failed: ${inc.name}`);
      }
    },
  );
  ChronosPanel.active?.refreshSources();
  const summary = [result.imported ? `${result.imported} completed` : "", result.errors.length ? `${result.errors.length} failed` : ""].filter(Boolean).join(", ");
  if (result.errors.length) {
    vscode.window.showWarningMessage(`Chronos: Resume — ${summary || "nothing to do"}. ${result.errors.join("; ")}`);
  } else {
    vscode.window.showInformationMessage(`Chronos: Resume — ${summary || "nothing to do"}.`);
  }
}

// If any imports were interrupted (markers left behind), tell the user and offer to resume or
// discard. Called on activation and before the import command so failures are never silent.
async function promptRecoverIncompleteImports(workspaceFolder: string): Promise<void> {
  const sourcesDir = join(workspaceFolder, "sources");
  const incompletes = findIncompleteImports(sourcesDir);
  if (incompletes.length === 0) return;

  const detail = incompletes
    .map((i) => {
      const pages = i.marker.expectedPages ? `${i.renderedPages}/${i.marker.expectedPages}` : `${i.renderedPages}`;
      return `${i.name} (${pages} pages${i.marker.lastError ? `; ${i.marker.lastError}` : ""})`;
    })
    .join(", ");
  const choice = await vscode.window.showWarningMessage(
    `Chronos: ${incompletes.length} source import(s) were interrupted and are incomplete: ${detail}. Resume now, or discard the partial data?`,
    "Resume",
    "Discard",
    "Later",
  );
  if (choice === "Resume") {
    await resumeIncompleteImports(incompletes, sourcesDir);
  } else if (choice === "Discard") {
    for (const i of incompletes) rmSync(i.sourceDir, { recursive: true, force: true });
    vscode.window.showInformationMessage(`Chronos: discarded ${incompletes.length} incomplete import(s).`);
  }
}

export function activate(context: vscode.ExtensionContext): {
  getChronosStatus: () => ReturnType<typeof ChronosPanel.getStatus>;
  chronosTest: { invoke: (action: string, arg?: string) => void; dump: () => Promise<unknown> | undefined };
} {
  // The open VS Code folder IS the workspace (data dir)
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const httpServer = new HttpServer();

  // The chat panel owns the page viewer. The agent pushes viewer events
  // (show_page / page_list / show_text) here over HTTP; we bridge them to the
  // webview. Dropped if no panel is open (e.g. during teardown).
  httpServer.onMessage((msg) => {
    try {
      ChronosPanel.active?.handleHttpMessage(msg);
    } catch (err) {
      console.error(`[chronos-ext] Error handling ${msg.type}:`, err);
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("chronos.startSession", async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage(
          "Chronos: Open a workspace folder first (this becomes your workspace directory)."
        );
        return;
      }

      // A start is already in flight (e.g. auto-start on activation); it will
      // create or reveal the panel, so don't run a second bootstrap + createOrShow.
      if (startingSession) return;
      startingSession = true;
      try {
        // ensureBootstrap runs any install as an awaited task and returns true only
        // once deps are present, so a false result means the user declined or the
        // install failed (it already surfaced the error) — just stop.
        if (!(await ensureBootstrap(context))) return;
        refreshWalkthroughContext(workspaceFolder);

        const workspaceEnv = readEnvFile(join(workspaceFolder, ".chronos", ".env"));

        // Bind the HTTP server (lazily) so the port is assigned before the agent starts.
        await httpServer.start();

        // User-tunable agent limits (contributed settings) are forwarded to the
        // pi-package as env vars; it parses them defensively (see utils/env-config.ts).
        const chronosCfg = vscode.workspace.getConfiguration("chronos");
        const agentEnv = {
          CHRONOS_HTTP_PORT: String(httpServer.port),
          CHRONOS_MAX_EXPERT_TOOL_CALLS: String(chronosCfg.get<number>("maxExpertToolCalls", 100)),
          CHRONOS_MAX_CONCURRENCY: String(chronosCfg.get<number>("maxConcurrency", 20)),
          CHRONOS_MAX_IMAGE_DIMENSION: String(chronosCfg.get<number>("maxImageDimension", 2576)),
          CHRONOS_EXPERT_RETRIES: String(chronosCfg.get<number>("expertRetries", 3)),
          CHRONOS_EXPERT_TIMEOUT: String(chronosCfg.get<number>("expertRequestTimeout", 300)),
          // pi >= 0.7x dropped the session_directory extension hook; this env var
          // keeps session transcripts inside the workspace in both UI modes.
          PI_CODING_AGENT_SESSION_DIR: join(workspaceFolder, "sessions"),
          ...workspaceEnv,
        };

        // pi runs as an RPC subprocess behind the combined viewer + chat panel.
        await ChronosPanel.createOrShow(context.extensionUri, workspaceFolder, agentEnv);
      } finally {
        startingSession = false;
      }
    }),

    vscode.commands.registerCommand("chronos.showPage", async () => {
      if (!workspaceFolder) return;

      const sourcesDir = join(workspaceFolder, "sources");
      const sources = existsSync(sourcesDir) ? discoverSources(sourcesDir) : [];
      if (sources.length === 0) {
        vscode.window.showWarningMessage("Chronos: No sources found.");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        sources.map((s) => ({ label: s.name, detail: s.path, source: s })),
        { placeHolder: "Select a source" }
      );
      if (!picked) return;

      const pageIdStr = await vscode.window.showInputBox({
        prompt: "Page ID (number)",
        value: "1",
      });
      if (!pageIdStr) return;

      const pageId = parseInt(pageIdStr, 10);
      if (isNaN(pageId)) return;

      const target = ChronosPanel.active;
      if (!target) {
        vscode.window.showWarningMessage("Chronos: Start an agent session first (Chronos: Start Agent Session).");
        return;
      }
      target.showPage(picked.source.path, path.basename(picked.source.path), pageId, null, countPages(picked.source.path));
    }),

    vscode.commands.registerCommand("chronos.importSources", async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage("Chronos: Open a workspace folder first.");
        return;
      }

      const sourcesDir = join(workspaceFolder, "sources");
      if (!existsSync(sourcesDir)) {
        vscode.window.showWarningMessage(
          "Chronos: No sources/ directory. Run \"Chronos: Init Workspace\" first."
        );
        return;
      }

      // Offer to finish/clear any previously-interrupted imports before starting new ones.
      await promptRecoverIncompleteImports(workspaceFolder);

      const mode = await vscode.window.showQuickPick(
        [
          {
            label: "$(file) Select file(s)…",
            detail: "Import one or more PDFs, images, or text files",
            action: "files" as const,
          },
          {
            label: "$(folder) Select a folder…",
            detail: "Import every supported file in a folder",
            action: "folder" as const,
          },
        ],
        { placeHolder: "Import sources from…" },
      );
      if (!mode) return;

      let files: string[];
      if (mode.action === "files") {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: "Import Sources",
          title: "Select PDFs, images, or text files to import",
          filters: {
            "Sources (PDF, images, text)": ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "txt"],
            "All files": ["*"],
          },
        });
        if (!picked || picked.length === 0) return;
        files = picked.map((u) => u.fsPath);
      } else {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "Import Folder",
          title: "Select a folder containing PDFs, images, or text files",
        });
        if (!picked || picked.length === 0) return;
        files = collectSupportedFiles(picked[0].fsPath);
        if (files.length === 0) {
          vscode.window.showWarningMessage(
            "Chronos: No supported files found in that folder (pdf, txt, png, jpg, jpeg, tif, tiff, bmp).",
          );
          return;
        }
      }

      const importResult = await importFiles(files, sourcesDir);

      // Refresh the source picker in an open panel so newly imported sources
      // appear immediately (the agent's /select-source re-scans live already).
      if (importResult.imported > 0) {
        ChronosPanel.active?.refreshSources();
      }

      const parts: string[] = [];
      if (importResult.imported > 0) parts.push(`${importResult.imported} imported`);
      if (importResult.skipped.length > 0) parts.push(`${importResult.skipped.length} skipped (already exist)`);
      if (importResult.errors.length > 0) parts.push(`${importResult.errors.length} errors`);

      const summary = parts.join(", ");
      if (importResult.errors.length > 0) {
        vscode.window.showWarningMessage(`Chronos Import: ${summary}. Errors: ${importResult.errors.join("; ")}`);
      } else {
        vscode.window.showInformationMessage(`Chronos Import: ${summary}.`);
      }
    }),

    // Machine-level setup: install the pi CLI + register the Chronos pi-package.
    // Independent of any workspace; safe to re-run to repair or upgrade. Kept
    // separate from `chronos.init` (which only scaffolds a workspace folder) so the
    // two scopes don't entangle. Session start still lazily ensures deps too.
    vscode.commands.registerCommand("chronos.setup", async () => {
      const ready = await ensureBootstrap(context);
      refreshWalkthroughContext(workspaceFolder);
      // On success, confirm. On failure/decline ensureBootstrap has already surfaced
      // the error (or the user opted out) — nothing more to do.
      if (ready) {
        vscode.window.showInformationMessage("Chronos: dependencies are installed and ready.");
      }
    }),

    vscode.commands.registerCommand("chronos.init", async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage(
          "Chronos: Open a folder first, then run Init to set it up as a Chronos workspace."
        );
        return;
      }

      const success = await initWorkspace(workspaceFolder);
      if (success) {
        refreshWalkthroughContext(workspaceFolder);
        vscode.window.showInformationMessage(
          "Chronos workspace initialized. Add source directories to sources/ to get started."
        );
      }
    }),

    vscode.commands.registerCommand("chronos.login", async () => {
      const panel = ChronosPanel.active;
      if (!panel) {
        vscode.window.showWarningMessage(
          "Chronos: Start an agent session first (Chronos: Start Agent Session), then connect a provider."
        );
        return;
      }
      await panel.promptLogin();
      refreshWalkthroughContext(workspaceFolder);
    }),

    vscode.commands.registerCommand("chronos.windowSetup", async () => {
      // 1. Close all editor tabs
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // 2. Move entire panel to the right sidebar
      await vscode.commands.executeCommand("workbench.action.movePanelToSecondarySideBar");
      // 3. Move chat back to the bottom panel
      for (const cmd of [
        "workbench.action.chat.moveToPanel",
        "workbench.action.chat.open",
      ]) {
        try { await vscode.commands.executeCommand(cmd); } catch { /* skip if unavailable */ }
      }
    }),

    { dispose: () => httpServer.dispose() }
  );

  // Reflect current setup state in the Getting Started walkthrough checkmarks.
  refreshWalkthroughContext(workspaceFolder);

  // First run on a machine without pi: open the walkthrough once so setup is
  // discoverable. Gated on missing pi so we never nag users who are already set up,
  // and skipped under the integration test (mock pi, fresh profile) for determinism.
  const WALKTHROUGH_SEEN = "chronos.walkthroughSeen";
  if (process.env.CHRONOS_SKIP_BOOTSTRAP !== "1" && !context.globalState.get(WALKTHROUGH_SEEN) && !hasPi()) {
    void context.globalState.update(WALKTHROUGH_SEEN, true);
    void vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      `${context.extension.id}#chronos.gettingStarted`,
      false,
    );
  }

  // Surface any imports interrupted by a previous crash so they don't fail silently.
  if (workspaceFolder && existsSync(join(workspaceFolder, "sources"))) {
    void promptRecoverIncompleteImports(workspaceFolder);
  }

  // Auto-start the agent session when this folder is a Chronos workspace (it has
  // a .chronos/ dir — the same signal that marks the workspace "initialized").
  // Gated on the bootstrap already being reconciled (deps present AND at the
  // wanted ref) so an unsolicited launch never triggers an install/reinstall
  // task — an un-set-up or just-upgraded workspace falls back to the manual
  // command / walkthrough. Skipped under the integration test, which starts the
  // session itself. Opt out with chronos.autoStartSession.
  const autoStart = vscode.workspace.getConfiguration("chronos").get<boolean>("autoStartSession", true);
  if (
    process.env.CHRONOS_SKIP_BOOTSTRAP !== "1" &&
    autoStart &&
    workspaceFolder &&
    existsSync(join(workspaceFolder, ".chronos")) &&
    !ChronosPanel.active &&
    bootstrapReconciled(context)
  ) {
    void vscode.commands.executeCommand("chronos.startSession");
  }

  return {
    getChronosStatus: () => ChronosPanel.getStatus(),
    // Test-only seam used by the integration suite to drive the webview.
    chronosTest: {
      invoke: (action, arg) => ChronosPanel.active?.testInvoke(action, arg),
      dump: () => ChronosPanel.active?.testDump(),
    },
  };
}

export function deactivate(): void {
  // Cleanup handled by subscriptions
}
