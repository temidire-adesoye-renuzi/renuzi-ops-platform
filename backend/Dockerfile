# ============================================================================
# RENUZI OPS BACKEND - PRODUCTION/STAGING IMAGE
# Multi-stage build: a slim runtime containing ONLY production deps, running
# as an unprivileged user. The container never needs devDependencies
# (jest/supertest), .env files, or the git history.
# ============================================================================

# --- Stage 1: dependencies -----------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
# `npm ci --omit=dev` needs the lockfile; fall back to install if it is absent
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# --- Stage 2: runtime ------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# dumb-init not in base alpine node image; tini via init semantics of node
# itself is acceptable. Security baseline:
#  - non-root user
#  - no package manager cache
RUN addgroup -S renuzi && adduser -S renuzi -G renuzi

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js app.js ./
COPY src ./src
# Migrations ship with the image so `npm run migrate` is available in-staging
COPY database ./database
COPY scripts ./scripts

# Upload storage volume target (local driver)
RUN mkdir -p /app/uploads && chown -R renuzi:renuzi /app
VOLUME ["/app/uploads"]

USER renuzi
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
