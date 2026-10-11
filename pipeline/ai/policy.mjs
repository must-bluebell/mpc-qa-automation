// Dashboard choices are explicit. Missing CLI choices inherit automatic review.
export function aiArgs(choice) {
  return choice === true ? ['--ai'] : choice === false ? ['--no-ai'] : []
}

export function shouldReview(choice, run, env = process.env) {
  return choice ?? (env.QA_AI_AUTO === '1' && ['failed', 'infra-failed', 'timeout', 'blocked', 'crashed'].includes(run.status))
}
