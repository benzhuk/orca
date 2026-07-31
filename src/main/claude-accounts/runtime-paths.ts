import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isServeModeProcess } from '../serve-mode'
import type { ClaudeEnvPatch } from './environment'

export type ClaudeRuntimePaths = {
  configDir: string
  credentialsPath: string
  configPath: string
  envPatch: ClaudeEnvPatch
}

export class ClaudeRuntimePathResolver {
  getRuntimePaths(): ClaudeRuntimePaths {
    const ambientConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null
    // Why: headless `orca serve` inherits its environment from a systemd unit or the
    // launching shell, where a stray CLAUDE_CONFIG_DIR pins every managed session to
    // one config dir and makes the account switcher a no-op — and if it points at a
    // managed account's auth dir, runtime housekeeping deletes that account's
    // credentials (#10922). Desktop keeps honoring the inherited dir.
    const inheritedConfigDir = isServeModeProcess() ? null : ambientConfigDir
    const configDir = inheritedConfigDir || join(homedir(), '.claude')
    mkdirSync(configDir, { recursive: true })
    // Why: the patch has to override, not merely mirror — PTYs inherit the process
    // environment, so an ignored ambient value would still reach the Claude CLI. The
    // child then resolves `.claude.json` inside the patched dir, so this process must
    // resolve it the same way or it reads and writes a file the session never sees.
    const patchedConfigDir = inheritedConfigDir || ambientConfigDir ? configDir : null

    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: this.resolveConfigPath(configDir, patchedConfigDir),
      envPatch: patchedConfigDir ? { CLAUDE_CONFIG_DIR: patchedConfigDir } : {}
    }
  }

  private resolveConfigPath(configDir: string, explicitConfigDir: string | null): string {
    const colocatedConfigPath = join(configDir, '.claude.json')
    if (explicitConfigDir || existsSync(colocatedConfigPath)) {
      return colocatedConfigPath
    }
    return join(homedir(), '.claude.json')
  }
}
