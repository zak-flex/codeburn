# Build image for Anthropic's OSS Scanner: installs every dependency and builds CodeBurn so an offline agent can read,
# build and test it. The Swift menubar app (mac/) and the Rust half of the Windows app (windows/src-tauri) do not build
# on Linux; their source is still in /src.
FROM node:22-bookworm

ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false

COPY --chown=node:node . /src
WORKDIR /src
# Tests that simulate an unwritable file only behave as a normal user, so build and test as `node`.
USER node

# CLI and web dashboard (npm run build also builds dash/)
RUN npm ci && npm run build
# Desktop app: Electron main process and renderer
RUN cd app && npm ci && npm run build
# VS Code extension: host, webview and the staged CLI
RUN cd vscode && npm ci && npm run build
# Windows app: web UI only
RUN cd windows && npm ci && npm run build

RUN npm test -- --maxWorkers=4 || echo "WARNING: CLI tests reported failures"
RUN (cd app && npm test) || echo "WARNING: desktop tests reported failures"
RUN (cd vscode && npm test) || echo "WARNING: VS Code extension tests reported failures"

USER root
