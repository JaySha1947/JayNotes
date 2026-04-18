# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: build the frontend with Vite
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install all deps (including dev) for the build.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Copy the rest of the source.
COPY . .

# Build the SPA → dist/
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: minimal runtime image
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

# Create a non-root user for the process.
RUN addgroup -S jaynotes && adduser -S jaynotes -G jaynotes

WORKDIR /app

# Copy manifests and install *only* production deps.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Pull in the compiled frontend and the server source.
COPY --from=builder /app/dist ./dist
COPY server.ts ./server.ts
COPY tsconfig.json ./tsconfig.json

# tsx runs TS directly in production (no need for a separate compile step).
RUN npm install tsx --omit=dev --no-audit --no-fund

# The vault lives under /data so you can bind-mount a host folder into it.
RUN mkdir -p /data && chown -R jaynotes:jaynotes /app /data

USER jaynotes

ENV VAULT_PATH=/data
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

# Basic health check - container reports unhealthy if the API is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/auth/status || exit 1

CMD ["npx", "tsx", "server.ts"]
