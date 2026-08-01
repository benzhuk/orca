import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: the desktop "Add account" button is disabled when the UI drives a remote
// runtime (a headless server). These commands run the interactive agent login
// (`claude login` / `codex login`) in the caller's own terminal on the host and
// register the captured account with the local runtime, giving headless hosts a
// way to manage Claude and Codex accounts.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed Claude or Codex account by signing in on this Orca host',
    usage: 'orca account add [--agent claude|codex] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    notes: [
      'Runs the agent login (`claude login` / `codex login`) in this terminal, then registers the account with the local Orca runtime.',
      'Codex uses device authorization so the browser can complete sign-in from a different machine.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the Orca runtime to be running on this machine.'
    ],
    examples: ['orca account add', 'orca account add --agent codex']
  },
  {
    path: ['account', 'list'],
    summary: 'List managed Claude and Codex accounts on this Orca host',
    usage: 'orca account list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Lists the accounts on this machine. `--environment` / `--pairing-code` are rejected rather than ignored; run it on the host whose accounts you want to see.'
    ],
    examples: ['orca account list']
  },
  {
    path: ['account', 'select'],
    summary: 'Select the active managed Claude account by email or account id',
    usage:
      'orca account select (--email <email> | --account-id <id>) [--agent claude] [--environment <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'email', 'account-id'],
    notes: [
      "Resolves --email to a managed account (case-insensitive) via the runtime's account list, then makes it the active Claude account there.",
      '--account-id skips email resolution but still confirms the id exists in the account list first, so a typo fails clearly instead of an opaque runtime error.',
      "Exactly one of --email / --account-id is required; the same email can legitimately match two accounts (e.g. the same address registered to two orgs), and that error names each match's --account-id to retry with.",
      "Unlike `account add` / `account list`, `--environment` DOES retarget this command — point it at a saved environment to switch a remote host's active account without SSHing in; this is the cross-scope account-switch primitive.",
      '--agent defaults to claude; codex is not supported by this command yet.',
      'Without --environment it uses ORCA_ENVIRONMENT / ORCA_PAIRING_CODE when set, like other remote-capable commands.'
    ],
    examples: [
      'orca account select --email jane@example.com',
      'orca account select --account-id b3f0b6b0-1c1a-4b8e-9a9b-2f6e9a9b2f6e',
      'orca account select --email jane@example.com --environment homelab'
    ]
  },
  {
    path: ['account', 'usage'],
    summary: 'Show per-account Claude session/weekly usage from a runtime',
    usage: 'orca account usage [--environment <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      "Reads each managed Claude account's session (5h) and weekly (7d) usage percent + reset time from the target runtime's own rate-limit state — the same source the desktop status bar reads, fetched from that runtime's own IP rather than this CLI's.",
      'Triggers a fresh refresh of every account before reading; on a healthy host this returns settled usage for all accounts in one call.',
      'Waits up to ~12s per account for a refresh in flight; an account still unresolved after that prints as "fetching…" (or "no data" if never fetched) instead of blocking indefinitely — re-run to check again.',
      "Like `account select`, --environment DOES retarget this command, so you can read a remote host's usage without SSHing in.",
      'Without --environment it uses ORCA_ENVIRONMENT / ORCA_PAIRING_CODE when set, like other remote-capable commands.'
    ],
    examples: ['orca account usage', 'orca account usage --environment homelab --json']
  }
]
