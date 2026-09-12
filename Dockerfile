# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: better-sqlite3 ships glibc prebuilds, so the
# image needs no compiler and the build stays fast on a Pi or a NAS.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# /data holds the SQLite file and the generated session secret, so it has to be
# writable by the unprivileged user the image already ships with.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

# /healthz reads the database file. The old probe hit /robots.txt, a static
# string that keeps being served while the data underneath is unreadable. It
# cannot spot an unmounted volume -- that looks exactly like a first install --
# so the app logs loudly whenever it has to create a new, empty database.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
