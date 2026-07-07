# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder

# Install build dependencies for CGo (sqlite3 needs gcc/musl-dev)
RUN apk add --no-cache gcc musl-dev

WORKDIR /app

# Copy dependency manifests
COPY go/go.mod go/go.sum ./
RUN go mod download

# Copy source code and build
COPY go/ ./
RUN CGO_ENABLED=1 GOOS=linux go build -o squish-bot ./cmd/bot/

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM alpine:latest AS production

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache ca-certificates

# Copy compiled binary
COPY --from=builder /app/squish-bot ./squish-bot

# The data directory (SQLite DB, whatsmeow session files) is mounted as a volume
# so it survives container restarts / upgrades
RUN mkdir -p /app/data

# Run as a non-root user for safety
RUN addgroup -S bot && adduser -S bot -G bot && chown -R bot:bot /app
USER bot

CMD ["./squish-bot"]
