import { isLoopback, resolveEnvironment } from './env.mjs'

/** Resolve the verified QA target without mutating the supplied profile. */
export function webTestEnvironment(profile = resolveEnvironment('local-docker')) {
  if (!profile.isolated || !isLoopback(profile.baseUrl) || !profile.stack) {
    throw new Error('Web fixture setup requires an isolated local stack')
  }
  const verified = resolveEnvironment('web-isolated')
  return {
    ...profile, ...verified, name: 'web-isolated',
    allowWrites: true, navigation: 'activities',
    stack: { ...verified.stack, ports: { ...verified.stack.ports } },
  }
}
