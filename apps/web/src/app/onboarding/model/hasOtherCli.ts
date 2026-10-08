/** Найден ли в PATH CLI, отличный от Claude Code, — повод не требовать `.claude`. */
export function hasOtherCli(
  detect: { providers: readonly { id: string; cliInstalled: boolean }[] } | undefined,
): boolean {
  return detect?.providers.some((item) => item.id !== 'claude' && item.cliInstalled) ?? false;
}
