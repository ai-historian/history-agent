import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from "./rpc-types";

// Thin JSONL client for `pi --mode rpc`. The stock RpcClient in pi-coding-agent
// spawns `node dist/cli.js` and cannot answer extension_ui_request messages
// (the chronos pi-package blocks on ctx.ui.select/confirm), so we speak the
// protocol directly against the user's installed pi binary.

const DEFAULT_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;

export interface PiRpcSessionOptions {
  piBin: string;
  workspaceDir: string;
  env: Record<string, string>;
}

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class PiRpcSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private stdoutBuffer = "";
  private stderrTail = "";
  private stopped = false;

  private eventListeners = new Set<(e: AgentEvent) => void>();
  private uiRequestListeners = new Set<(r: RpcExtensionUIRequest) => void>();
  private exitListeners = new Set<(code: number | null, stderrTail: string) => void>();

  constructor(private readonly options: PiRpcSessionOptions) {}

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async start(): Promise<RpcSessionState> {
    if (this.proc) throw new Error("PiRpcSession already started");
    this.stopped = false;

    // Load the workspace skills/ dir explicitly via --skill. We can't rely on
    // the workspace .pi/settings.json {skills:["../skills"]} bridge here: pi
    // gates project settings behind project-trust, and in headless rpc mode
    // there is no UI to answer the trust prompt (defaultProjectTrust "ask" ->
    // untrusted), so the bridge is silently discarded and workspace skills never
    // reach the slash-command menu. --skill is a CLI resource path, not project
    // settings, so it loads regardless of trust state.
    const args = ["--mode", "rpc"];
    const skillsDir = join(this.options.workspaceDir, "skills");
    if (existsSync(skillsDir)) args.push("--skill", skillsDir);

    this.proc = spawn(this.options.piBin, args, {
      cwd: this.options.workspaceDir,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // pi is an npm bin shim (pi.cmd) on Windows; spawn can't exec it directly
      shell: process.platform === "win32",
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.proc.on("error", (err) => {
      this.stderrTail += `\nspawn error: ${err.message}`;
    });
    this.proc.on("exit", (code) => {
      const tail = this.stderrTail;
      this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`pi exited (code ${code ?? "signal"})`));
      }
      this.pending.clear();
      if (!this.stopped) {
        for (const listener of this.exitListeners) listener(code, tail);
      }
    });

    // Readiness: extension/pi-package loading can be slow — poll get_state
    // until pi answers instead of sleeping a fixed interval.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      if (!this.isRunning) {
        throw new Error(`pi exited during startup. Stderr: ${this.stderrTail.trim()}`);
      }
      try {
        return await this.request<RpcSessionState>({ type: "get_state" }, 2_000);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw new Error(`pi did not become ready: ${lastError?.message ?? "timeout"}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const proc = this.proc;
    if (!proc) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 1_000);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.proc = null;
  }

  // timeoutMs = 0 disables the timeout. Needed for `prompt`: slash commands
  // (e.g. /select-source) only answer after their handler finishes, which can
  // block arbitrarily long on a user-facing extension_ui_request.
  request<T = void>(command: RpcCommand, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.isRunning) return Promise.reject(new Error("pi is not running"));
    const id = `req_${++this.requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`RPC ${command.type} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine({ ...command, id });
    });
  }

  sendUiResponse(response: RpcExtensionUIResponse): void {
    if (this.isRunning) this.writeLine(response);
  }

  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onUiRequest(listener: (r: RpcExtensionUIRequest) => void): () => void {
    this.uiRequestListeners.add(listener);
    return () => this.uiRequestListeners.delete(listener);
  }

  onExit(listener: (code: number | null, stderrTail: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private writeLine(obj: object): void {
    this.proc?.stdin.write(JSON.stringify(obj) + "\n");
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn("[chronos-rpc] Non-JSON line on pi stdout:", line.slice(0, 200));
        continue;
      }
      this.handleMessage(parsed);
    }
  }

  private handleMessage(msg: any): void {
    if (msg.type === "response") {
      const response = msg as RpcResponse;
      const pending = response.id ? this.pending.get(response.id) : undefined;
      if (!pending) return;
      this.pending.delete(response.id!);
      clearTimeout(pending.timer);
      if (response.success) {
        pending.resolve(response.data);
      } else {
        pending.reject(new Error(response.error));
      }
      return;
    }
    if (msg.type === "extension_ui_request") {
      for (const listener of this.uiRequestListeners) listener(msg as RpcExtensionUIRequest);
      return;
    }
    // Everything else is an agent event; unknown types are forwarded as-is so
    // newer pi versions degrade gracefully instead of crashing the panel.
    for (const listener of this.eventListeners) listener(msg as AgentEvent);
  }
}
