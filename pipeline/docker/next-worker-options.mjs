/** Use the app's existing CI compiler eviction settings in the server child only. */
export function nextWorkerOptions(modulePath, options = {}) {
  if (!String(modulePath).endsWith('/next/dist/server/lib/start-server.js')) return options
  return { ...options, env: { ...(options.env ?? process.env), SCENARIO_ON_RUNNER: '1', QA_LOCAL_LOAD: '0' } }
}
