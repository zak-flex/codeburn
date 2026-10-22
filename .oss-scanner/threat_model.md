# CodeBurn threat model

## What CodeBurn is

CodeBurn shows what AI coding tools cost. It runs on developers' own machines as:
- a CLI (`src/`);
- a desktop app (`app/`);
- a macOS menubar app (`mac/`);
- a Windows app (`windows/`);
- a VS Code extension (`vscode/`);
- a GNOME extension (`gnome/`).

It reads the session logs that tools such as Claude Code, Codex, Cursor and Copilot leave on disk, prices them, and shows the result. Everything is computed on the user's machine, and this repository has no hosted backend.

That makes it a valuable target for three reasons:
- it runs on thousands of developer machines;
- it reads AI provider sign-in tokens to show plan quotas;
- it updates itself.

## Where untrusted input enters

Treat all of these as attacker-controlled:

- **Session logs and tool databases** (`src/providers/`, `src/parser.ts`, `src/sqlite.ts`, `src/parse-worker*.ts`). Other tools write these files, but the content includes whatever the agent read: web pages, files from cloned repositories, tool output, MCP responses. A crafted line in a log is the most realistic attack path.
- **The local network** (`src/sharing/`). Sharing listens on all interfaces over TLS, announces itself with Bonjour, and pairs devices with a code and certificate pinning. Anyone on the same network can reach it.
- **Web pages in the user's browser** that reach the loopback servers:
  - the web dashboard (`src/web-dashboard.ts`);
  - the sync sign-in callback (`src/sync/auth.ts`).
- **Network responses**:
  - provider quota APIs (`src/quota/`, `app/electron/quota/`, `mac/`);
  - pricing and model data;
  - release metadata and downloads used by the updaters.
- **Workspaces opened in VS Code** (`vscode/`), which may be untrusted repositories.
- **Plugins** (`src/plugins/`): manifests and signatures from the plugins directory.

## What matters most

1. **Provider credentials.** `src/quota/` and the desktop and menubar quota code read OAuth tokens and API keys (the macOS Keychain, files such as `~/.codex/auth.json`) and call each provider's own API. A token must never reach:
   - another host;
   - a log or a cache;
   - telemetry or a shared report;
   - another local user.
2. **Code execution.** Any path from the inputs above to running a command, loading code, writing an executable or hook, or running script in a webview. Look in particular at:
   - the desktop app's IPC bridge (`app/electron/preload.ts`, `app/electron/bridge-handlers.ts`);
   - the webviews in `app/` and `vscode/`;
   - child processes the apps spawn (`app/electron/`, `vscode/`, `windows/src-tauri/`);
   - hooks written by `src/guard/`;
   - file changes made by `src/act/` (`codeburn optimize --apply`).
3. **Update and release integrity.** Anything that lets someone ship code to users. That covers:
   - `src/update.ts` and `src/menubar-installer.ts`;
   - `app/electron/auto-update.ts` and `app/electron/companion-update.ts`;
   - `windows/src-tauri/src/update.rs`;
   - the workflows in `.github/workflows/` that sign and publish releases.
4. **Sharing and sync.**
   - In `src/sharing/`: pairing, peer authentication, and what a paired or unpaired device can read.
   - In `src/sync/`: the OIDC flow, stored credentials, and the OTLP export.
5. **Privacy.** Prompts, file paths, and project and repository names must not leave the machine unless the user turned that feature on. Telemetry (`src/telemetry-snapshot.ts`, `app/electron/telemetry.ts`, `windows/src-tauri/src/telemetry.rs`), sharing and sync are all meant to be opt-in.

Lower priority but still in scope:
- the terminal UI (`src/*.tsx`);
- the GNOME extension;
- the MCP server (`src/mcp/`, stdio only);
- `src/serve.ts` (stdio, used by the desktop app).

## How to exercise it

- **What the image builds:**
  - the CLI (`dist/`) and the dashboard (`dash/dist/`);
  - the desktop app's main process and renderer (`app/`);
  - the VS Code extension (`vscode/`);
  - the Windows web UI.
- **Tests:** `npm test` at the repository root runs the CLI suite, and `tests/fixtures/` holds sample session logs for many providers. `app/` and `vscode/` each have their own `npm test`.
- **Run the tests as the `node` user** (`su node -c "npm test"`). As root, a few tests that simulate an unwritable file fail, because root can write anyway.
- **Manual runs:** run the CLI against a fake home, for example `HOME=/tmp/fake node dist/cli.js report`, after placing crafted logs where a provider looks for them. Each file in `src/providers/` defines its paths.
- **Source only:** `mac/` (Swift) and `windows/src-tauri/` (Rust) do not build on Linux; review their source.

## Severity

- **Critical:**
  - code execution on a user's machine, or theft of provider credentials, from input the attacker controls without local access. Examples: a log line the agent wrote after reading a web page or a repository, a device on the network, a server response;
  - shipping code to users through the update or release path.
- **High:**
  - the same outcomes when they need an unusual setting or a user click;
  - credentials written to disk, logs or caches that other users or apps can read;
  - arbitrary file write;
  - an unpaired device reading shared data.
- **Medium:**
  - private data (prompts, paths, project names) leaving the machine beyond what the user turned on;
  - a crafted input that breaks the app on every launch.
- **Low:**
  - one-off crashes or hangs on malformed input;
  - hardening gaps with no demonstrated impact.

## Leave alone

- Wrong costs, token counts or prices. Those are bugs; please open an issue.
- Attacks that need code already running as the same user, since that user can read the same files directly.
- Vulnerabilities in dependencies, unless CodeBurn uses the dependency unsafely.
- `docs/`, `perf/`, `assets/`, `scripts/perf/` and other developer-only tooling, unless it runs in CI with access to secrets.

## Reports

- One report per root cause, listing every affected path.
- Say what the attacker controls, and include a minimal proof of concept. A crafted log file or request is ideal.
- Keep patches small and in the existing style (TypeScript, Vitest), with a test that fails before the fix. No new dependencies.
