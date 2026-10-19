# Build the SPA with Node, serve the static files with unprivileged nginx.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
# Skip the image's entrypoint scripts (they try to rewrite config files, which a
# read-only root filesystem doesn't allow, and we don't need them).
ENTRYPOINT ["nginx", "-g", "daemon off;"]
