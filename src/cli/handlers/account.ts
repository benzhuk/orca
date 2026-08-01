import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { formatAccountsBlock } from '../account-format'
import { resolveClaudeAccountSelection, type AccountsListSnapshot } from '../account-select'
import { buildClaudeAccountUsageRows } from '../account-usage'
import { formatClaudeAccountUsageTable } from '../account-usage-format'
import { fetchClaudeAccountUsage } from '../account-usage-transport'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/launch'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from '../../main/claude-accounts/keychain'
import { getVersionManagerBinPaths, resolveCliCommand } from '../../main/codex-cli/command'
import { getSpawnArgsForWindows } from '../../main/win32-utils'
import { ACCOUNT_IMPORT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { ClaudeRateLimitAccountsState, CodexRateLimitAccountsState } from '../../shared/types'
import {
  type InteractiveLoginSession,
  withInteractiveLoginCleanup
} from './interactive-login-interruption'

function addAgentNodePaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey =
    process.platform === 'win32' && env.Path !== undefined && env.PATH === undefined
      ? 'Path'
      : 'PATH'
  const currentEntries = (env[pathKey] ?? '').split(delimiter).filter(Boolean)
  const existing = new Set(currentEntries)
  const missing = getVersionManagerBinPaths().filter((entry) => !existing.has(entry))
  if (missing.length > 0) {
    env[pathKey] = [...missing, ...currentEntries].join(delimiter)
  }
  return env
}

/**
 * Runs the real agent login attached to the user's terminal so the OAuth
 * URL/device-code prompt is visible and the code can be pasted back — the desktop
 * GUI flow drives this via a browser Orca can't reach on a headless host.
 */
async function runAgentLoginInTerminal(
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
  json: boolean,
  session: InteractiveLoginSession
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const resolvedCommand = resolveCliCommand(command)
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedCommand, args)
    const env = addAgentNodePaths({ ...stripElectronRunAsNode(process.env), ...extraEnv })
    const child = spawn(spawnCmd, spawnArgs, {
      // Why: JSON mode reserves stdout for the response envelope while keeping
      // the interactive login attached to the user's terminal via stderr.
      stdio: ['inherit', json ? process.stderr : 'inherit', 'inherit'],
      env
    })
    session.child = child
    child.once('error', (error) =>
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `Could not launch \`${command}\`. Is it installed and on PATH? (${
            error instanceof Error ? error.message : String(error)
          })`
        )
      )
    )
    child.once('exit', (code) => {
      session.child = null
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `\`${command} ${args.join(' ')}\` exited with code ${code ?? 'null'}.`
        )
      )
    })
  })
}

async function cleanupClaudeLoginArtifacts(
  configDir: string,
  legacyCredentials: string | null,
  restoreLegacyCredentials: boolean
): Promise<void> {
  const errors: unknown[] = []
  if (process.platform === 'darwin') {
    try {
      await deleteActiveClaudeKeychainCredentialsStrict(configDir)
    } catch (error) {
      errors.push(error)
    }
    if (restoreLegacyCredentials) {
      try {
        await (legacyCredentials
          ? writeActiveClaudeKeychainCredentials(legacyCredentials)
          : deleteActiveClaudeKeychainCredentialsStrict())
      } catch (error) {
        errors.push(error)
      }
    }
  }
  try {
    rmSync(configDir, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to clean up Claude login artifacts.')
  }
}

/** Logs into a Claude account in a temp config dir, then registers it with the local runtime. */
async function addClaudeAccount({ client, json }: HandlerContext): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), 'orca-account-add-claude-'))
  const session: InteractiveLoginSession = {
    child: null,
    registering: false,
    terminationPromise: null
  }
  let legacyCredentials: string | null = null
  let restoreLegacyCredentials = false
  const result = await withInteractiveLoginCleanup(
    session,
    async () => {
      await cleanupClaudeLoginArtifacts(configDir, legacyCredentials, restoreLegacyCredentials)
    },
    async () => {
      if (process.platform === 'darwin') {
        legacyCredentials = await readActiveClaudeKeychainCredentialsStrict()
        restoreLegacyCredentials = true
      }
      await runAgentLoginInTerminal(
        'claude',
        ['auth', 'login', '--claudeai'],
        {
          CLAUDE_CONFIG_DIR: configDir
        },
        json,
        session
      )
      session.registering = true
      return client.call<ClaudeRateLimitAccountsState>('accounts.addClaudeFromConfigDir', {
        configDir,
        ...(process.platform === 'darwin'
          ? {
              previousLegacyCredentialsSha256: legacyCredentials
                ? createHash('sha256').update(legacyCredentials).digest('hex')
                : null
            }
          : {})
      })
    }
  )
  printResult(result, json, (state) => formatAccountsBlock('Claude', state))
}

/** Logs into a Codex account in a temp CODEX_HOME, then registers it with the local runtime. */
async function addCodexAccount({ client, json }: HandlerContext): Promise<void> {
  const codexHome = mkdtempSync(join(tmpdir(), 'orca-account-add-codex-'))
  const session: InteractiveLoginSession = {
    child: null,
    registering: false,
    terminationPromise: null
  }
  const result = await withInteractiveLoginCleanup(
    session,
    async () => {
      rmSync(codexHome, { recursive: true, force: true })
    },
    async () => {
      // Why: plain OAuth binds a loopback callback the user's browser cannot reach
      // on a headless/SSH host; device auth is explicitly designed for this flow.
      await runAgentLoginInTerminal(
        'codex',
        ['login', '--device-auth'],
        { CODEX_HOME: codexHome },
        json,
        session
      )
      session.registering = true
      return client.call<CodexRateLimitAccountsState>('accounts.addCodexFromHome', {
        sourceHome: codexHome
      })
    }
  )
  printResult(result, json, (state) => formatAccountsBlock('Codex', state))
}

/**
 * Rejects the runtime-selector flags instead of ignoring them. shouldIgnoreRemoteSelection
 * pins account commands to the local runtime, so honoring `--environment homelab`
 * silently would target the laptop rather than the host the user named — the exact
 * mistake this feature exists to avoid. A `--help` note does not reach someone who
 * already typed the flag.
 */
function rejectRemoteSelectionFlags(ctx: HandlerContext, command: string): void {
  for (const flag of ['environment', 'pairing-code']) {
    if (ctx.flags.has(flag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `\`--${flag}\` does not retarget \`${command}\`. Run it on the host whose accounts you want to manage.`
      )
    }
  }
}

async function assertAccountImportSupported({ client }: HandlerContext): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(ACCOUNT_IMPORT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime is too old to add accounts from the CLI. Update or restart Orca and try again.'
    )
  }
}

/** CLI handlers for `orca account add [--agent claude|codex]`, `orca account list`, and `orca account select`. */
export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account add': async (ctx) => {
    const agentFlag = ctx.flags.get('agent')
    // Why: a valueless `--agent` parses as boolean true; defaulting it to claude
    // would silently run a full OAuth login for the provider the user did not ask for.
    if (agentFlag !== undefined && typeof agentFlag !== 'string') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing a value for --agent. Use `--agent claude` or `--agent codex`.'
      )
    }
    const agent = agentFlag ?? 'claude'
    if (agent !== 'claude' && agent !== 'codex') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unsupported --agent "${agent}". Use "claude" or "codex".`
      )
    }
    rejectRemoteSelectionFlags(ctx, 'orca account add')
    // Why: fail on runtime version skew before burning a full OAuth round trip.
    await assertAccountImportSupported(ctx)
    await ctx.client.call('accounts.list', { refreshUsage: false })
    await (agent === 'claude' ? addClaudeAccount(ctx) : addCodexAccount(ctx))
  },
  'account list': async (ctx) => {
    rejectRemoteSelectionFlags(ctx, 'orca account list')
    const { client, json } = ctx
    // Why: this command renders no usage numbers, so skip the forced provider
    // refresh — it is one serial network round-trip per managed account.
    const result = await client.call<AccountsListSnapshot>('accounts.list', {
      refreshUsage: false
    })
    printResult(
      result,
      json,
      (snapshot) =>
        `${formatAccountsBlock('Claude', snapshot.claude)}\n\n${formatAccountsBlock('Codex', snapshot.codex)}`
    )
  },
  'account select': async (ctx) => {
    const agentFlag = ctx.flags.get('agent')
    // Why: a valueless `--agent` parses as boolean true; defaulting it to claude
    // would silently select on the provider the user did not ask for.
    if (agentFlag !== undefined && typeof agentFlag !== 'string') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing a value for --agent. Use `--agent claude`.'
      )
    }
    const agent = agentFlag ?? 'claude'
    if (agent !== 'claude') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unsupported --agent "${agent}". \`account select\` only supports "claude".`
      )
    }
    const email = getOptionalStringFlag(ctx.flags, 'email')
    const accountIdFlag = getOptionalStringFlag(ctx.flags, 'account-id')
    const { client, json } = ctx
    // Why: unlike add/list, --environment / --pairing-code are NOT rejected here —
    // this is the CLI's cross-scope account-switch primitive (see the spec notes).
    const accountId = await resolveClaudeAccountSelection(client, email, accountIdFlag)
    const result = await client.call<ClaudeRateLimitAccountsState>('accounts.selectClaude', {
      accountId
    })
    printResult(result, json, (state) => formatAccountsBlock('Claude', state))
  },
  'account usage': async ({ client, json }) => {
    const fetched = await fetchClaudeAccountUsage(client)
    const accounts = buildClaudeAccountUsageRows(
      fetched.snapshot.claude,
      fetched.snapshot.rateLimits
    )
    printResult(
      {
        id: 'account-usage',
        ok: true,
        result: { accounts, partial: fetched.partial },
        _meta: { runtimeId: fetched.runtimeId }
      },
      json,
      ({ accounts: rows, partial }) => formatClaudeAccountUsageTable(rows, partial)
    )
  }
}
