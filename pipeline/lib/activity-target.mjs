/** Resolve the fixture target only for explicitly write-enabled isolated local tests. */
export function activityFixtureContainer(env, environments, baseUrl) {
  const project = env.QA_WEB_FIXTURE_PROJECT ?? environments[env.QA_ENVIRONMENT ?? '']?.stack?.composeProject
  const container = env.QA_WEB_FIXTURE_CONTAINER
  if (!['web-isolated', 'local-docker'].includes(env.QA_ENVIRONMENT ?? '') || env.QA_ALLOW_WRITES !== '1'
    || !['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname)
    || !/^[a-z0-9][a-z0-9_-]*$/.test(project ?? '') || container !== `${project}-web-1`) {
    throw new Error('Stored Activity fixtures require the dedicated isolated web stack')
  }
  return container
}
