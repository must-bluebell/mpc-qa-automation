import { isLoopback, resolveEnvironment } from './env.mjs'

/** Resolve the verified QA target without mutating the supplied profile. */
export function webTestEnvironment(profile = resolveEnvironment('local-docker')) {
  if (!profile.isolated || !isLoopback(profile.baseUrl) || !profile.stack) {
    throw new Error('Web fixture setup requires an isolated local stack')
  }
  return {
    ...profile, name: 'web-isolated', baseUrl: 'http://localhost:3420', appOrigin: 'http://localhost:3420',
    allowWrites: true, navigation: 'activities',
    stack: { ...profile.stack, composeProject: 'mpc-qa-web-20261015',
      ports: { web: 3420, anvil: 8565, opbnbAnvil: 8566, postgres: 5450, neonProxy: 4464 } },
  }
}
