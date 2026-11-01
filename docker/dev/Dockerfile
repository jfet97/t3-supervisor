# The images of the Docker development environment (docs/local-stack.md). `development`: Node, pnpm, Git, jq and the pinned
# provider CLIs. `e2e`: the same toolchain plus the headless Chromium of the pinned Playwright library, for the browser
# journeys (docs/testing.md). Source, credentials and state are never part of either; they come from the mounted checkout and
# the named volumes.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS development

ARG DEV_UID=1000
ARG DEV_GID=1000
ARG CODEX_VERSION=0.166.0
ARG CLAUDE_CODE_VERSION=2.1.316

# T3SUP_DEV_CONTAINER makes ./dev use this image's own toolchain, for example in T3's worktree setup
ENV T3SUP_DEV_CONTAINER=1 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DISABLE_AUTOUPDATER=1 \
    PATH=/opt/providers/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# jq: the tests run the release workflow's own shell steps, which use it
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git gzip jq less openssh-client procps tar \
 && rm -rf /var/lib/apt/lists/*

# pnpm 12 fetches its native executable on first use; fetching it here, for this image's architecture, leaves the
# read-only corepack home complete, so the development user never downloads or writes there
RUN corepack enable pnpm \
 && corepack install -g pnpm@12.14.0 \
 && test "$(pnpm --version)" = 12.14.0 \
 && chmod -R a+rX "$COREPACK_HOME"

# both CLIs must run, offline and under a throwaway home, before the image is accepted
RUN npm install --global --prefix /opt/providers --no-fund --no-audit \
      "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && check_home=$(mktemp -d) \
 && HOME="$check_home" codex --version \
 && HOME="$check_home" claude --version \
 && rm -rf "$check_home"

# the development user owns every mount point, so a new named volume starts with that ownership
RUN userdel --remove node 2>/dev/null || true; groupdel node 2>/dev/null || true; \
    if ! getent group "$DEV_GID" >/dev/null; then groupadd --gid "$DEV_GID" dev; fi; \
    useradd --uid "$DEV_UID" --gid "$DEV_GID" --home-dir /credentials/home --no-create-home --shell /bin/bash dev; \
    mkdir -p /credentials/home /data /cache /workspace/node_modules; \
    chown "$DEV_UID:$DEV_GID" /credentials /credentials/home /data /cache /workspace /workspace/node_modules; \
    chmod 0700 /credentials /credentials/home

USER dev
WORKDIR /workspace

# the browser journeys' image: the headless Chromium build and its system libraries for exactly the playwright-core version the
# lockfile installs (test/dev-environment.test.ts keeps both equal); the browsers live outside every volume, readable by the
# development user. It never holds credentials: the e2e service mounts neither the credentials nor the data volume
FROM development AS e2e
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
USER root
RUN npm exec --yes --package="playwright-core@${PLAYWRIGHT_VERSION}" -- playwright-core install --with-deps --only-shell chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
USER dev
WORKDIR /workspace
