import { RuntimeClientError } from './runtime-client'
import type { HandlerContext } from './dispatch'
import type { ClaudeRateLimitAccountsState, CodexRateLimitAccountsState } from '../shared/types'

// Why: add returns just that provider's state; list returns the full snapshot.
export type AccountsListSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
}

const SELECTOR_REQUIRED_MESSAGE = 'Provide --email or --account-id to select an account.'

/**
 * Resolves `account select`'s target account id from exactly one of --email /
 * --account-id. `--account-id` still round-trips through `accounts.list` to
 * confirm the id names a real managed account before it reaches
 * `accounts.selectClaude` — a typo would otherwise surface as a far less clear
 * runtime error. Email matching is case-insensitive and trimmed; zero or
 * multiple matches fail loud instead of guessing, since a silent wrong pick
 * would switch the wrong account.
 */
export async function resolveClaudeAccountSelection(
  client: HandlerContext['client'],
  email: string | undefined,
  accountId: string | undefined
): Promise<string> {
  if (email !== undefined && accountId !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Provide exactly one of --email or --account-id, not both.'
    )
  }
  if (email === undefined && accountId === undefined) {
    throw new RuntimeClientError('invalid_argument', SELECTOR_REQUIRED_MESSAGE)
  }
  const result = await client.call<AccountsListSnapshot>('accounts.list', { refreshUsage: false })
  if (accountId !== undefined) {
    const found = result.result.claude.accounts.some((account) => account.id === accountId)
    if (!found) {
      throw new RuntimeClientError(
        'invalid_argument',
        `No managed Claude account found with id "${accountId}" on this runtime. Run \`orca account list\` to see managed accounts.`
      )
    }
    return accountId
  }
  // Why: unreachable given the guards above (TypeScript can't derive "exactly
  // one of two optional parameters is set" from two separate checks), kept
  // only so `email` narrows to `string` below.
  if (email === undefined) {
    throw new RuntimeClientError('invalid_argument', SELECTOR_REQUIRED_MESSAGE)
  }
  const normalized = email.trim().toLowerCase()
  const matches = result.result.claude.accounts.filter(
    (account) => account.email.trim().toLowerCase() === normalized
  )
  if (matches.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `No managed Claude account found for "${email}" on this runtime. Run \`orca account list\` to see managed accounts.`
    )
  }
  if (matches.length > 1) {
    // Why: the same email is legitimately two accounts across host/WSL runtimes
    // or two orgs, so name what differs and how to pick one instead of a dead end.
    const candidates = matches
      .map(
        (account) =>
          `${account.id} (${account.wslDistro ?? account.managedAuthRuntime ?? 'host'}${
            account.organizationName ? `, ${account.organizationName}` : ''
          })`
      )
      .join(', ')
    throw new RuntimeClientError(
      'invalid_argument',
      `"${email}" matches ${matches.length} managed Claude accounts on this runtime: ${candidates}. Retry with --account-id <id> to pick one, or remove the stale duplicate.`
    )
  }
  return matches[0].id
}
