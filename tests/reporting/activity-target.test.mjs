import test from 'node:test'
import assert from 'node:assert/strict'
import { activityFixtureContainer } from '../../pipeline/lib/activity-target.mjs'
const env = { QA_ENVIRONMENT: 'local-docker', QA_ALLOW_WRITES: '1', QA_WEB_FIXTURE_PROJECT: 'mpc-qa-new', QA_WEB_FIXTURE_CONTAINER: 'mpc-qa-new-web-1' }
const profiles = { 'local-docker': { stack: { composeProject: 'mpc-qa-old' } } }
test('reviewer runtime project takes precedence over stale test checkout configuration', () => {
  assert.equal(activityFixtureContainer(env, profiles, 'http://localhost:3461'), 'mpc-qa-new-web-1')
})
test('direct tests retain configured project validation', () => {
  assert.equal(activityFixtureContainer({ ...env, QA_WEB_FIXTURE_PROJECT: undefined, QA_WEB_FIXTURE_CONTAINER: 'mpc-qa-old-web-1' }, profiles, 'http://localhost:3461'), 'mpc-qa-old-web-1')
})
test('runtime configuration never permits remote, production, disabled writes, or mismatched containers', () => {
  for (const override of [{ QA_ENVIRONMENT: 'production' }, { QA_ALLOW_WRITES: '0' }, { QA_WEB_FIXTURE_CONTAINER: 'other-web-1' }, { QA_WEB_FIXTURE_PROJECT: '../other' }]) {
    assert.throws(() => activityFixtureContainer({ ...env, ...override }, profiles, 'http://localhost:3461'), /dedicated isolated/)
  }
  assert.throws(() => activityFixtureContainer(env, profiles, 'https://app.globalmpc.tech'), /dedicated isolated/)
})
