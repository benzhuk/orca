// Why: Claude and Codex managed-account summaries both carry id+email+active id,
// so one formatter renders either provider's block.
export type AccountsBlock = {
  accounts: readonly { id: string; email: string }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: {
    host: string | null
    wsl: Record<string, string | null>
  }
}

/** The set of account ids currently active on any runtime (host or a WSL distro). */
export function activeAccountIdSet(block: AccountsBlock): Set<string | null | undefined> {
  return new Set([
    block.activeAccountId,
    block.activeAccountIdsByRuntime?.host,
    ...Object.values(block.activeAccountIdsByRuntime?.wsl ?? {})
  ])
}

/** Renders a provider's managed-account list as a human-readable block, marking the active account. */
export function formatAccountsBlock(label: string, block: AccountsBlock): string {
  if (block.accounts.length === 0) {
    return `No managed ${label} accounts.`
  }
  const activeAccountIds = activeAccountIdSet(block)
  const lines = block.accounts.map(
    (account) => `  ${account.email}${activeAccountIds.has(account.id) ? ' (active)' : ''}`
  )
  return `Managed ${label} accounts (${block.accounts.length}):\n${lines.join('\n')}`
}
