# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: build frontend (Vite) + compile server TypeScript
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install all deps (including dev) for the build.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source.
COPY . .

# Build the SPA → dist/
RUN npm run build

# Compile server.ts → dist-server/server.js
# tsconfig.server.json targets CommonJS for Node compatibility
RUN npx tsc --project tsconfig.server.json

# -----------------------------------------------------------------------------
# Stage 2: minimal runtime image — no dev tools, no TypeScript compiler
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

# Create a non-root user for the process.
RUN addgroup -S jaynotes && adduser -S jaynotes -G jaynotes

WORKDIR /app

# Install only production deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Pull in the compiled frontend and compiled server.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

# The vault lives under /data — bind-mount a host folder into it.
RUN mkdir -p /data && chown -R jaynotes:jaynotes /app /data

USER jaynotes

ENV VAULT_PATH=/data
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

# Health check — fails fast if server isn't responding.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/auth/status || exit 1

CMD ["node", "dist-server/server.js"]
