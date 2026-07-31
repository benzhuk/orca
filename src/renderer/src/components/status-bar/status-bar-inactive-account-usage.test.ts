import { describe, expect, it } from 'vitest'
import type { InactiveAccountUsage } from '../../../../shared/rate-limit-types'
import { resolveInactiveAccountUsage } from './StatusBar'

function usageOf(accountId: string, usedPercent: number): InactiveAccountUsage {
  return {
    accountId,
    rateLimits: {
      provider: 'claude',
      session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    },
    updatedAt: 1,
    isFetching: false
  }
}

describe('resolveInactiveAccountUsage', () => {
  it('keeps the local rate-limit store when this desktop owns the accounts', () => {
    const local = [usageOf('local-1', 10)]
    const snapshot = [usageOf('remote-1', 90)]

    expect(resolveInactiveAccountUsage(false, snapshot, local)).toBe(local)
  })

  it('uses the remote snapshot usage when a remote server owns the accounts', () => {
    const local = [usageOf('local-1', 10)]
    const snapshot = [usageOf('remote-1', 90)]

    expect(resolveInactiveAccountUsage(true, snapshot, local)).toBe(snapshot)
  })

  it('never falls back to local usage for a remote roster whose snapshot has none', () => {
    const local = [usageOf('local-1', 10)]

    expect(resolveInactiveAccountUsage(true, undefined, local)).toEqual([])
  })
})
