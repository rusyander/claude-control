import type { ServerContext } from '../../context.ts';
import { BackgroundWatcher, type BackgroundWatcherDeps } from '../../domains/watcher/watcher.ts';
import { appRootDir, watchReportPath } from '../../domains/watcher/report.ts';
import { reportLanguage } from '../../domains/watcher/report-texts.ts';
import { resolveWatcherRoute } from '../../domains/watcher/route.ts';
import { cheapModelFor } from '../../domains/groups/model.ts';
import { gatewayPricing } from '../../domains/platform/spend/spend.ts';
import { findCliOnPath } from '../../providers/detect/detect.ts';
import { providerCliCandidates } from '../../providers/cli/cli.ts';
import { getProvider } from '../../providers/registry.ts';

/**
 * Сборка фонового наблюдателя из контекста. Разбирает только Claude: флаги
 * «только чтение» (`--tools`, `--allowedTools`) и снятие наших слоёв проверены
 * именно на нём. Активен чужой CLI — разбор отказывает кодом (`route.ts`), а не
 * уходит в облако Claude мимо выбранного; профиль «Ассистент панели» на контуре
 * ведёт разбор через контур, как агента панели.
 *
 * Переменные окружения — для проверок с одноразовой панелью, которым незачем
 * ждать реальных порогов: `AGENTDECK_WATCH_DEBOUNCE_MS` (пауза перед разбором),
 * `AGENTDECK_WATCH_SLOW_MS` и `AGENTDECK_WATCH_STUCK_MS` (пороги медленного
 * ответа и зависшей загрузки), `AGENTDECK_WATCH_RUNS_PER_HOUR` (потолок).
 */
function envNumber(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : undefined;
}

export function createBackgroundWatcher(
  ctx: ServerContext,
  /** Порт живого шлюза контуров; 0 — не поднят. */
  gatewayPort: () => number = () => 0,
  /** Окружение переключателя «Claude Code на локальной модели» (пусто — выключен). */
  claudeSwitchEnv: () => Record<string, string> = () => ({}),
): BackgroundWatcher {
  return new BackgroundWatcher(backgroundWatcherDeps(ctx, gatewayPort, claudeSwitchEnv));
}

/** Зависимости наблюдателя из контекста — отдельно, чтобы проверка видела маршрут без запуска. */
export function backgroundWatcherDeps(
  ctx: ServerContext,
  gatewayPort: () => number,
  claudeSwitchEnv: () => Record<string, string> = () => ({}),
): BackgroundWatcherDeps {
  const claude = getProvider('claude');
  const debounce = envNumber('AGENTDECK_WATCH_DEBOUNCE_MS', 0);
  const slow = envNumber('AGENTDECK_WATCH_SLOW_MS', 1);
  const stuck = envNumber('AGENTDECK_WATCH_STUCK_MS', 1);
  const cap = envNumber('AGENTDECK_WATCH_RUNS_PER_HOUR', 1);
  return {
    appDataDir: () => ctx.location.paths.appData,
    reportPath: () => watchReportPath(),
    cwd: appRootDir(),
    resolveCommand: () => findCliOnPath(providerCliCandidates(claude)),
    model: () => cheapModelFor(claude, []),
    resolveRoute: () =>
      resolveWatcherRoute({
        store: ctx.store,
        appDataDir: ctx.location.paths.appData,
        gatewayPort,
        claudeSwitchEnv,
      }),
    pricing: gatewayPricing(ctx.store, ctx.pricing),
    language: () => reportLanguage(ctx.store.getSettings().language),
    ...(debounce !== undefined ? { debounceMs: debounce } : {}),
    ...(cap !== undefined ? { runsPerHour: Math.floor(cap) } : {}),
    thresholds: {
      ...(slow !== undefined ? { slowRequestMs: slow } : {}),
      ...(stuck !== undefined ? { stuckLoadingMs: stuck } : {}),
    },
  };
}
