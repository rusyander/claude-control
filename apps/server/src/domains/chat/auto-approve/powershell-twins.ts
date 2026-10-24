/**
 * Правила `ask`/`deny` CLI для инструмента PowerShell (повторная проверка 24.10).
 *
 * Правило `Bash(…)` инструмент PowerShell не задевает: в авторежиме `git push
 * origin HEAD:main`, `git branch -D` или `Remove-Item -Recurse` из PowerShell шли
 * мимо брокера прав к классификатору CLI, а запрет публикации до доставки его не
 * держал. Форма правила PowerShell та же, что у Bash; CLI сверяет её без учёта
 * регистра и с псевдонимами (`Remove-Item` — это и `rm`, и `del`), каждое звено
 * составной команды отдельно. Свой `deny` для PowerShell ещё и не даёт CLI молча
 * выключить инструмент: под Git Bash один `Bash(…)` в `deny` гасит PowerShell
 * целиком, а с правилом `PowerShell(…)` он остаётся — и тогда закрыт им же.
 */

/** К каждому правилу `Bash(…)` — такое же `PowerShell(…)`; прочие правила как есть. */
export function withPowerShellTwins(rules: readonly string[]): string[] {
  const twins = rules
    .filter((rule) => rule.startsWith('Bash('))
    .map((rule) => `PowerShell(${rule.slice('Bash('.length)}`);
  return [...new Set([...rules, ...twins])];
}

/**
 * Чего у Bash нет, а у PowerShell есть: исполнение строки (`iex` — как `eval`),
 * запуск программы мимо её имени (`Start-Process git -ArgumentList push`) и запрос
 * к API командлетом (`curl` в Windows PowerShell — псевдоним `Invoke-WebRequest`).
 * Правило только ведёт вызов к брокеру; решает разбор команды.
 */
export const POWERSHELL_ONLY_ASK: readonly string[] = [
  'PowerShell(Invoke-Expression *)',
  'PowerShell(Invoke-Command *)',
  'PowerShell(Start-Process *)',
  'PowerShell(Invoke-WebRequest *merge*)',
  'PowerShell(Invoke-WebRequest *DELETE*)',
  'PowerShell(Invoke-RestMethod *merge*)',
  'PowerShell(Invoke-RestMethod *DELETE*)',
];
