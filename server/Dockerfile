# Build stage: better-sqlite3 compiles from source when no prebuilt binary
# matches the Node ABI, so it needs a toolchain that the runtime image doesn't.
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

FROM node:22-bookworm-slim
WORKDIR /app
# tsx runs the TypeScript directly, so dev deps are needed at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
ENV PORT=8030 DB_PATH=/data/floorfeed.db NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8030
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]
