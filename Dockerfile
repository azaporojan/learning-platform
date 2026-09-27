# =============================================================================
# Learning Platform — multi-stage Docker build
# Stage 1: build the React client (Vite)
# Stage 2: install production server dependencies (bcrypt is a native module)
# Stage 3: slim runtime: Express serves the API under /api and the client build at /
# =============================================================================

# --- Stage 1: client build ---
FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
# Same-origin defaults: API at /api, Socket.IO at the page origin (see client/config.ts)
ENV VITE_API_URL=/api
RUN npm run build

# --- Stage 2: server dependencies ---
FROM node:22-bookworm-slim AS server-deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Stage 3: runtime ---
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3001 \
    UPLOADS_DIR=/app/server/uploads \
    PUBLIC_DIR=/app/server/public
WORKDIR /app/server

# curl for the container HEALTHCHECK
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/ ./
COPY --from=client /app/client/dist ./public

# Uploads live on a persistent volume mounted at /app/server/uploads (see docs/DEPLOYMENT.md)
RUN mkdir -p /app/server/uploads \
 && chown -R node:node /app/server
USER node
VOLUME ["/app/server/uploads"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:3001/api/health || exit 1

CMD ["node", "index.js"]
