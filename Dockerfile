# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

ARG VERSION
ARG REVISION
ARG CREATED
ARG DESCRIPTION
ARG SOURCE
ARG APP_VERSION

LABEL org.opencontainers.image.title="CinePro Core" \
      org.opencontainers.image.description="${DESCRIPTION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="${SOURCE}"

LABEL org.opencontainers.image.description="CinePro Core is the central scraping and streaming engine of the CinePro ecosystem. It exposes an OMSS-compliant HTTP API for resolving movie and TV show streams from multiple providers."

ARG NODE_ENV=production
ARG PORT=3000
ARG CACHE_TYPE=memory

ENV NODE_ENV=${NODE_ENV}
ENV HOST=0.0.0.0
ENV PORT=${PORT}
ENV CACHE_TYPE=${CACHE_TYPE}
# The build this image contains. /v1/health reports it as `version`, which is
# what the deploy gate asserts (a stale container must not pass as this build).
ENV APP_VERSION=${APP_VERSION}

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# yt-dlp resolves the YouTube media URLs for /v1/youtube/*. It is the moving
# part of that endpoint (YouTube breaks extractors monthly), so it is pinned to
# a version this repo's CI gate has actually streamed from — bump it in the same
# commit that re-runs the gate, never with a floating tag. Pure Python: no
# arch-specific download, works for the amd64 and arm64 builds alike.
ARG YTDLP_VERSION=2026.08.19
RUN apk add --no-cache python3 py3-pip && \
    pip install --break-system-packages --no-cache-dir --root-user-action=ignore \
        "yt-dlp==${YTDLP_VERSION}" && \
    rm -rf /root/.cache/pip

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

EXPOSE ${PORT}

CMD ["node", "dist/server.js"]