import { describe, expect, it } from 'vitest'
import { buildClaudeAccountUsageRows, isClaudeAccountUsageComplete } from './account-usage'
import type { ProviderRateLimits, RateLimitState } from '../shared/rate-limit-types'
import type { ClaudeRateLimitAccountsState } from '../shared/types'

function claudeAccounts(
  accounts: ClaudeRateLimitAccountsState['accounts'],
  activeAccountId: string | null
): ClaudeRateLimitAccountsState {
  return {
    accounts,
    activeAccountId,
    activeAccountIdsByRuntime: { host: activeAccountId, wsl: {} }
  }
}

function usage(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 42, windowMinutes: 300, resetsAt: 1000, resetDescription: '2:30 PM' },
    weekly: { usedPercent: 18, windowMinutes: 10080, resetsAt: 2000, resetDescription: 'Thu' },
    updatedAt: 1,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function rateLimitState(overrides: Partial<RateLimitState> = {}): RateLimitState {
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: [],
    ...overrides
  }
}

describe('buildClaudeAccountUsageRows', () => {
  it('reads the active account usage from rateLimits.claude', () => {
    const claude = claudeAccounts([{ id: 'a', email: 'a@x.com' } as never], 'a')
    const rows = buildClaudeAccountUsageRows(claude, rateLimitState({ claude: usage() }))

    expect(rows).toEqual([
      {
        id: 'a',
        email: 'a@x.com',
        organizationName: null,
        active: true,
        status: 'ok',
        error: null,
        session: usage().session,
        weekly: usage().weekly
      }
    ])
  })

  it('reads an inactive account usage from rateLimits.inactiveClaudeAccounts by id', () => {
    const claude = claudeAccounts(
      [{ id: 'a', email: 'a@x.com' } as never, { id: 'b', email: 'b@x.com' } as never],
      'a'
    )
    const rows = buildClaudeAccountUsageRows(
      claude,
      rateLimitState({
        claude: usage(),
        inactiveClaudeAccounts: [
          { accountId: 'b', rateLimits: usage({ session: null }), updatedAt: 1, isFetching: false }
        ]
      })
    )

    const b = rows.find((row) => row.id === 'b')
    expect(b).toMatchObject({ active: false, status: 'ok', session: null })
  })

  it('marks an inactive account still fetching, even with stale cached rateLimits', () => {
    const claude = claudeAccounts([{ id: 'b', email: 'b@x.com' } as never], null)
    const rows = buildClaudeAccountUsageRows(
      claude,
      rateLimitState({
        inactiveClaudeAccounts: [
          { accountId: 'b', rateLimits: usage(), updatedAt: 1, isFetching: true }
        ]
      })
    )

    expect(rows[0]).toMatchObject({ status: 'fetching', session: null, weekly: null })
  })

  it('marks an account with no rateLimits entry at all as no-data', () => {
    const claude = claudeAccounts([{ id: 'b', email: 'b@x.com' } as never], null)
    const rows = buildClaudeAccountUsageRows(claude, rateLimitState())

    expect(rows[0]).toMatchObject({ status: 'no-data', session: null, weekly: null })
  })

  it('surfaces a provider error message', () => {
    const claude = claudeAccounts([{ id: 'a', email: 'a@x.com' } as never], 'a')
    const rows = buildClaudeAccountUsageRows(
      claude,
      rateLimitState({
        claude: usage({ status: 'error', error: 'stale token', session: null, weekly: null })
      })
    )

    expect(rows[0]).toMatchObject({ status: 'error', error: 'stale token' })
  })

  it('treats a null rateLimits snapshot as no-data for every account, not a crash', () => {
    const claude = claudeAccounts([{ id: 'a', email: 'a@x.com' } as never], 'a')
    const rows = buildClaudeAccountUsageRows(claude, null)

    expect(rows[0].status).toBe('no-data')
  })

  it('carries the organization name through when present', () => {
    const claude = claudeAccounts(
      [{ id: 'a', email: 'a@x.com', organizationName: 'BTO' } as never],
      'a'
    )
    const rows = buildClaudeAccountUsageRows(claude, rateLimitState({ claude: usage() }))

    expect(rows[0].organizationName).toBe('BTO')
  })
})

describe('isClaudeAccountUsageComplete', () => {
  it('is false while any row is still fetching', () => {
    expect(
      isClaudeAccountUsageComplete([
        {
          id: 'a',
          email: 'a@x.com',
          organizationName: null,
          active: true,
          status: 'ok',
          error: null,
          session: null,
          weekly: null,
        fable: null
        },
        {
          id: 'b',
          email: 'b@x.com',
          organizationName: null,
          active: false,
          status: 'fetching',
          error: null,
          session: null,
          weekly: null,
        fable: null
        }
      ])
    ).toBe(false)
  })

  it('is true once every row has settled, including no-data / error rows', () => {
    expect(
      isClaudeAccountUsageComplete([
        {
          id: 'a',
          email: 'a@x.com',
          organizationName: null,
          active: true,
          status: 'ok',
          error: null,
          session: null,
          weekly: null,
        fable: null
        },
        {
          id: 'b',
          email: 'b@x.com',
          organizationName: null,
          active: false,
          status: 'no-data',
          error: null,
          session: null,
          weekly: null,
        fable: null
        },
        {
          id: 'c',
          email: 'c@x.com',
          organizationName: null,
          active: false,
          status: 'error',
          error: 'boom',
          session: null,
          weekly: null,
        fable: null
        }
      ])
    ).toBe(true)
  })

  it('is true for an empty roster', () => {
    expect(isClaudeAccountUsageComplete([])).toBe(true)
  })
})
