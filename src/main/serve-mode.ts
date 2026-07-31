// Why: several main-process services must know they run under headless `orca serve`
// (no window, no account UI). Importing the flag from index.ts would create a cycle
// with the very services index.ts constructs, so the argv read lives here.
export function isServeModeProcess(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--serve')
}
