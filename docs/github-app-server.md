# GitHub App listener on a server

Runs `/automation review` and the pull request trigger without your Mac. The listener, the review runner and Caddy (HTTPS) run in Docker on a Linux server you control. Reviews test a fixed chain-97 deployment (`target.baseUrl`), so they need no local Docker stack.

Files: [deploy/github-app/](../deploy/github-app/) (`Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.example`). The App logic is unchanged; see [github-app.md](github-app.md) for behaviour.

## 1. Prepare the server

- Linux with Docker Engine and the Compose plugin (`docker compose version`).
- Open inbound ports **80** and **443**. Caddy uses 80 for the certificate challenge.
- Create a DNS record `qa.<your-domain>` → the server's public IP. Wait until it resolves (`dig +short qa.<your-domain>`).

## 2. Put the code on the server

```sh
git clone https://github.com/globalmpc/mpc-automation.git /srv/mpc-automation
cd /srv/mpc-automation && git checkout main
```

Use `main` after PR #13 has merged so the server includes the automatic-trigger changes.

## 3. Add the secrets (never committed)

```sh
cd /srv/mpc-automation/deploy/github-app
mkdir -p secrets && chmod 700 secrets
cp /path/to/mpc-qa-automation.<date>.private-key.pem secrets/github-app.pem && chmod 600 secrets/github-app.pem
cp .env.example .env && chmod 600 .env        # then fill in the values
```

`.env` needs `QA_PUBLIC_HOST`, `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `QA_SEED_PHRASE`, `WALLET_ADDRESS` and `WALLET_ADDRESS_INDEX`. Copy the values from your Mac's `.env`; do not copy the rest of it.

Set `QA_HOST_RUNS_DIR` to the scheduler's absolute runs directory (for example `/srv/mpc-automation/runs`), and `QA_UID`/`QA_GID` to the numeric UID/GID of the host user running both the scheduler and Actions runner (`id -u` / `id -g`). Create that directory as the QA user before starting Compose. Ensure that user can read the private key and policy file. Compose requires the directory to exist and binds it at `/app/runs`; the listener uses the host PID namespace so all wallet consumers share `/app/runs/.locks` and can check lock-owner liveness. Set the Actions repository variable `QA_PIPELINE_LOCK_DIR` to the host path, for example `/srv/mpc-automation/runs/.locks`. This deployment requires native Linux Docker Engine on the runner host, not a separate Docker Desktop VM.

When migrating from the old `github-app-runs` volume, stop wallet consumers first, copy its contents into the host runs directory, and make the QA user its owner before starting the new deployment. Preserve the listener state so pending jobs can recover.

Create `github-app.repositories.json`. The target must be a `*.vercel.app` root on chain 97:

```json
{
  "testsRepository": "globalmpc/mpc-automation",
  "testsRef": "main",
  "timeoutMinutes": 40,
  "playwrightArgs": ["--project=chromium"],
  "repositories": {
    "MSQ-AI-Testing/demo-repository": { "target": { "baseUrl": "https://<chain-97-deployment>.vercel.app/" } }
  }
}
```

## 4. Start it

```sh
cd /srv/mpc-automation/deploy/github-app
docker compose up -d --build
docker compose ps                       # listener and caddy should be running
docker compose logs -f listener         # look for "listening"
curl -s -o /dev/null -w "%{http_code}\n" https://qa.<your-domain>/   # expect 404 (the proxy works)
```

Check the App's configuration from inside the container:

```sh
docker compose exec listener node pipeline/github-app/doctor.mjs
```

## 5. Switch the webhook (cutover)

GitHub sends webhooks to one URL, so switch once the server is running:

1. Stop the Mac listener and ngrok: `npm run qa:github-app` (Ctrl+C) and the ngrok process.
2. App settings → General → Webhook URL: `https://qa.<your-domain>/webhooks/github`. Secret: the same `GITHUB_WEBHOOK_SECRET` as in `.env`.
3. App settings → Permissions & events: subscribe to both **Issue comment** and **Pull request** events and save the changes.
4. App settings → Advanced → Recent deliveries: redeliver one event, expect 200 or 202.

## Operations

- **Restarts** wait for the review in progress (up to 40 minutes). Unfinished jobs resume on startup, and a crash can repeat one review and comment.
- **Logs:** `docker compose logs -f listener`. Run evidence is in `QA_HOST_RUNS_DIR` on the host (`/app/runs` in the container).
- **Updates:** `git pull && docker compose up -d --build`.
- **Certificates** renew automatically through Caddy.

## Limits

- A fixed `target.baseUrl` tests that deployment, not the PR's code. Reviewing a PR's own code needs a per-PR preview (`previewHostPrefix`) on the web repository, or a local stack that is built from the PR.
- The `local-stack` target is not available on this server.
- Automatic reviews start on opened, reopened, and ready-for-review events, once per head commit. They do not wait for a Vercel preview: if the preview is not ready, comment `/automation review` after deployment finishes. Reopening the same commit does not retry it automatically; pushes do not trigger a run.
