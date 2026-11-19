# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Base Toolchain (Node.js 22 + Python 3)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS base

RUN apk add --no-cache python3

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# -----------------------------------------------------------------------------
# Stage 2: BuildKit Asset Builder (use `--target builder` / `--target export` / `--target web`)
# Requires `DDLC_ZIP_FILE` (relative to build context) to exist when targeting this stage.
# -----------------------------------------------------------------------------
FROM base AS builder

ARG DDLC_ZIP_FILE=ddlc-win.zip
COPY index.html tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY tools/ ./tools/
COPY ${DDLC_ZIP_FILE} /ddlc/ddlc-win.zip

RUN DDLC_ZIP=/ddlc/ddlc-win.zip npm run build

# -----------------------------------------------------------------------------
# Stage 3: Export Static Bundle (`docker build --target export -o dist .`)
# -----------------------------------------------------------------------------
FROM scratch AS export
COPY --from=builder /app/dist /

# -----------------------------------------------------------------------------
# Stage 4: Prebuilt Static Nginx Image (`docker build --target web -t ddlcweb-static .`)
# -----------------------------------------------------------------------------
FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80

# -----------------------------------------------------------------------------
# Stage 5: Standalone Builder + Nginx Runner (Default Final Target)
# Contains ZERO copyrighted DDLC files; mount your own ddlc-win.zip at runtime:
#   docker build -t ddlcweb .
#   docker run --rm -p 8080:80 -v /path/to/ddlc-win.zip:/ddlc/ddlc-win.zip:ro ddlcweb
# -----------------------------------------------------------------------------
FROM base AS runner

RUN apk add --no-cache nginx && mkdir -p /run/nginx /usr/share/nginx/html /ddlc /out

COPY index.html tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY tools/ ./tools/
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
