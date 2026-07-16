# Donkai — orchestrator + dashboard + API + MCP in one container.
# Deploy via Coolify (Dockerfile build pack), mount a volume at /data.
FROM node:20-bookworm-slim

# git for workers/mirrors, gh for PR flows, build tools as a better-sqlite3
# fallback when no prebuild matches, curl for healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl python3 make g++ \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI installed at build time so the Agent SDK never downloads its
# ~220MB binary at runtime. Wired in via CLAUDE_CODE_EXECUTABLE.
RUN npm install -g @anthropic-ai/claude-code && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# PWA bundle (skipped gracefully if src/pwa is absent)
RUN if [ -f src/pwa/package.json ]; then \
      pnpm --dir src/pwa install && pnpm --dir src/pwa build; \
    fi

ENV DONKAI_DB_PATH=/data/donkai.sqlite \
    DONKAI_WORKSPACE_ROOT=/data/workers \
    DASHBOARD_HOST=0.0.0.0 \
    CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude \
    HOME=/home/donkai

RUN useradd -m -d /home/donkai donkai \
  && mkdir -p /data \
  && chown -R donkai:donkai /data /app

# No USER directive: the entrypoint starts as root to chown the mounted /data
# volume (named volumes arrive root-owned, shadowing the build-time chown),
# then drops to the donkai user before exec'ing the app.

EXPOSE 8346

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:8346/healthz || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["pnpm", "start"]
