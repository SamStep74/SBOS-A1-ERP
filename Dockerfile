# SBOS-A1-ERP production Dockerfile.
#
# Multi-stage build: install deps in one stage, copy only the
# production tree + node_modules into the runtime image. The result
# is a slim (~80MB) Node 20 alpine image that runs the bootable
# product as a non-root user.
#
# Build:  docker build -t sbos-a1-erp:dev .
# Run:    docker run --rm -p 8080:3000 \
#             -v sbos-data:/var/lib/sbos-a1-erp \
#             -e PORT=3000 \
#             sbos-a1-erp:dev
#
# The container reads the admin session token from stdout (the same
# way the bare-metal deploy does). Pipe the logs to your log
# aggregator to capture it: `docker logs -f <container>`.

# ────────────────────────────────────────────────────────────────────────
# Stage 1: install production deps
# ────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy lockfile + manifest first so the install layer is cacheable
# independent of source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ────────────────────────────────────────────────────────────────────────
# Stage 2: runtime image
# ────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Run as a dedicated non-root user. The /var/lib/sbos-a1-erp dir is
# where the sqlite file + admin token file live; we make it owned
# by that user.
RUN addgroup -S sbos && adduser -S sbos -G sbos \
    && mkdir -p /var/lib/sbos-a1-erp \
    && chown -R sbos:sbos /var/lib/sbos-a1-erp

WORKDIR /opt/sbos-a1-erp

# Copy the application source. node_modules from the deps stage
# (production only — no eslint, prettier, devDeps).
COPY --chown=sbos:sbos --from=deps /app/node_modules ./node_modules
COPY --chown=sbos:sbos . .

# The boot path writes .sbos.db + the admin token file to the
# current working directory by default. Docker needs the data dir
# to be writable by the sbos user (done above).
USER sbos

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SBOS_DB=/var/lib/sbos-a1-erp/sbos.db \
    SBOS_LOCALE=en \
    SBOS_AUTH_MODE=real

EXPOSE 3000

# A HEALTHCHECK hits the unauthenticated /api/health endpoint. The
# docker HEALTHCHECK directive defaults to a 30s interval; this
# aligns with what `docker ps` reports as the container health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('node:http').get('http://127.0.0.1:' + (process.env.PORT||3000) + '/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "bin/sbos-server.mjs"]
