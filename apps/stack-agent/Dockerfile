# =============================================================================
# stack-agent image  (issue #567)
# =============================================================================
# IMPORTANT: the build context is the REPOSITORY ROOT, not apps/stack-agent.
#
#   docker build -f apps/stack-agent/Dockerfile .
#
# Same reason as apps/api/Dockerfile: this is an npm workspace member with no
# lockfile of its own, and building from the root is what makes the single
# root lockfile visible, so the build stage installs with `npm ci`.
#
# The agent has ZERO runtime dependencies (node:http, node:child_process,
# node:crypto), so the production stage carries no node_modules at all: only
# the compiled JS, and the docker CLI with its compose plugin -- the one
# program it runs.
# =============================================================================

# -----------------------------------------------------------------------------
# Build: TypeScript -> dist/
# -----------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
# Manifests first, so this layer caches on dependency changes only. Only this
# workspace's manifest is needed: `npm ci --workspace` installs just its
# (dev) dependencies -- typescript and the node types.
COPY package.json package-lock.json ./
COPY apps/stack-agent/package.json ./apps/stack-agent/
RUN npm ci --workspace=stack-agent --ignore-scripts
COPY tsconfig.base.json ./
COPY apps/stack-agent ./apps/stack-agent
WORKDIR /app/apps/stack-agent
RUN npm run build

# -----------------------------------------------------------------------------
# Production
# -----------------------------------------------------------------------------
FROM node:24-alpine AS production
# The docker CLI and its compose plugin. No daemon: the host's socket is
# mounted in (vps.compose.yml), and that mount is the whole security question
# -- see the header of vps.compose.yml.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
# `package.json` for `"type": "module"`; nothing is installed from it.
COPY --from=build /app/apps/stack-agent/package.json ./package.json
COPY --from=build /app/apps/stack-agent/dist ./dist

ENV NODE_ENV=production
# The root filesystem is mounted read-only; the docker CLI keeps its config on
# the /tmp tmpfs instead of ~/.docker.
ENV HOME=/tmp
ENV DOCKER_CONFIG=/tmp/.docker

# ROOT, deliberately, and with every capability dropped (vps.compose.yml:
# cap_drop ALL, no-new-privileges, read_only). The host's docker.sock is
# `root:docker 0660`, and the docker group's gid differs from host to host, so
# a fixed non-root user could not open it without a per-host build argument.
# Root WITHOUT capabilities can open it (it is the socket's owner) and can do
# nothing else a normal root could: no CAP_DAC_OVERRIDE, no CAP_CHOWN, no
# CAP_NET_RAW, no setuid escalation. Access to the socket is root-equivalent
# on the host either way; what confines it is the process, which accepts no
# parameters (src/server.ts).
EXPOSE 8090

# Exec form, so SIGTERM reaches node rather than a wrapping /bin/sh.
ENTRYPOINT ["node", "/app/dist/main.js"]
