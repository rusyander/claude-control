/**
 * Изолированная конфигурация для проверки отдельных настроек.
 *
 * Claude Code читает всё из каталога, на который указывает CLAUDE_CONFIG_DIR.
 * Песочница пользуется этим: во временный каталог кладётся только то, что
 * проверяют, и ничего больше. Проверено на практике — в таком запуске у Claude
 * 30 инструментов вместо 165, ни одного MCP-сервера и ни одного стороннего
 * хука, а переписка пишется в тот же временный каталог, а не в настоящий.
 *
 * Наружу из песочницы не выходит ничего: настоящие настройки открываются
 * только на чтение, файл с токенами MCP-серверов не копируется, а рабочая
 * папка своя. Единственное исключение — учётные данные Claude Code: без них
 * проверять нечего (см. lib/credentials.ts, там же разница между системами).
 *
 * Модуль — вход в домен песочницы; сами шаги разложены по соседям:
 * сборка `SandboxAssembly.ts`, наполнение `SandboxContents.ts`, настройки
 * `SandboxSettings.ts`, пути и удаление `SandboxPaths.ts`, реестры
 * `SandboxRegistry.ts`, уборка `SandboxSweep.ts`.
 */

export type {
  Sandbox,
  SandboxDescription,
  SandboxSelection,
  SweepFailure,
  SweepReport,
  SweepReporter,
} from './SandboxConfig.types.ts';

export { sandboxPaths } from './SandboxPaths.ts';
export { isSandboxExpired, markSandboxBusy, markSandboxFree } from './SandboxRegistry.ts';
export { createSandbox, removeSandbox } from './SandboxAssembly.ts';
export {
  startSandboxHousekeeping,
  startSandboxSweeper,
  stopSandboxSweeper,
  sweepAbandonedSandboxes,
  sweepDeferredSandboxes,
  sweepIdleSandboxes,
} from './SandboxSweep.ts';
