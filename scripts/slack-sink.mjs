#!/usr/bin/env node
import http from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from '../pipeline/lib/env.mjs'

/**
 * Loopback stand-in for a Slack Incoming Webhook, for proving alert delivery without a real workspace.
 * Accepts POST /services/<a>/<b>/<c> on 127.0.0.1 only and appends each Block Kit payload to
 * runs/slack-sink.jsonl. Use with:
 *   SLACK_ALERT_WEBHOOK_URL=http://127.0.0.1:4599/services/TQA/BQA/local QA_SLACK_ALLOW_LOOPBACK=1
 */
const PORT = Number(process.env.QA_SLACK_SINK_PORT || 4599)
mkdirSync(RUNS_DIR, { recursive: true })
const out = join(RUNS_DIR, 'slack-sink.jsonl')

http.createServer((req, res) => {
  if (req.method !== 'POST' || !/^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(req.url)) { res.writeHead(404); return res.end() }
  let size = 0
  const chunks = []
  req.on('data', c => { size += c.length; if (size > 64_000) req.destroy(); else chunks.push(c) })
  req.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), payload })}\n`, { mode: 0o600 })
      console.log(`slack-sink: ${payload.text?.slice(0, 160)}`)
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    } catch { res.writeHead(400).end('invalid_payload') }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`slack-sink listening on http://127.0.0.1:${PORT}/services/TQA/BQA/local`))
