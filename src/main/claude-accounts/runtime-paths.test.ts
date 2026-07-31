import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testState = { fakeHomeDir: '' }

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

// Why: isServeModeProcess() reads process.argv with no argument, so these cases have to
// mutate it; keep the original so nothing leaks into a sibling test.
const originalArgv = process.argv
const originalConfigDirEnv = process.env.CLAUDE_CONFIG_DIR

describe('ClaudeRuntimePathResolver', () => {
  beforeEach(() => {
    vi.resetModules()
    testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-claude-paths-'))
  })

  afterEach(() => {
    process.argv = originalArgv
    if (originalConfigDirEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDirEnv
    }
    rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  })

  it('ignores an inherited CLAUDE_CONFIG_DIR on headless serve and overrides it for sessions', async () => {
    const ambientDir = join(testState.fakeHomeDir, 'ambient-config')
    process.env.CLAUDE_CONFIG_DIR = ambientDir
    process.argv = [...originalArgv, '--serve']

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(join(testState.fakeHomeDir, '.claude'))
    // Why: PTYs inherit the process environment, so neutralizing the ambient value
    // requires emitting an override, not an empty patch.
    expect(paths.envPatch.CLAUDE_CONFIG_DIR).toBe(paths.configDir)
    expect(paths.credentialsPath).toBe(join(paths.configDir, '.credentials.json'))
  })

  it('honors an inherited CLAUDE_CONFIG_DIR when not running as a serve', async () => {
    const ambientDir = join(testState.fakeHomeDir, 'ambient-config')
    process.env.CLAUDE_CONFIG_DIR = ambientDir

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(ambientDir)
    expect(paths.envPatch.CLAUDE_CONFIG_DIR).toBe(ambientDir)
  })

  it('resolves .claude.json inside the config dir it patches into sessions', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(testState.fakeHomeDir, 'ambient-config')
    process.argv = [...originalArgv, '--serve']

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    // Why: the CLI resolves .claude.json relative to CLAUDE_CONFIG_DIR, so a patched
    // dir that this process reads a different config file from is a silent split.
    expect(paths.configPath).toBe(join(paths.envPatch.CLAUDE_CONFIG_DIR!, '.claude.json'))
  })

  it('falls back to the home-level .claude.json when no config dir is inherited', async () => {
    delete process.env.CLAUDE_CONFIG_DIR

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.envPatch.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(paths.configPath).toBe(join(testState.fakeHomeDir, '.claude.json'))
  })
})
