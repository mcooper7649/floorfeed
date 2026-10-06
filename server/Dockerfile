FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
# tsx runs the TypeScript directly, so dev deps are needed at runtime.
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
ENV PORT=8030 DB_PATH=/data/floorfeed.db NODE_ENV=production
VOLUME /data
EXPOSE 8030
USER node
CMD ["npx", "tsx", "src/index.ts"]
