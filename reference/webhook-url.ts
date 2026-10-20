/** Validates a Slack Incoming Webhook URL without making a network request. */
export function isSlackWebhookUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  return url.protocol === 'https:'
    && ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
    && /^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)
    && !url.search
    && !url.hash
    && !url.username
    && !url.password
}
