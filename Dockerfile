# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Native deps needed to compile better-sqlite3 and other native addons
RUN apk add --no-cache python3 make g++ gcc libc-dev

WORKDIR /app

# Install ALL deps (including devDependencies for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Runtime native deps for better-sqlite3
RUN apk add --no-cache python3 make g++ gcc libc-dev

WORKDIR /app

COPY package.json package-lock.json ./

# Install production deps only; rebuild native modules for this arch
RUN npm ci --omit=dev && npm rebuild better-sqlite3

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# The data directory (SQLite DB, Baileys session files) is mounted as a volume
# so it survives container restarts / upgrades
RUN mkdir -p /app/data

# Run as a non-root user for safety
RUN addgroup -S bot && adduser -S bot -G bot && chown -R bot:bot /app
USER bot

CMD ["node", "dist/src/index.js"]
