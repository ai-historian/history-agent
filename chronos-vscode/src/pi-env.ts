import * as vscode from "vscode";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Single source of truth for locating the `pi` binary. Detection (hasPi) and the
// agent launcher (PiRpcSession) MUST resolve it the same way — otherwise a working
// install that isn't on GUI-launched VS Code's minimal PATH reads as "missing",
// triggering redundant install prompts and a perpetually-unchecked setup step.
export function resolvePiBin(): string {
  const configured = vscode.workspace.getConfiguration("chronos").get<string>("piPath");
  if (configured?.trim()) return configured.trim();
  // GUI-launched VS Code doesn't source shell rc files, so PATH may miss the
  // npm global bin dir. Probe PATH first, then common install locations.
  try {
    execSync(process.platform === "win32" ? "where pi" : "command -v pi", { stdio: "ignore" });
    return "pi";
  } catch {
    const home = homedir();
    const candidates = [
      join(home, ".npm-global", "bin", "pi"),
      join(home, ".local", "bin", "pi"),
      join(home, ".npm", "bin", "pi"),
      "/usr/local/bin/pi",
      "/opt/homebrew/bin/pi",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return "pi"; // let the caller fail with a clear ENOENT
  }
}

// Single source of truth for the pi *agent home* (`~/.pi/agent` by default) —
// where package registration, auth.json, models.json and sessions live. pi
// relocates it via PI_CODING_AGENT_DIR (see its config.js getAgentDir); we
// resolve the same value here AND inject it into the pi subprocess env
// (extension.ts), so the two can never disagree. Precedence: the
// `chronos.piAgentDir` setting (profile-scoped, the robust way to isolate a
// release-testing VS Code profile) > the PI_CODING_AGENT_DIR env var > default.
// Config wins over env because VS Code doesn't reliably propagate a launcher's
// env to an already-running instance, whereas per-profile settings always apply.
// Tilde handling mirrors pi's normalizePath (`~` / `~/` only; `~user` untouched).
export function piAgentDir(): string {
  const setting = vscode.workspace.getConfiguration("chronos").get<string>("piAgentDir")?.trim();
  const configured = setting || process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    if (configured === "~") return homedir();
    if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
      return join(homedir(), configured.slice(2));
    }
    return configured;
  }
  return join(homedir(), ".pi", "agent");
}

// True when pi is actually runnable, resolved exactly the way the agent launches
// it — so "is pi present?" can never disagree with "how do we run pi?".
export function hasPi(): boolean {
  try {
    execSync(`"${resolvePiBin()}" --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
