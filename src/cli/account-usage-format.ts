import type { RateLimitWindow } from '../shared/rate-limit-types'
import type { ClaudeAccountUsageRow } from './account-usage'

function formatWindow(window: RateLimitWindow | null): string {
  if (!window) {
    return '—'
  }
  const reset = window.resetDescription ? ` (resets ${window.resetDescription})` : ''
  return `${Math.round(window.usedPercent)}%${reset}`
}

function formatRowStatus(row: ClaudeAccountUsageRow): string {
  if (row.status === 'fetching') {
    return 'fetching…'
  }
  if (row.status === 'error') {
    return `error${row.error ? `: ${row.error}` : ''}`
  }
  if (row.status === 'no-data') {
    return 'no data'
  }
  return `session ${formatWindow(row.session)}  weekly ${formatWindow(row.weekly)}`
}

/** One line per account: email — org (active marker) — session/weekly usage or a status marker. */
export function formatClaudeAccountUsageRow(row: ClaudeAccountUsageRow): string {
  const org = row.organizationName ? ` — ${row.organizationName}` : ''
  const active = row.active ? ' (active)' : ''
  return `  ${row.email}${org}${active}  ${formatRowStatus(row)}`
}

/** Renders the full human table, with a trailing note when the wait timed out before every row settled. */
export function formatClaudeAccountUsageTable(
  rows: readonly ClaudeAccountUsageRow[],
  partial: boolean
): string {
  if (rows.length === 0) {
    return 'No managed Claude accounts.'
  }
  const lines = rows.map(formatClaudeAccountUsageRow)
  const footer = partial
    ? '\n(partial — some accounts were still refreshing; re-run to check again)'
    : ''
  return `Claude account usage (${rows.length}):\n${lines.join('\n')}${footer}`
}
