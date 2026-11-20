import type { APIResponse } from '@playwright/test'
type Options = { production?: boolean; onThrottle?: () => void }
type FetchApi = (path: string, send: () => Promise<APIResponse>, options?: Options) => Promise<APIResponse>
export function createApiFetcher(options?: { now?: () => number; wait?: (ms: number) => Promise<void> }): FetchApi
export const fetchApi: FetchApi
