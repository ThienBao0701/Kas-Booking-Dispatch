# syntax=docker/dockerfile:1
#
# KAS hotel booking dispatch — production image.
#
# One image serves everything: the Express API and the built React client, on a
# single internal port. That keeps the browser same-origin with the API (so the
# session cookie needs no cross-site relaxation) and keeps the production
# topology to app + reverse proxy.
#
# Base: Debian "bookworm-slim" rather than Alpine on purpose. Prisma's default
# engine target for this base (debian-openssl-3.0.x) is downloaded by
# `prisma generate` without any schema change; Alpine would require adding musl
# binaryTargets to prisma/schema.prisma. The extra ~80 MB buys a build that
# cannot silently produce an image with a missing query engine.
#
# Node 24 matches the repository's `engines` range (>=22 <25) and the version
# development runs on. No dependency or runtime major version is changed here.

ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------- dependencies
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Only the manifests + the Prisma schema, so this layer is cached until a
# dependency actually changes. The schema is required because the root
# `postinstall` runs `prisma generate`.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY prisma ./prisma

# `npm ci` installs exactly the locked tree — never a floating resolution.
RUN npm ci

# ---------------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY server ./server
COPY client ./client

# Server: tsc -> server/dist (no source maps, see tsconfig.build.json).
# Client: tsc --noEmit + vite build -> client/dist.
RUN npm run build

# -------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    SERVE_CLIENT=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# `dumb-init` gives the container a real PID 1 so SIGTERM reaches Node and the
# app's graceful-shutdown handler (close server -> disconnect Prisma) runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

# Production dependency tree only: no vite, eslint, vitest, tsx or typescript.
# `prisma` itself is a runtime dependency because `prisma migrate deploy` is run
# from this image during every release.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# Only the compiled output — no TypeScript sources, tests, fixtures or configs.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

# Writable mount points, owned by the unprivileged user the app runs as. The
# real data lives on the volumes mounted over these paths at run time.
RUN mkdir -p /data/uploads/booking-proofs /data/uploads/issue-photos /data/backups /data/db \
 && chown -R node:node /data /app

# Never root: a container escape or an upload bug then has no privileged shell.
USER node

EXPOSE 3001

# Uses the app's real liveness endpoint, which only answers 200 when the
# database actually responds. Node 24 has a global fetch, so no curl is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/dist/index.js"]
