#!/usr/bin/env node
// Regression canary for the slash-command SKILLS path.
//
// Workspace skills live in <workspace>/skills/<name>/SKILL.md and are bridged to
// pi via the workspace .pi/settings.json {"skills":["../skills"]}. BUT pi gates
// project settings behind project-trust, and in headless `--mode rpc` there is
// no UI to answer the trust prompt (defaultProjectTrust "ask" -> untrusted), so
// that bridge is silently discarded and workspace skills never reach the / menu.
// The extension works around this by spawning pi with `--skill <ws>/skills` (a
// CLI resource path, not project settings -> not trust-gated). This canary
// asserts that contract end-to-end against the real pi binary:
//   1. WITH --skill, a workspace SKILL.md surfaces in get_commands (source:skill)
//   2. WITHOUT --skill (plain rpc), it does NOT — i.e. the bridge alone is not
//      enough in rpc mode, which is exactly why --skill is required.
//
// Usage: node scripts/skill-canary.mjs [path-to-pi]
// Run after upgrading the global pi (alongside rpc-spike.mjs).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const piBin = process.argv[2] ?? "pi";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SKILL = `---
name: range-finder
description: Find the page range covering a given record type.
---

# Range Finder

Use list_pages, then narrow to the matching range.
`;

function makeFixture() {
  const dir = join(tmpdir(), `chronos-skill-canary-${process.pid}`);
  mkdirSync(join(dir, "sources", "TestSource", "png"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "skills", "range-finder"), { recursive: true });
  // The .pi/settings.json bridge as written by `Chronos: Init Workspace` — present
  // but deliberately ineffective in rpc mode (untrusted); proves --skill is what works.
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ skills: ["../skills"] }, null, 2) + "\n");
  writeFileSync(join(dir, "sources", "TestSource", "png", "page_0001.png"), PNG);
  writeFileSync(join(dir, "skills", "range-finder", "SKILL.md"), SKILL);
  return dir;
}

// Returns the list of skill-source command names from a `pi --mode rpc [extra]` session.
function skillCommands(dir, extraArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(piBin, ["--mode", "rpc", ...extraArgs], {
      cwd: dir,
      env: { ...process.env, CHRONOS_HTTP_PORT: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    const handlers = [];
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        for (const h of [...handlers]) h(msg);
      }
    });
    const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
    let reqId = 0;
    const waitFor = (pred, ms) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => {
          handlers.splice(handlers.indexOf(h), 1);
          rej(new Error("timeout"));
        }, ms);
        const h = (m) => {
          if (pred(m)) {
            clearTimeout(t);
            handlers.splice(handlers.indexOf(h), 1);
            res(m);
          }
        };
        handlers.push(h);
      });
    const request = (cmd, ms = 8000) => {
      const id = `req_${++reqId}`;
      const p = waitFor((m) => m.type === "response" && m.id === id, ms);
      send({ ...cmd, id });
      return p;
    };
    (async () => {
      try {
        let ready = false;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && !ready) {
          try {
            const r = await request({ type: "get_state" }, 2000);
            if (r.success) ready = true;
          } catch {
            if (proc.exitCode !== null) throw new Error(`pi exited early (${proc.exitCode}): ${stderr.slice(-400)}`);
          }
        }
        if (!ready) throw new Error(`pi never became ready. stderr: ${stderr.slice(-400)}`);
        const cmds = await request({ type: "get_commands" });
        const skills = (cmds.data?.commands ?? []).filter((c) => c.source === "skill").map((c) => c.name);
        resolve(skills);
      } catch (e) {
        reject(e);
      } finally {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 1000).unref();
      }
    })();
  });
}

let failed = false;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

const fixture = makeFixture();
try {
  const withSkill = await skillCommands(fixture, ["--skill", join(fixture, "skills")]);
  check(
    "workspace skill surfaces with --skill",
    withSkill.includes("skill:range-finder"),
    `skill commands: [${withSkill.join(", ")}]`,
  );

  const plain = await skillCommands(fixture, []);
  check(
    "bridge alone is NOT enough in rpc mode (untrusted)",
    !plain.includes("skill:range-finder"),
    `skill commands: [${plain.join(", ")}]`,
  );

  console.log(failed ? "\nSKILL CANARY FAILED" : "\nSKILL CANARY OK");
} catch (err) {
  console.error("SKILL CANARY ERROR:", err.message);
  failed = true;
} finally {
  rmSync(fixture, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
