import { config, resolveEnvironment, isLoopback } from '../lib/env.mjs'

const list = value => [...new Set(String(value || '').split(/[\s,]+/).filter(Boolean))]
export function agentSettings(env = process.env) {
  return {
    enabled: env.QA_SLACK_AGENT_ENABLED === '1',
    team: env.QA_SLACK_TEAM_ID || '', channel: env.SLACK_CHANNEL_ID || '',
    channels: list(env.QA_SLACK_ALLOWED_CHANNEL_IDS || env.SLACK_CHANNEL_ID),
    allowDms: env.QA_SLACK_ALLOW_DMS === '1',
    allowedUsers: list(env.QA_SLACK_ALLOWED_USER_IDS || env.QA_OWNER_SLACK_ID),
    suites: list(env.QA_SLACK_ALLOWED_SUITES || 'smoke api regression uat load full'),
    environments: list(env.QA_SLACK_ALLOWED_ENVIRONMENTS || 'local-docker'),
    ai: env.QA_SLACK_AGENT_AI === '1',
  }
}
export function conversationAllowed(channel, settings) {
  if(/^D[A-Z0-9]+$/.test(channel||''))return settings.allowDms===true
  return /^[CG][A-Z0-9]+$/.test(channel||'') && (settings.channels.includes('*')||settings.channels.includes(channel))
}
export function authorize(identity, settings, rerun = false) {
  return settings.enabled && /^T[A-Z0-9]+$/.test(settings.team)
    && identity.team === settings.team && conversationAllowed(identity.channel,settings)
    && /^[UW][A-Z0-9]+$/.test(identity.user || '') && !identity.bot
    && (!rerun || settings.allowedUsers.includes(identity.user))
}
export function validateTarget(suite, environment, settings) {
  if (!settings.suites.includes(suite) || !Object.hasOwn(config.suites(), suite)) throw new Error('Suite is not allowed.')
  if (!settings.environments.includes(environment)) throw new Error('Environment is not allowed.')
  const target = resolveEnvironment(environment)
  if (!target.isolated || !isLoopback(target.baseUrl)) throw new Error('Slack reruns require an isolated loopback environment.')
  return target
}
export function validateSettings(settings) {
  if (!settings.enabled || !/^T[A-Z0-9]+$/.test(settings.team) || (!settings.channels.length&&!settings.allowDms))
    throw new Error('Enable the Slack agent and configure QA_SLACK_TEAM_ID plus allowed channels or DMs.')
  if(settings.channels.some(id=>!(/^[CG][A-Z0-9]+$/.test(id)||id==='*')) || (settings.channels.includes('*')&&settings.channels.length!==1))
    throw new Error('Invalid Slack channel allowlist; use channel IDs or * alone.')
  if (settings.allowedUsers.some(id => !/^[UW][A-Z0-9]+$/.test(id))) throw new Error('Invalid Slack rerun user allowlist.')
  for (const suite of settings.suites) for (const env of settings.environments) validateTarget(suite, env, settings)
}
