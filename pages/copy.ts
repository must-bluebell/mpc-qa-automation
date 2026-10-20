/**
 * The app's on-screen copy, vendored.
 *
 * Every locator in this suite finds elements by **accessible name**, and in globalmpc-webapp those
 * names come from a typed registry at `lib/messages/en.ts`. Ideally we would import that registry
 * directly — it is typed, and a copy change would then break compilation here. A standalone repo
 * cannot reach across into it, so the strings are copied and `npm run check:copy` verifies they
 * still exist in the source. See scripts/check-copy.mjs.
 *
 * 🔴 **Do not paraphrase or "tidy" a string here.** These are match keys, not prose. A string that
 *    drifts from the app silently stops matching, and the test fails as though the app broke.
 * 🔴 Note the ellipses are the single character `…`, not three dots. Retyping them breaks matching.
 *
 * Source of truth: globalmpc-webapp/lib/messages/en.ts
 */
export const copy = {
  ui: {
    copyAddress: 'Copy address',
  },

  landing: {
    join: 'Join the waitlist',
  },

  join: {
    /** `Modal` renders `aria-label={label}` on the native <dialog>, and JoinFlow passes `t.title`. */
    title: 'Join',

    // ── Step names. StepBar carries these as the progressbar's accessible name, so they are how
    //    the suite asserts which step the flow is standing on. JoinFlow.tsx:1182
    stepWallet: 'Wallet',
    stepSign: 'Sign',
    stepSocial: 'Community',

    // ── Connect step
    connect: 'Connect Wallet',
    connectLede: 'Choose a wallet to continue. You will sign in after it connects.',
    connectDetecting: 'Looking for installed wallets…',
    connectWalletConnect: 'WalletConnect',
    connectOtherWallets: 'View other wallets',
    connecting: 'Connecting…',
    connectDefaultWallet: 'Browser wallet',

    // ── Sign step
    signIn: 'Sign in',
    signing: 'Sign in wallet…',
    signingHint: 'Confirm the signature in your wallet.',
    switchChain: 'Switch network',

    // ── Failure copy. These are the 15 cells of JoinFlow's `failureTextOf` table that the mock
    //    drives in tests/wallet/wallet-errors.spec.ts. The `switch` axis is a function of chain name,
    //    so it is built at assertion time rather than stored here.
    failRejected: 'The request was cancelled in your wallet. Try again when you are ready.',
    /**
     * 🔴 On the **connect** axis this is the string that actually appears, not `failNoWallet`.
     *    `connectFailureText` swaps in the WalletConnect wording whenever a fallback connector
     *    exists, and one always does — `lib/wagmi.ts` throws at startup if WalletConnect is
     *    missing. So `failNoWallet` is unreachable from a connect failure. (JoinFlow.tsx:634)
     */
    failNoWalletWithWc: 'No browser wallet found. On mobile, connect with WalletConnect.',
    failNoWallet: 'No browser wallet found. Install a wallet extension and refresh.',
    failLocked: 'Your wallet is locked. Unlock it and try again.',
    failPending: 'Your wallet already has a pending request. Check that window.',
    failUnknown: 'Could not connect. Please try again shortly.',
    signRejected: 'The signature was cancelled in your wallet. Please try again.',
    signFailed: 'Could not sign in. Please try again.',

  },
} as const

/**
 * Failure copy on the switch-chain axis, which `en.ts` stores as functions of the chain name.
 * The chain display name comes from config/target.ts.
 */
export const switchCopy = {
  wrongChain: (chain: string) =>
    `Could not switch to the ${chain} network. Switch it in your wallet and try again.`,
  switchRejected: (chain: string) => `Network switch cancelled. Signing is only possible on ${chain}.`,
} as const

/** The accessible name of the address chip: `aria-label={`${t.copyAddress} ${value}`}` (Address.tsx). */
export const addressChipName = (address: string): string =>
  `${copy.ui.copyAddress} ${address.toLowerCase()}`
