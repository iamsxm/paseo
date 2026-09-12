# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ENV CI=1 \
    EXPO_NO_TELEMETRY=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ONNXRUNTIME_NODE_INSTALL=skip \
    LEFTHOOK=0
WORKDIR /app
COPY . .
RUN node scripts/npm-retry.mjs ci
RUN npm run build:web --workspace=@getpaseo/app

FROM nginx:1.28-alpine
COPY docker/host-sync/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
