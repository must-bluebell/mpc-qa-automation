# syntax=docker/dockerfile:1
# GitHub App listener and review runner, without the Docker-in-Docker tooling the QA dashboard image needs.
# Build from the repository root (the .dockerignore keeps .env, keys, runs and node_modules out of the image):
#   docker build -f deploy/github-app/Dockerfile -t mpc-qa-github-app .
FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    QA_RUNS_DIR=/app/runs
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY . .
RUN mkdir -p runs
STOPSIGNAL SIGTERM
CMD ["node", "pipeline/github-app/server.mjs"]
