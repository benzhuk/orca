import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../shared/rate-limit-types'
import type { ClaudeRateLimitAccountsState } from '../shared/types'
import { activeAccountIdSet } from './account-format'

export type ClaudeAccountUsageStatus = 'ok' | 'fetching' | 'error' | 'no-data'

export type ClaudeAccountUsageRow = {
  id: string
  email: string
  organizationName: string | null
  active: boolean
  status: ClaudeAccountUsageStatus
  error: string | null
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

type UsageFields = Pick<ClaudeAccountUsageRow, 'status' | 'error' | 'session' | 'weekly'>

function usageFields(usage: ProviderRateLimits | null, isFetching: boolean): UsageFields {
  if (isFetching || usage?.status === 'fetching') {
    return { status: 'fetching', error: null, session: null, weekly: null }
  }
  if (!usage) {
    return { status: 'no-data', error: null, session: null, weekly: null }
  }
  if (usage.status === 'error') {
    return { status: 'error', error: usage.error, session: usage.session, weekly: usage.weekly }
  }
  if (usage.session === null && usage.weekly === null) {
    return { status: 'no-data', error: usage.error, session: null, weekly: null }
  }
  return { status: 'ok', error: null, session: usage.session, weekly: usage.weekly }
}

/**
 * Builds one usage row per managed Claude account from an `accounts.list` /
 * `accounts.subscribe` snapshot. The active account's usage lives at
 * `rateLimits.claude` (RateLimitService's regular poll target); every other
 * account's lives at `rateLimits.inactiveClaudeAccounts`, which only fills in
 * after a refresh is triggered (see `account-usage-transport.ts`) — absent
 * there, an account renders as 'no-data' rather than a crash.
 */
export function buildClaudeAccountUsageRows(
  claude: ClaudeRateLimitAccountsState,
  rateLimits: RateLimitState | null
): ClaudeAccountUsageRow[] {
  const activeIds = activeAccountIdSet(claude)
  const inactiveById = new Map(
    (rateLimits?.inactiveClaudeAccounts ?? []).map((entry) => [entry.accountId, entry] as const)
  )
  return claude.accounts.map((account) => {
    const active = activeIds.has(account.id)
    const inactiveEntry = inactiveById.get(account.id)
    const usage = active ? (rateLimits?.claude ?? null) : (inactiveEntry?.rateLimits ?? null)
    const isFetching = active ? false : (inactiveEntry?.isFetching ?? false)
    return {
      id: account.id,
      email: account.email,
      organizationName: account.organizationName ?? null,
      active,
      ...usageFields(usage, isFetching)
    }
  })
}

/** True once every row has settled (none stuck 'fetching') — the signal to stop waiting. */
export function isClaudeAccountUsageComplete(rows: readonly ClaudeAccountUsageRow[]): boolean {
  return rows.every((row) => row.status !== 'fetching')
}
