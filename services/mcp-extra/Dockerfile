# One image, two servers: the chart picks one with `command: [node, src/fx.ts]`
# or `[node, src/notes.ts]`. Node 24 runs the TypeScript directly (type
# stripping), so there is no compile step.
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
USER 1000:1000
EXPOSE 8080
CMD ["node", "src/fx.ts"]
