// Pinned Unity rules/economy and rules/limits contract (see reference/unity-dig-screen.md).
// A magnet can yield two cart lines per dig; budget for that even without the upgrade.
const CART_CAPACITY = 100
const CART_RUNS_PER_DAY = 2
const MAX_ITEMS_PER_DIG = 2

/** Call only after verifying an empty cart. A non-null reason blocks all fresh digs. */
export function cartPreflight(available: number, script: ReadonlyArray<{ t: string }>): string | null {
  if (!Number.isSafeInteger(available) || available <= 0) return 'Invalid or empty dig allowance'
  if (available > Math.floor(CART_CAPACITY / MAX_ITEMS_PER_DIG)) {
    return 'Cart capacity cannot hold every available dig including bonus items'
  }
  // dayTurn resets the app's daily run counters. Count every settle conservatively,
  // including pending records: a receipt must not be required to reserve a run.
  let used = 0
  for (const move of script) {
    if (move.t === 'dayTurn') used = 0
    else if (move.t === 'settle') used++
  }
  if (used >= CART_RUNS_PER_DAY) return 'No cart runs remain for the final send'
  return null
}
