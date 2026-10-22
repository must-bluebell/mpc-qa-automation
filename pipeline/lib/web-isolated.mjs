import { isLoopback, resolveEnvironment } from './env.mjs'

/** Resolve the verified QA target without mutating the supplied profile. */
export function webTestEnvironment(profile = resolveEnvironment('web-isolated')) {
  if (!profile.isolated || !isLoopback(profile.baseUrl) || !profile.stack) {
    throw new Error('Web fixture setup requires an isolated local stack')
  }
  return {
    ...profile, name: 'web-isolated',
    allowWrites: true, navigation: 'activities',
    stack: { ...profile.stack, ports: { ...profile.stack.ports } },
  }
}
