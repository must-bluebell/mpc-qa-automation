# Read-only results site (Vercel)

The QA dashboard (`npm run dashboard`) is a local control panel. It cannot run on Vercel because it binds to loopback, starts test processes and reads `runs/` from disk. This site is a separate, read-only copy of recent results that a team can open in a browser.

## What is published

`npm run dashboard:site` writes `vercel-site/` (git-ignored) with:

- `index.html`, `app.js`, `style.css`: the static viewer, from `dashboard/read-only/`.
- `data/runs.json`: the run list (most recent 50 completed runs by default).
- `data/runs/<runId>.json`: one sanitized summary per run.

Each summary comes from `publicSummary()` in `pipeline/lib/safe-output.mjs`. It contains check names, pass/fail counts, requirement IDs, generic failure reasons, load metrics and the app version. It does not contain raw `run.json`, logs, screenshots, traces, wallet addresses or `.env` values. Running, skipped, seeded-defect and report-only runs are excluded. Before writing, the exporter refuses to continue if any configured secret appears in the output.

Options: `npm run dashboard:site -- --limit 20 --out vercel-site`. `--out` must be inside the repository.

## Test locally

```bash
npm run dashboard:site
npx --yes serve vercel-site        # then open the URL it prints
node --test tests/dashboard/export-site.test.mjs
```

## Deploy to Vercel

Deploy only the `vercel-site/` folder. Never run `vercel` from the repository root, because the root contains `.env`, a private key and `node_modules`.

1. `npm i -g vercel` and `vercel login`.
2. `npm run dashboard:site`.
3. `cd vercel-site && vercel` to create a preview deployment, then check it.
4. `vercel --prod` to publish.
5. In the Vercel project, turn on Deployment Protection (Vercel Authentication) and add team members. Check that your plan includes this. The snapshot shows internal test results and app versions, so do not leave it public.
6. After each run batch, repeat steps 2 and 4 to refresh the data.
