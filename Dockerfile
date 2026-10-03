# Tohyee server image. Built and published by
# .github/workflows/release-server-bundle.yml when a v* tag is pushed.
# The database is PostgreSQL, run separately (see deploy/windows).

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && node scripts/build-admin.mjs

FROM node:22-bookworm-slim AS cloudflared
# cloudflared runs the Cloudflare Tunnel for remote access (Server > Remote access).
# Pinned, and checked against the SHA-256 of that release's file.
ARG CLOUDFLARED_VERSION=2026.9.3
ARG CLOUDFLARED_SHA256=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2
ADD https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64 /cloudflared
RUN echo "${CLOUDFLARED_SHA256}  /cloudflared" | sha256sum -c - && chmod 0755 /cloudflared

FROM node:22-bookworm-slim
# pg_dump and pg_restore for backups, from PostgreSQL's own apt repository:
# they must be at least the database server's version (17 in docker-compose).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /backups /analytics && chown node:node /backups /analytics
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TOHYEE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared \
    TOHYEE_BACKUP_DIR=/backups \
    TOHYEE_ANALYTICS_DIR=/analytics
COPY --from=cloudflared /cloudflared /usr/local/bin/cloudflared
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# The command-line tool: docker compose exec tohyee node tohyee-admin.cjs help
COPY --from=build --chown=node:node /app/dist/tohyee-admin.cjs ./tohyee-admin.cjs
# Backups (Server settings > Backups); mount a volume or a folder here.
VOLUME /backups
# Analytics data (rebuildable by loading again; decision 355).
VOLUME /analytics
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
