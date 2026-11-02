# The Tohyee camera post box (decisions 1226-1233): a small program for a rented
# online server. Cameras upload to it by FTPS; Tohyee collects over HTTPS.
# Built and published as ghcr.io/willy-nz/tohyee-postbox by
# .github/workflows/release-server-bundle.yml when a v* tag is pushed.
#
# To build it yourself, from the repository's top folder:
#   docker build -f postbox/Dockerfile -t tohyee-postbox .

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Only esbuild is needed to bundle it, at the version the lock file says
# (installed on its own, not with the whole project's packages).
COPY package-lock.json /tmp/package-lock.json
RUN echo '{"private":true}' > package.json \
 && npm install --no-audit --no-fund \
      "esbuild@$(node -p "require('/tmp/package-lock.json').packages['node_modules/esbuild'].version")"
COPY package.json tsconfig.json ./
COPY src ./src
COPY postbox ./postbox
COPY scripts/build-postbox.mjs ./scripts/build-postbox.mjs
RUN node scripts/build-postbox.mjs

FROM node:22-bookworm-slim
# openssl makes the post box's own certificate on first start.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/tohyee-postbox.cjs ./postbox.cjs
ENV NODE_ENV=production \
    POSTBOX_DATA_DIR=/data \
    POSTBOX_FTP_PORT=2121 \
    POSTBOX_API_PORT=8443
# The queue, the certificate and who it's paired with.
VOLUME /data
USER node
EXPOSE 2121 8443 50000-50019
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/postbox.cjs", "health"]
CMD ["node", "/app/postbox.cjs", "serve"]
