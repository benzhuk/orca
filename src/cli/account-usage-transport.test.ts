import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RemoteRuntimeClientModule from '../shared/remote-runtime-client'
import type { PairingOffer } from '../shared/pairing'
import type { RemoteRuntimeSubscriptionCallbacks } from '../shared/remote-runtime-client'
import type { RateLimitState } from '../shared/rate-limit-types'
import type { ClaudeRateLimitAccountsState } from '../shared/types'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../shared/remote-runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteRuntimeClientModule>()
  return { ...actual, subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock }
})

import {
  ACCOUNT_USAGE_WAIT_TIMEOUT_MS,
  fetchClaudeAccountUsage,
  type ClaudeAccountsUsageSnapshot
} from './account-usage-transport'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'

const FAKE_PAIRING = {} as PairingOffer

function fakeClient(overrides: Partial<RuntimeClient> = {}): RuntimeClient {
  return { remotePairingOffer: null, call: vi.fn(), ...overrides } as unknown as RuntimeClient
}

function claude(accountId: string, activeAccountId: string | null): ClaudeRateLimitAccountsState {
  return {
    accounts: [{ id: accountId, email: `${accountId}@x.com` } as never],
    activeAccountId,
    activeAccountIdsByRuntime: { host: activeAccountId, wsl: {} }
  }
}

function rateLimits(overrides: Partial<RateLimitState> = {}): RateLimitState {
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

function settledSnapshot(): ClaudeAccountsUsageSnapshot {
  return {
    claude: claude('a', 'a'),
    rateLimits: rateLimits({
      claude: {
        provider: 'claude',
        session: { usedPercent: 1, windowMinutes: 300, resetsAt: 1, resetDescription: '1 PM' },
        weekly: { usedPercent: 2, windowMinutes: 10080, resetsAt: 2, resetDescription: 'Fri' },
        updatedAt: 1,
        error: null,
        status: 'ok'
      }
    })
  }
}

describe('fetchClaudeAccountUsage — local transport (no remote pairing)', () => {
  it('returns settled usage from one refreshUsage:true call on a healthy host', async () => {
    const callMock = vi.fn().mockResolvedValue({
      id: 'r',
      ok: true,
      result: settledSnapshot(),
      _meta: { runtimeId: 'local-1' }
    })
    const client = fakeClient({ call: callMock })

    const result = await fetchClaudeAccountUsage(client, 5000)

    expect(callMock).toHaveBeenCalledWith(
      'accounts.list',
      { refreshUsage: true },
      { timeoutMs: 5000 }
    )
    expect(result).toEqual({ snapshot: settledSnapshot(), runtimeId: 'local-1', partial: false })
  })

  it('reports partial when the refreshed snapshot still has a fetching account', async () => {
    const stillFetching: ClaudeAccountsUsageSnapshot = {
      claude: claude('b', null),
      rateLimits: rateLimits({
        inactiveClaudeAccounts: [
          { accountId: 'b', rateLimits: null, updatedAt: 1, isFetching: true }
        ]
      })
    }
    const callMock = vi.fn().mockResolvedValue({
      id: 'r',
      ok: true,
      result: stillFetching,
      _meta: { runtimeId: 'local-1' }
    })
    const client = fakeClient({ call: callMock })

    const result = await fetchClaudeAccountUsage(client, 5000)

    expect(result.partial).toBe(true)
  })

  it('falls back to a plain read on a runtime_timeout instead of failing outright', async () => {
    // Why: accounts.list({refreshUsage:true}) is documented to be able to hang
    // behind broken auth — the bounded first attempt must degrade, not hang the CLI.
    const callMock = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeClientError('runtime_timeout', 'timed out'))
      .mockResolvedValueOnce({
        id: 'r2',
        ok: true,
        result: settledSnapshot(),
        _meta: { runtimeId: 'local-1' }
      })
    const client = fakeClient({ call: callMock })

    const result = await fetchClaudeAccountUsage(client, 5000)

    expect(callMock).toHaveBeenNthCalledWith(2, 'accounts.list', { refreshUsage: false })
    expect(result.partial).toBe(true)
    expect(result.snapshot).toEqual(settledSnapshot())
  })

  it('propagates a non-timeout failure without attempting the fallback read', async () => {
    const callMock = vi
      .fn()
      .mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'down'))
    const client = fakeClient({ call: callMock })

    await expect(fetchClaudeAccountUsage(client, 5000)).rejects.toThrow('down')
    expect(callMock).toHaveBeenCalledOnce()
  })

  it('defaults the wait to ~12s when no timeout is given', async () => {
    const callMock = vi.fn().mockResolvedValue({
      id: 'r',
      ok: true,
      result: settledSnapshot(),
      _meta: { runtimeId: 'l' }
    })
    const client = fakeClient({ call: callMock })

    await fetchClaudeAccountUsage(client)

    expect(callMock).toHaveBeenCalledWith(
      'accounts.list',
      { refreshUsage: true },
      {
        timeoutMs: ACCOUNT_USAGE_WAIT_TIMEOUT_MS
      }
    )
  })
})

describe('fetchClaudeAccountUsage — remote transport (accounts.subscribe)', () => {
  afterEach(() => {
    subscribeRemoteRuntimeRequestMock.mockReset()
    vi.useRealTimers()
  })

  it('resolves as soon as a streamed snapshot has every account settled', async () => {
    const close = vi.fn()
    let callbacks: RemoteRuntimeSubscriptionCallbacks<unknown> | undefined
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_pairing, method, _params, _t, cb) => {
        expect(method).toBe('accounts.subscribe')
        callbacks = cb
        return { requestId: 'req-1', close, sendBinary: vi.fn() }
      }
    )
    const client = fakeClient({ remotePairingOffer: FAKE_PAIRING })

    const promise = fetchClaudeAccountUsage(client, 5000)
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks?.onResponse({
      id: 'r1',
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1', snapshot: settledSnapshot() },
      _meta: { runtimeId: 'remote-1' }
    })

    const result = await promise

    expect(result).toEqual({ snapshot: settledSnapshot(), runtimeId: 'remote-1', partial: false })
    expect(close).toHaveBeenCalledOnce()
  })

  it('resolves partial at the deadline when the last snapshot still has a fetching account', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    let callbacks: RemoteRuntimeSubscriptionCallbacks<unknown> | undefined
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_pairing, _method, _params, _t, cb) => {
        callbacks = cb
        return { requestId: 'req-1', close, sendBinary: vi.fn() }
      }
    )
    const client = fakeClient({ remotePairingOffer: FAKE_PAIRING })
    const stillFetching: ClaudeAccountsUsageSnapshot = {
      claude: claude('b', null),
      rateLimits: rateLimits({
        inactiveClaudeAccounts: [
          { accountId: 'b', rateLimits: null, updatedAt: 1, isFetching: true }
        ]
      })
    }

    const promise = fetchClaudeAccountUsage(client, 1000)
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks?.onResponse({
      id: 'r1',
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1', snapshot: stillFetching },
      _meta: { runtimeId: 'remote-1' }
    })
    await vi.advanceTimersByTimeAsync(1000)

    const result = await promise
    expect(result.partial).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects with runtime_timeout when no snapshot ever arrives', async () => {
    vi.useFakeTimers()
    subscribeRemoteRuntimeRequestMock.mockImplementation(async () => ({
      requestId: 'req-1',
      close: vi.fn(),
      sendBinary: vi.fn()
    }))
    const client = fakeClient({ remotePairingOffer: FAKE_PAIRING })

    const promise = fetchClaudeAccountUsage(client, 1000)
    const assertion = expect(promise).rejects.toThrow('Timed out waiting for account usage')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('rejects when the subscribe response itself is an RPC failure', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks<unknown> | undefined
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_pairing, _method, _params, _t, cb) => {
        callbacks = cb
        return { requestId: 'req-1', close: vi.fn(), sendBinary: vi.fn() }
      }
    )
    const client = fakeClient({ remotePairingOffer: FAKE_PAIRING })

    const promise = fetchClaudeAccountUsage(client, 5000)
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks?.onResponse({
      id: 'r1',
      ok: false,
      error: { code: 'forbidden', message: 'nope' },
      _meta: { runtimeId: 'remote-1' }
    })

    await expect(promise).rejects.toThrow('nope')
  })

  it('does not resolve on a cold-runtime ready frame with no entry yet for an inactive account', async () => {
    // Why (R3-1 regression): the server emits `ready` BEFORE it triggers the
    // refresh, so a runtime that has never fetched this account's usage has no
    // inactiveClaudeAccounts entry at all yet — that must read as still-pending,
    // not as settled 'no-data', or the CLI reports "no data" on every cold run.
    const close = vi.fn()
    let callbacks: RemoteRuntimeSubscriptionCallbacks<unknown> | undefined
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_pairing, _method, _params, _t, cb) => {
        callbacks = cb
        return { requestId: 'req-1', close, sendBinary: vi.fn() }
      }
    )
    const client = fakeClient({ remotePairingOffer: FAKE_PAIRING })
    const coldReady: ClaudeAccountsUsageSnapshot = {
      claude: claude('b', null),
      rateLimits: rateLimits()
    }
    const refreshed: ClaudeAccountsUsageSnapshot = {
      claude: claude('b', null),
      rateLimits: rateLimits({
        inactiveClaudeAccounts: [
          {
            accountId: 'b',
            rateLimits: {
              provider: 'claude',
              session: {
                usedPercent: 5,
                windowMinutes: 300,
                resetsAt: 1,
                resetDescription: '1 PM'
              },
              weekly: {
                usedPercent: 6,
                windowMinutes: 10080,
                resetsAt: 2,
                resetDescription: 'Fri'
              },
              updatedAt: 1,
              error: null,
              status: 'ok'
            },
            updatedAt: 1,
            isFetching: false
          }
        ]
      })
    }

    const promise = fetchClaudeAccountUsage(client, 5000)
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks?.onResponse({
      id: 'r1',
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1', snapshot: coldReady },
      _meta: { runtimeId: 'remote-1' }
    })

    // Give an (incorrect) premature resolution on the ready frame a chance to happen.
    await Promise.resolve()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()

    callbacks?.onResponse({
      id: 'r1',
      ok: true,
      result: { type: 'snapshot', snapshot: refreshed },
      _meta: { runtimeId: 'remote-1' }
    })

    const result = await promise
    expect(result).toEqual({ snapshot: refreshed, runtimeId: 'remote-1', partial: false })
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a subscription that resolves only after the deadline already settled the promise', async () => {
    // Why (R3-2 regression): without the settled-check in the .then(), a handshake
    // that completes after the CLI's own deadline fired would assign a live
    // subscription that nothing ever closes — a leaked socket + server subscription.
    vi.useFakeTimers()
    const close = vi.fn()
    let resolveSubscribe:
      | ((sub: { requestId: string; close: () => void; sendBinary: () => boolean }) => void)
      | undefined
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        })
    )
    const client = fakeClient({ remotePairingOffer: FAKE_PAIRING })

    const promise = fetchClaudeAccountUsage(client, 1000)
    // Why: attach the rejection assertion before advancing timers — the
    // timeout's reject() fires synchronously inside advanceTimersByTimeAsync,
    // and attaching the handler afterward races Node's unhandled-rejection check.
    const assertion = expect(promise).rejects.toThrow('Timed out waiting for account usage')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion

    resolveSubscribe?.({ requestId: 'req-1', close, sendBinary: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    expect(close).toHaveBeenCalledOnce()
  })
})
