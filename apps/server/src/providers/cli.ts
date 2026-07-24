import { claudeProvider } from './claude.ts';
import { getActiveProvider, type SettingsSource } from './registry.ts';
import type { ConfigProvider } from './types.ts';

/**
 * Единый источник имени CLI. Раньше `isWindows ? 'claude.cmd' : 'claude'` было
 * размазано по чату, помощникам, плагинам и ресурсам — теперь имя берётся из
 * провайдера. Значения те же (claude / claude.cmd), поэтому поведение идентично.
 */

/**
 * Платформа проверяется ФУНКЦИЕЙ, а не константой модуля: константа
 * вычислялась бы один раз при импорте, и подменить `process.platform` в тесте
 * (кроссплатформенная проверка резолвинга без macOS/Linux под рукой) было бы
 * нечем. Стоимость — одно сравнение строк.
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Команда запуска для конкретного провайдера с учётом ОС. */
export function providerCliCommand(provider: ConfigProvider): string {
  return isWindows() ? provider.cli.windowsCommand : provider.cli.command;
}

/**
 * Все имена, под которыми CLI провайдера может лежать в PATH, в порядке
 * предпочтения.
 *
 * На Windows одного `.cmd` мало. Пакеты npm ставят обёртку `<name>.cmd`, но
 * ровно те же инструменты бывают установлены и как нативный бинарь или
 * python-обёртка: `codex.exe` (сборка на Rust), `aider.exe` (pip ставит
 * `Scripts\aider.exe`), `opencode.exe`. Проверяя только `codex.cmd`, панель
 * говорила бы «CLI не найден» при вполне установленном Codex. Поэтому после
 * `.cmd`-варианта пробуем «голое» имя: `where codex` разворачивает его по
 * PATHEXT и находит .exe/.bat/.cmd — то же делает и `cmd.exe /c codex` при
 * запуске, так что найденное имя гарантированно запускается.
 *
 * На POSIX вариант ровно один — имя без расширения.
 */
export function providerCliCandidates(provider: ConfigProvider): string[] {
  if (!isWindows()) return [provider.cli.command];
  return provider.cli.windowsCommand === provider.cli.command
    ? [provider.cli.command]
    : [provider.cli.windowsCommand, provider.cli.command];
}

/** Команда запуска активного провайдера (из настройки `provider`). */
export function activeCliCommand(store: SettingsSource): string {
  return providerCliCommand(getActiveProvider(store));
}

/**
 * Команда провайдера по умолчанию (Claude) — запасной вариант там, где store
 * ещё не прокинут. Тоже идёт через провайдера, имя не хардкодится.
 */
export function defaultCliCommand(): string {
  return providerCliCommand(claudeProvider);
}
