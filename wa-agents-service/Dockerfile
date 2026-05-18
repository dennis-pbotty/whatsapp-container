# Stage 1: build wacli from source
FROM golang:1.25-bookworm AS wacli-builder

WORKDIR /build
RUN wget -qO- https://github.com/steipete/wacli/archive/refs/tags/v0.9.2.tar.gz \
    | tar -xz --strip-components=1

# CGO_CFLAGS: suppress GCC 15+ missing-braces error in Go's runtime/cgo
RUN CGO_CFLAGS="-Wno-error=missing-braces" \
    go build -tags sqlite_fts5 \
      -ldflags="-s -w -X main.version=0.9.2" \
      -o /usr/local/bin/wacli \
      ./cmd/wacli

# Stage 2: runtime image
FROM node:20-bookworm-slim

# Build deps for better-sqlite3 native module + util-linux for script(1)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates bsdmainutils util-linux \
    && rm -rf /var/lib/apt/lists/*

# wacli built natively for Bookworm — no loader shim needed
COPY --from=wacli-builder /usr/local/bin/wacli /usr/local/bin/wacli

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

ENV PORT=8792
ENV DB_PATH=/data/wa-bot.db
ENV WACLI_STORE_DIR=/data/wacli
EXPOSE 8792

CMD ["node", "server.js"]
