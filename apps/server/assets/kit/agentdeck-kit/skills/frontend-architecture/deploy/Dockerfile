# Reference multi-stage Dockerfile for a Vite SPA (frontend doctrine).
# Adapt to the project/monorepo (context, --filter <pkg>). Infra is read-only: apply on consent.

# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
# Dependency cache: manifests first
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# --- Runtime stage: static files via nginx (not a node server) ---
FROM nginx:1.27-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ || exit 1
