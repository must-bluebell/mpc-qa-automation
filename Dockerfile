# syntax=docker/dockerfile:1
ARG DOCKER_VERSION=29.3.1
ARG K6_VERSION=2.3.0
FROM docker:${DOCKER_VERSION}-cli AS docker-cli
FROM grafana/k6:${K6_VERSION} AS k6

FROM node:22-bookworm-slim
ARG AUTOMATION_ROOT=/opt/mpc-automation
ARG CODEX_VERSION=0.163.0
ENV NODE_ENV=development \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    QA_RUNS_DIR=runs
WORKDIR ${AUTOMATION_ROOT}

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git procps \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.32.1 --activate

# Match the subscription-backed CLI used by the trusted CI review job.
RUN npm install --global @openai/codex@${CODEX_VERSION} \
    && codex --version \
    && npm cache clean --force

COPY package.json package-lock.json ./
RUN npm ci \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

# External JMeter/Postman plan validation and report conversion use the Python standard library.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

# Compose's application image builds require the Buildx plugin as well.
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

COPY . .
RUN mkdir -p runs
EXPOSE 4500
STOPSIGNAL SIGTERM
CMD ["node", "pipeline/docker/services.mjs"]
