import type { RateLimitState } from '../shared/rate-limit-types'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionCallbacks
} from '../shared/remote-runtime-client'
import type { PairingOffer } from '../shared/pairing'
import type { ClaudeRateLimitAccountsState } from '../shared/types'
import { activeAccountIdSet } from './account-format'
import { buildClaudeAccountUsageRows, isClaudeAccountUsageComplete } from './account-usage'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

/** `~12s` per the design brief: long enough for a healthy refresh, short enough that a broken account can't hang the CLI. */
export const ACCOUNT_USAGE_WAIT_TIMEOUT_MS = 12_000

export type ClaudeAccountsUsageSnapshot = {
  claude: ClaudeRateLimitAccountsState
  rateLimits: RateLimitState | null
}

export type ClaudeAccountUsageFetch = {
  snapshot: ClaudeAccountsUsageSnapshot
  runtimeId: string
  partial: boolean
}

type AccountsSubscribeMessage = {
  type: 'ready' | 'snapshot' | 'end'
  subscriptionId?: string
  snapshot?: ClaudeAccountsUsageSnapshot
}

// Why: the subscribe stream's first frame is the PRE-refresh snapshot (the server
// emits `ready` before it starts refreshAccountsForMobileSubscriber), and an
// inactive account that has never been fetched has NO entry at all — which reads
// as 'no-data', i.e. falsely "settled". Treat a missing entry as still pending so
// the wait actually covers the refresh it just triggered.
function isSettled(snapshot: ClaudeAccountsUsageSnapshot): boolean {
  const activeIds = activeAccountIdSet(snapshot.claude)
  const known = new Set(
    (snapshot.rateLimits?.inactiveClaudeAccounts ?? []).map((entry) => entry.accountId)
  )
  const everyInactiveReported = snapshot.claude.accounts.every(
    (account) => activeIds.has(account.id) || known.has(account.id)
  )
  return (
    everyInactiveReported &&
    isClaudeAccountUsageComplete(buildClaudeAccountUsageRows(snapshot.claude, snapshot.rateLimits))
  )
}

/**
 * Streams `accounts.subscribe` over the remote --environment websocket — the
 * only transport that supports it (see account-usage.md investigation notes
 * in the round-3 report: the local Unix-socket transport's server dispatch
 * rejects streaming methods outright, and its client only ever reads one
 * frame). Resolves as soon as every account settles, or at `timeoutMs` with
 * whatever the last snapshot had (`partial: true`); the socket is always
 * closed before returning, which the server treats as an unsubscribe.
 */
async function fetchViaSubscribe(
  pairing: PairingOffer,
  timeoutMs: number
): Promise<ClaudeAccountUsageFetch> {
  let latest: ClaudeAccountsUsageSnapshot | null = null
  let runtimeId = 'unknown'
  let subscription: RemoteRuntimeSubscription | null = null

  return await new Promise<ClaudeAccountUsageFetch>((resolve, reject) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      subscription?.close()
      if (!latest) {
        reject(
          new RuntimeClientError(
            'runtime_timeout',
            'Timed out waiting for account usage from the remote runtime.'
          )
        )
        return
      }
      resolve({ snapshot: latest, runtimeId, partial: !isSettled(latest) })
    }
    const fail = (error: RuntimeClientError): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      subscription?.close()
      reject(error)
    }
    const deadline = setTimeout(finish, timeoutMs)

    const callbacks: RemoteRuntimeSubscriptionCallbacks<AccountsSubscribeMessage> = {
      onResponse: (response) => {
        if (response.ok === false) {
          fail(new RuntimeClientError(response.error.code, response.error.message))
          return
        }
        if (!response.result.snapshot) {
          return
        }
        latest = response.result.snapshot
        runtimeId = response._meta.runtimeId
        if (isSettled(latest)) {
          finish()
        }
      },
      onError: (error) => fail(new RuntimeClientError(error.code, error.message)),
      onClose: finish
    }

    subscribeRemoteRuntimeRequest<AccountsSubscribeMessage>(
      pairing,
      'accounts.subscribe',
      null,
      timeoutMs,
      callbacks
    )
      .then((sub) => {
        // Why: the deadline can fire while the E2EE handshake is still in flight;
        // without this the settled path's `subscription?.close()` no-ops and this
        // socket (and its server-side subscription) is never released.
        if (settled) {
          sub.close()
          return
        }
        subscription = sub
      })
      .catch((error: unknown) =>
        fail(
          error instanceof RuntimeClientError
            ? error
            : new RuntimeClientError('remote_runtime_unavailable', String(error))
        )
      )
  })
}

/**
 * Bounded one-shot fallback for the local Unix-socket transport, which
 * cannot stream. `accounts.list({ refreshUsage: true })` already awaits the
 * exact same server-side refresh `accounts.subscribe` triggers, so on a
 * healthy host one call returns everything settled — but it is documented
 * (src/renderer/src/runtime/runtime-provider-accounts-client.ts) to "hang for
 * minutes behind broken auth", so this caps that first attempt at
 * `timeoutMs` and, on timeout, falls back to a plain (unbounded, always-fast)
 * read of whatever the still-running server-side refresh has settled so far.
 */
async function fetchViaAccountsList(
  client: RuntimeClient,
  timeoutMs: number
): Promise<ClaudeAccountUsageFetch> {
  try {
    const response = await client.call<ClaudeAccountsUsageSnapshot>(
      'accounts.list',
      { refreshUsage: true },
      { timeoutMs }
    )
    return {
      snapshot: response.result,
      runtimeId: response._meta.runtimeId,
      partial: !isSettled(response.result)
    }
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || error.code !== 'runtime_timeout') {
      throw error
    }
    const fallback = await client.call<ClaudeAccountsUsageSnapshot>('accounts.list', {
      refreshUsage: false
    })
    return { snapshot: fallback.result, runtimeId: fallback._meta.runtimeId, partial: true }
  }
}

/** Resolves per-account Claude usage from whichever transport `client` is connected over. */
export function fetchClaudeAccountUsage(
  client: RuntimeClient,
  timeoutMs: number = ACCOUNT_USAGE_WAIT_TIMEOUT_MS
): Promise<ClaudeAccountUsageFetch> {
  const pairing = client.remotePairingOffer
  return pairing ? fetchViaSubscribe(pairing, timeoutMs) : fetchViaAccountsList(client, timeoutMs)
}
