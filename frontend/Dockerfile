# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------- build
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci: exact lockfile versions, fails if package.json and lockfile disagree
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------- serve
# Unprivileged image: nginx runs as uid 101 and listens on 8080 (no root, no CAP_NET_BIND).
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
