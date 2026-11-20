import type { Expected, Contract } from './api-contracts'
export type SuccessCase = { auth: 'anonymous' | 'wallet' | 'admin' | 'cron' | 'fixture'; path: string; body?: unknown; headers?: Record<string, string>; expected: Expected; storageStateEnv?: string }
export type ApiCase = { baseline?: Expected; success?: SuccessCase }
export function isHostedReadSuccess(contract: Contract, fixture: SuccessCase | undefined, configured?: boolean): boolean
export function isHostedReadBaseline(contract: Contract, configured?: boolean): boolean
export function assertIsolatedTarget(baseUrl: string, allowWrites?: string): void
export function validateExpected(expected: Expected): void
export function loadApiCases(path: string | undefined, catalog: Contract[]): Record<string, ApiCase>

export function assertApiWriteTarget(baseUrl: string, allowWrites?: string, options?: {productionApiWrites?: boolean; environment?: string}): void
