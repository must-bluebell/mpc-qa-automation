# MPC automation container

This repository has its own [Dockerfile](../Dockerfile) and [Compose service](../docker-compose.yml). The image contains Node.js 22, the locked npm dependencies, Chromium for this repository's Playwright version, pnpm 10.32.1, Python 3 for external plan validation/reporting, Codex CLI 0.163.0, Docker CLI 29.3.1 with Compose, and k6 2.3.0. It runs the QA dashboard and, when enabled, the Slack scheduler. It does not embed the application, its database, or either chain.

## Host requirements

Use Docker Engine with Compose on Linux. Docker Desktop on macOS also works with **Settings → Resources → Network → Enable host networking** enabled; see [Docker's host networking documentation](https://docs.docker.com/engine/network/drivers/host/).

Host networking keeps the existing loopback-only dashboard, isolated-write/load safeguards, and application URLs working. There are no published `ports` mappings. The dashboard stays on `127.0.0.1` and must be accessed locally or through an SSH tunnel. The automation service uses the host Docker socket to inspect and manage the separate application stack; give this access only to the trusted QA runner.

Keep both repositories on the same Docker host. The application's checkout path must match `stack.webmpcPath` in [environments.json](../pipeline/config/environments.json), resolved relative to the automation checkout. With the current profiles the layout is:

```text
/srv/mpc-automation/
/srv/WEB MPC/
```

The Compose build sets the image's working directory to the automation checkout's absolute path and mounts the application at its same absolute host path. This matters because bind mounts requested through the Docker socket are resolved on the host. Build again if you move the checkouts. Application dependencies use a separate Linux volume, so the container never loads the Mac's native `node_modules`.

## Configure and build

From the `mpc-automation` checkout:

```sh
[ -f .env ] || cp .env.example .env
chmod 600 .env
export MPC_AUTOMATION_PATH="$(pwd -P)"
export MPC_WEBAPP_PATH="$(cd '../WEB MPC' && pwd -P)"
docker compose build automation
```

For this trusted two-checkout setup, edit the automation `.env` and explicitly set:

```dotenv
QA_EXTERNAL_REPOSITORIES=1
```

The copied `.env.example` defaults to `QA_EXTERNAL_REPOSITORIES=0`. Keep that default for automation-only use. The opt-in above authorizes access to the separate application checkout and is required before `stack:up`, `stack:down`, and application-owned UAT scenarios can run. Mounting the checkout alone does not grant that access. Compose reads this setting from `.env`; recreate an already-running automation container after changing it.

On Docker Desktop, select its Unix socket if `/var/run/docker.sock` is unavailable:

```sh
export MPC_DOCKER_SOCKET="$HOME/.docker/run/docker.sock"
```

Install/refresh this image's browser revision in the persistent browser volume:

```sh
docker compose run --rm --no-deps automation npx playwright install chromium
```

The automation `.env` supplies the QA wallet, Slack, AI and dashboard settings at runtime. The application's `docker/.env` supplies its own stack configuration. Neither file is included in the automation image. The `.dockerignore` also excludes Git history, private keys, local dependencies and all run evidence.

For `QA_AI_PROVIDER=codex-cli`, first create the dedicated file-backed ChatGPT login using the [Codex setup instructions](../README.md#optional-model-review). Compose mounts `$HOME/.codex-qa` at `/opt/codex-qa` and sets the container's `CODEX_HOME` and `QA_CODEX_BIN` to its installed CLI. If your dedicated login is elsewhere, export its absolute host path before running Compose:

```sh
export MPC_CODEX_HOME="$HOME/.codex-qa"
docker compose run --rm --no-deps automation codex -c 'cli_auth_credentials_store="file"' login status
```

The login mount is writable so session credentials can refresh. Keep it outside the checkout and use a QA-specific directory without global `AGENTS.md` files. The image includes only the CLI; credentials stay on the host. API-based AI providers do not require a Codex login.

For the application's UAT scenarios, prepare its Linux dependencies and matching browser once, and repeat after its lockfile/Playwright version changes:

```sh
docker compose run --rm --no-deps automation sh -lc \
  'cd "$MPC_WEBAPP_PATH" && pnpm install --frozen-lockfile && pnpm exec playwright install chromium'
```

Start or verify the test target using its configured Compose project and ports:

```sh
docker compose run --rm --no-deps automation npm run stack:up
docker compose run --rm --no-deps automation npm run stack:status
```

The target is the separate application stack selected by the `local-docker` profile in [environments.json](../pipeline/config/environments.json), currently at `http://localhost:3460`. Its containers and volumes are not part of the automation Compose project, so stopping automation leaves the application data intact.

## Dashboard, tests and Slack scheduler

Stop the existing host dashboard and scheduler before starting the container; the dashboard port and application state must have one automation owner.

```sh
docker compose up -d automation
docker compose logs automation
docker compose exec automation npm run qa:scheduler:status
docker compose exec automation npm run qa:full
```

Open the private dashboard link printed in the logs. Compose uses port **4501** by default, or `QA_DASHBOARD_PORT` from your environment. Keep the private link and logs within the team. From a remote machine, forward the selected port, for example `ssh -L 4501:127.0.0.1:4501 your-qa-host`, then open the logged link locally.

The scheduler runs in the foreground alongside the dashboard and uses [the existing schedules](../pipeline/config/schedules.json). It publishes through the existing Slack configuration and durable outbox. Do not run `qa:scheduler:start` inside the container: the service supervisor already owns that process. A service failure stops its peer and fails the container so Compose can restart it. `docker compose stop` signals the service process groups and waits for shutdown.

To run only the dashboard without scheduled execution or Slack sends triggered by schedules:

```sh
QA_SCHEDULER_ENABLED=0 docker compose up -d automation
```

Manual test runs still follow the normal Slack notification policy. Run additional commands with `docker compose exec`, so they share the dashboard/scheduler PID namespace and execution locks. Do not start another automation container, or run the host automation commands, against the same application stack concurrently.

Container reports, private evidence, scheduler state and locks persist in **`runs/container/`** on the host. They are separate from earlier host-run history. Locks and scheduled workers record their Linux PID namespace and process birth time so a restarted container cannot mistake a reused PID for the previous live owner. Application dependencies and browser downloads persist in Compose volumes.

After rebuilding for an automation dependency/Playwright upgrade, rerun the `npx playwright install chromium` Compose command above before starting the service. The browser volume survives image replacement and needs the new automation revision installed explicitly. After an application Playwright upgrade, rerun its separate pnpm install/browser command too; both repositories can require different browser revisions.

```sh
docker compose stop automation
docker compose down
```

## Verify the automation image

The runner can also be built without the application checkout:

```sh
docker build -t mpc-automation:local .
docker run --rm --init mpc-automation:local npm run typecheck
docker run --rm --init mpc-automation:local npm run test:reporting
docker run --rm --init --shm-size=1g mpc-automation:local npm run test:dashboard
```

These commands validate the automation itself, not the target application's functional or performance outcomes. A plain `docker run mpc-automation:local` starts only the dashboard; the Compose configuration enables the scheduler and supplies the host integration needed for local full-suite execution.
