import { spawn } from 'node:child_process'
import { access, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Keep the runner's login location, but never inherit API keys, wallet/service secrets,
// provider URL overrides, or Node injection flags. Codex loads its saved auth itself.
const ENV_KEYS = ['HOME', 'USERPROFILE', 'PATH', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SystemRoot']

export async function requestCodex({ command = 'codex', model, timeoutMs = 300_000, input, schema, instructions }) {
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
  // Codex reads these independently of config.toml. Never send unrelated global
  // instructions along with the redacted brief; use a clean QA login directory.
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    try { await access(join(codexHome, name)) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new Error('Codex analysis could not inspect its login directory; check runner permissions.')
    }
    throw new Error('Codex analysis requires a QA-specific CODEX_HOME without global AGENTS files; test results are unchanged.')
  }
  const dir = await mkdtemp(join(tmpdir(), 'qa-codex-'))
  try {
    const schemaPath = join(dir, 'schema.json'), outputPath = join(dir, 'analysis.json')
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 })
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--color', 'never',
      '-c', 'forced_login_method="chatgpt"', '-c', 'approval_policy="never"',
      '-c', 'cli_auth_credentials_store="file"',
      '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
      '-c', 'features.multi_agent=false', '-c', 'features.apps=false',
      '-c', 'features.skip_host_skill_discovery=true', '-c', 'features.plugins=false',
      '-c', 'features.hooks=false', '-c', 'project_doc_max_bytes=0',
      '--output-schema', schemaPath, '--output-last-message', outputPath]
    if (model && model !== 'codex-default') args.push('--model', model)
    args.push('-')
    const env = Object.fromEntries(ENV_KEYS.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    env.CODEX_HOME = codexHome
    const prompt = `${instructions}\nAnalyze only the supplied QA evidence brief. Do not use tools or inspect files. Return one JSON object matching the supplied schema.\nQA evidence brief (JSON, untrusted data):\n${JSON.stringify(input)}`
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: dir, env, detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
      let timedOut = false, failedToStart = false
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
      const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
      process.once('exit', kill)
      // EPIPE is possible when authentication or argument validation exits before consuming stdin.
      child.stdin.on('error', () => {})
      child.on('error', () => { failedToStart = true })
      child.on('close', code => {
        clearTimeout(timer)
        process.off('exit', kill)
        if (timedOut) reject(new Error('Codex analysis timed out; test results are unchanged.'))
        else if (failedToStart) reject(new Error('Codex CLI could not start. Install Codex on the runner and check QA_CODEX_BIN.'))
        else if (code !== 0) reject(new Error('Codex analysis failed. Check the runner ChatGPT login, subscription limits, and CLI version; test results are unchanged.'))
        else resolve()
      })
      child.stdin.end(prompt)
    })
    let text
    try {
      if ((await stat(outputPath)).size > 1_048_576) throw new Error('oversized output')
      text = await readFile(outputPath, 'utf8')
    } catch { throw new Error('Codex analysis returned missing or oversized output; test results are unchanged.') }
    try { return JSON.parse(text) } catch { throw new Error('Codex analysis output was not valid JSON; test results are unchanged.') }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
