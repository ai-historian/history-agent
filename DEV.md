# Development setup

How to work on Chronos **and** test the released/marketplace build without ever
uninstalling `pi` or the pi-package. The two modes are isolated, so they coexist.

## Why the two modes used to fight

Everything Chronos-related lives in one global slot per axis, so switching modes
meant mutating shared state (hence the uninstall/reinstall churn):

| Axis | Where it lives |
|------|----------------|
| `pi` binary | `~/.npm-global/bin/pi` (one global npm install) |
| agent home: package registration, `auth.json`, `models.json`, sessions | `~/.pi/agent/` |
| VS Code extension | the editor's one extension slot |

The fix isolates each axis so **local dev** and **release testing** never touch
each other's state.

## Mode 1 — local development (default)

Runs your working copy of both the extension and the agent.

**One-time:** register the agent pi-package as a local checkout. It's already set
if `~/.pi/agent/settings.json` `packages` contains a path ending in `/chronos`:

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["/abs/path/to/chronos/chronos"] }
```

The extension treats a local-checkout registration as sacred — its bootstrap
never reinstalls the pinned release on top of it (`extension.ts` →
`hasLocalChronosCheckout`). So this survives extension upgrades.

**Run the extension from source** (never install a .vsix for dev): open
`chronos-vscode/` in VS Code and press **F5** ("Run Extension" — see
`.vscode/launch.json`). This launches an Extension Development Host running your
built `out/`.

**Iterate:**

```bash
# agent (chronos/) — pi loads from dist/, so you MUST build; then restart the session
cd chronos && npm run build

# extension + webview (chronos-vscode/) — rebuild, then reload the dev-host window
cd chronos-vscode && npm run watch      # or: npm run build
```

- Agent changes: `npm run build`, then **restart the pi session** (sessions
  snapshot the agent at startup). Prompts/skills are read live — no build needed.
- Extension/webview changes: rebuild, then **Reload Window** in the dev host.

Test the agent alone (no extension) in a terminal from a workspace: just `pi`.

## Mode 2 — testing the released / marketplace build

Runs the packaged `.vsix` and the GitHub-pinned agent against an **isolated agent
home**, so your dev registration in `~/.pi/agent` is untouched.

**Set up a dedicated VS Code profile** (profiles isolate the installed extension
*and* settings):

```bash
# build + package the extension (or grab the marketplace .vsix)
cd chronos-vscode && npm run package        # -> chronos-<version>.vsix

# create the profile and install the .vsix into it
code --profile chronos-release --install-extension chronos-vscode/chronos-*.vsix
```

**Point that profile at an isolated agent home.** In the `chronos-release`
profile's user settings (`Preferences: Open User Settings (JSON)` while in that
profile):

```jsonc
{ "chronos.piAgentDir": "~/.pi-release/agent" }
```

That's the whole trick. The extension both *reads* package registration / auth /
sessions from that dir and *passes it to the pi subprocess* as
`PI_CODING_AGENT_DIR`, so the two always agree. On first launch there, the
bootstrap sees no Chronos package in the isolated home and installs the release
pinned to the extension version (`v<version>` tag) — leaving `~/.pi/agent` alone.

A setting (not an env var) is used because VS Code doesn't reliably propagate a
launcher's environment to an already-running instance, whereas per-profile
settings always apply.

### Terminal-only release testing

To exercise the *released agent* from a terminal without the extension, use the
wrapper — it runs the global `pi` against the same isolated home:

```bash
dev/pi-release install https://github.com/ai-historian/chronos@v0.2.2   # one-time
dev/pi-release                                                          # run a session
```

Override the location with `PI_RELEASE_AGENT_DIR`.

## Other dev overrides (extension settings)

Machine-scoped, so they don't travel with a committed workspace. Set per-profile.

| Setting | Purpose |
|---------|---------|
| `chronos.piAgentDir` | Relocate the agent home (isolation — above). |
| `chronos.piPath` | Use a specific `pi` binary (e.g. a dev build / fork). |
| `chronos.piPackageSource` | Install the agent pkg from a local path or `<url>@branch` instead of the pinned release. |
| `chronos.piNpmPackage` | Swap the npm package for the `pi` CLI itself (e.g. a fork or pinned version). |

## Which mode am I in?

```bash
# dev home
cat ~/.pi/agent/settings.json | grep -A3 packages
# release home
cat ~/.pi-release/agent/settings.json | grep -A3 packages
```

A path entry ⇒ local dev checkout; a `github.com/...@vX` entry ⇒ pinned release.

## Typecheck / test reminders

esbuild does **not** type-check. After editing extension/webview TS:

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json          # host (src/)
cd chronos-vscode && npx tsc --noEmit -p webview/tsconfig.json  # webview/
```

See `chronos-vscode/TESTING.md` for the RPC canary and UI-boot tests.
