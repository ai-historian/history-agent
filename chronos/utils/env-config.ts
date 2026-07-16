// User-tunable runtime limits arrive from the VS Code extension as env vars on
// the pi subprocess (see chronos-vscode: package.json settings -> extension.ts
// agentEnv). Parse them defensively: a missing, empty, non-numeric, or
// out-of-range value falls back to the built-in default rather than breaking
// the agent, so a bad setting can never wedge a session.
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
