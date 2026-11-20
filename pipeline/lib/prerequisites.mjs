// Only recognized prerequisite templates are published; arbitrary errors remain private.
export function prerequisiteReason(reason) {
  if (['Expanded API cases require the isolated QA_ALLOW_WRITES=1 environment.',
    'Write checks run only on an isolated environment (QA_ALLOW_WRITES=1).'].includes(reason)) {
    return 'Requires a writable isolated QA environment. This target is read-only; production write protections prevented execution.'
  }
  if (/^Requires QA_API_CASES_FILE entry API\d{3}\.success with seeded inputs and an exact response contract\.$/.test(reason ?? '')) {
    return 'Missing seeded API success fixture in QA_API_CASES_FILE; configure inputs and an exact response contract on the isolated target.'
  }
  if (reason === 'Requires an isolated administrator storageState file in QA_API_ADMIN_STATE_FILE' || reason === 'Requires QA_API_ADMIN_STATE_FILE') {
    return 'Missing isolated administrator session fixture (QA_API_ADMIN_STATE_FILE).'
  }
  if (reason === 'Requires isolated QA_API_CRON_SECRET') return 'Missing isolated cron authentication fixture (QA_API_CRON_SECRET).'
  if (reason === 'Isolated join policy requires email OTP; provide an OTP fixture for that workflow.') return 'Missing email OTP fixture required by the isolated registration policy.'
  if (reason === 'Requires matching source or explicit environment contract; snapshot omits the response or configuration gate.') return 'Missing baseline API response contract; configure an exact expectation from the matching application source.'
  if (reason === 'Join policy runs before authentication. Configure baseline 401/not_signed_in when skipEmailOtp=true, otherwise 403/otp_required.') return 'Missing registration policy contract; configure the baseline for the isolated target’s email OTP policy.'
  return null
}
