import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { agentSettings, authorize, validateSettings } from '../../pipeline/slack-agent/policy.mjs'

// Open-question configuration: any team member in a joined channel or DM can ask; only listed users can rerun or draft.
const env = {
  QA_SLACK_AGENT_ENABLED: '1', QA_SLACK_TEAM_ID: 'T123', QA_SLACK_ALLOWED_CHANNEL_IDS: '*',
  QA_SLACK_ALLOW_DMS: '1', QA_SLACK_ALLOWED_USER_IDS: 'U123',
}

test('wildcard channel config is valid and lets any team member ask questions', () => {
  const settings = agentSettings(env)
  assert.doesNotThrow(() => validateSettings(settings))
  assert.equal(authorize({ team: 'T123', channel: 'C999', user: 'U999' }, settings), true)
  assert.equal(authorize({ team: 'T123', channel: 'D999', user: 'U999' }, settings), true)
})

test('questions stay limited to the configured workspace and humans', () => {
  const settings = agentSettings(env)
  assert.equal(authorize({ team: 'T000', channel: 'C999', user: 'U999' }, settings), false)
  assert.equal(authorize({ team: 'T123', channel: 'C999', user: 'U999', bot: true }, settings), false)
  assert.equal(authorize({ team: 'T123', channel: 'C999', user: 'BOTX' }, settings), false)
})

test('reruns and test drafts still require the user allowlist', () => {
  const settings = agentSettings(env)
  assert.equal(authorize({ team: 'T123', channel: 'C999', user: 'U999' }, settings, true), false)
  assert.equal(authorize({ team: 'T123', channel: 'C999', user: 'U123' }, settings, true), true)
})

test('render blueprint opens questions to everyone but keeps the agent switched off', () => {
  const yaml = readFileSync(fileURLToPath(new URL('../../render.yaml', import.meta.url)), 'utf8')
  assert.match(yaml, /QA_SLACK_AGENT_ENABLED, value: "0"/)
  assert.match(yaml, /QA_SLACK_ALLOWED_CHANNEL_IDS, value: "\*"/)
  assert.match(yaml, /QA_SLACK_ALLOW_DMS, value: "1"/)
  assert.match(yaml, /QA_SLACK_ALLOWED_USER_IDS, sync: false/)
})
