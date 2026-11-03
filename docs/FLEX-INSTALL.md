# Installing CodeBurn from this fork

This page is specific to the `zak-flex/codeburn` fork. It exists only in the
fork and is not part of the upstream CodeBurn docs. Follow it when you want the
LiteLLM Proxy provider (and any other fork-only work) instead of the published
`codeburn` package.

Upstream's install lines — `npx codeburn`, `npm i -g codeburn`, `brew install
codeburn` — fetch the published package, which does **not** include this fork's
LiteLLM provider. A fork has to be built from source.

## Before you start

- **Node.js 22.13 or newer.** The build and CLI were verified on Node 22.15.
  `package.json` sets `engines.node` to `>=22.13.0`.
- The fork builds from source, so a checkout of this repository and a couple of
  npm commands. It is not on npm or Homebrew.

## 1. Clone and build

```bash
git clone https://github.com/zak-flex/codeburn.git
cd codeburn
npm ci
npm run build
```

`npm ci` needs the exact `package-lock.json` in the repo, so use it rather than
`npm install`. The build produces `dist/cli.js` (the CLI) and the web dashboard.

### Node version managers

- **asdf**: if `node` inside the repo fails with "No version is set", the repo
  has no `.tool-versions`. Pin one explicitly:
  ```bash
  ASDF_NODEJS_VERSION=22.15.0 npm run build
  ```
- **nvm / Volta / plain installs**: a single Node 22.13+ on PATH works as-is.

## 2. Put `codeburn` on your PATH

The repo's binary is `dist/cli.js`. Link it so the command works from any
directory:

```bash
npm link        # or add a wrapper that pins your Node, see below
```

If you use a version manager and want a wrapper instead:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/codeburn <<'EOF'
#!/usr/bin/env bash
export ASDF_NODEJS_VERSION=22.15.0
exec /path/to/codeburn/dist/cli.js "$@"
EOF
chmod +x ~/.local/bin/codeburn
```

Replace `/path/to/codeburn` with your checkout path. Add `~/.local/bin` to your
`PATH` if it is not already there.

Verify:

```bash
codeburn --version   # 0.9.26-SNAPSHOT or newer
codeburn status      # reads local tool sessions
```

## 3. Connect the LiteLLM Proxy provider

The provider reads spend from the LiteLLM Proxy's daily activity endpoint. It
needs a proxy URL and a **virtual key that is allowed to read spend**.

### The key must be allowed to read usage

A key made only for chat completions returns HTTP 403 with:

```
Virtual key is not allowed to call this route. Only allowed to call
routes: ['llm_api_routes']. Tried to call route: /user/daily/activity
```

A working key needs permission on the usage route (`/user/daily/activity`,
included in the `info_routes` group on the Flex proxy). `flexai auth
print-token` returns such a key after `flexai login` (see below).

### Provide the URL and key

CodeBurn resolves them from environment variables **first**, then falls back to
`~/.config/codeburn/config.json` (the fallback is what the macOS menu bar uses,
since a GUI app does not inherit your shell env).

**Shell (recommended for the CLI):**

```bash
export LITELLM_BASE_URL=https://litellm.shared.getflex.org
export LITELLM_API_KEY="$(flexai auth print-token)"
```

The accepted variable names, in precedence order:

| Variable | Meaning |
|---|---|
| `LITELLM_API_KEY` | The spend-read virtual key (preferred) |
| `LITELLM_KEY` | Alias accepted for `LITELLM_API_KEY` |
| `LITELLM_MASTER_KEY` | Fallback if the above are unset |

**Config file (needed for the macOS menu bar):**

```bash
codeburn litellm --base-url https://litellm.shared.getflex.org --api-key "$(flexai auth print-token)"
```

The key is written to `~/.config/codeburn/config.json`. Keep that file readable
only by you:

```bash
chmod 600 ~/.config/codeburn/config.json
```

Prefer the env-var form for the CLI: passing `--api-key sk-...` on a shell
command line leaves the key in shell history and the process list.

### Flex-specific: getting the key

After `flexai login`, the key is available as:

```bash
flexai auth print-token
```

It prints the LiteLLM virtual key to stdout. Pipe it into the export or the
`codeburn litellm` command rather than pasting it.

> **LiteLLM SSO login files are not used.** `~/.litellm/token.json` is an SSO
> session record; its `jwt_token` field can be empty and it names a custom
> `auth_header_name`. CodeBurn sends `Authorization: Bearer`, so a login token
> would need code changes even after a fresh sign-in. Use a virtual key.

### Verify

```bash
codeburn report --provider litellm -p 30days
```

If LiteLLM appears, the key works. If nothing appears:

- **No key set at all** → the provider returns nothing and prints nothing. Set
  `LITELLM_API_KEY` (or the config block) as above.
- **403** → the key cannot read spend. Get one with usage-route permission
  (`flexai auth print-token` after login).

## 4. Watch for double counting

The LiteLLM provider **counts in headline totals by default**. If your other
tools (Claude Code, etc.) already route through the Flex proxy, local sessions
and LiteLLM may both count the same spend, so your totals can look roughly
doubled.

If you see inflated totals, exclude LiteLLM from the headline (it still shows as
its own row, marked "not in total"):

```bash
codeburn gateway-totals exclude
```

## 5. macOS menu bar

The menu bar resolves the `codeburn` CLI in this order: `CODEBURN_BIN` → the
bundled CLI → `~/Library/Application Support/CodeBurn/codeburn-cli-path.v1` →
`PATH` (brew, nvm, Volta, asdf).

To run the menu bar against this fork's build, point that file at your built
`dist/cli.js`:

```bash
printf '%s\n' '/absolute/path/to/codeburn/dist/cli.js' \
  > "$HOME/Library/Application Support/CodeBurn/codeburn-cli-path.v1"
```

The menu bar picks it up on its next refresh (30s when active, up to 5 minutes
when idle). Deleting the file reverts to the `PATH` install.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No LiteLLM row, no error | No key set, or wrong variable name | `LITELLM_API_KEY="$(flexai auth print-token)"` |
| HTTP 403, "not allowed to call this route" | Key lacks usage-route permission | Use a spend-read key (`flexai auth print-token`) |
| `node: No version is set` | asdf has no `.tool-versions` | `ASDF_NODEJS_VERSION=22.15.0 npm run build` |
| Totals look doubled | Local tools route through the proxy too | `codeburn gateway-totals exclude` |

## Updating this fork

```bash
git fetch upstream && git rebase upstream/main
npm ci && npm run build
```

Your fork-only work (including this page) lives on the `flex-lite-llm` branch so
`main` can stay in sync with upstream. See `docs/README.md` for the rest of the
manual, which applies unchanged.