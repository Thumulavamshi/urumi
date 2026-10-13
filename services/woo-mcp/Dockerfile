# WooCommerce MCP server. Node 24 runs the TypeScript sources directly (type
# stripping), so there is no compile step: install prod deps, copy src, run.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Non-root, numeric uid so runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080
CMD ["node", "src/index.ts"]
