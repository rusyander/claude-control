import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { LivenessProbe } from '../../platform/process-identity.ts';
import type { CoreClock } from '../../platform/clock.ts';

/**
 * Кран наблюдателя в потоке сессии (этап 8, F2): краны только ПИШУТ факты (`tool.event`,
 * переходы сессии, пробы), судит наблюдатель по журналу. `inHistory` — событие из истории
 * прикреплённой заново сессии (правило `resumed`/`replayed` рантайма): его факт уже в журнале,
 * второй раз он не пишется.
 */
export interface ObserverTap {
  onEvent(
    task: LiveTask,
    binding: SessionBinding,
    event: AdapterEvent,
    meta: { inHistory: boolean },
  ): void;
}

/**
 * Подстройки наблюдателя для тестов (F14: в s8 нет раздела настроек `observer` — константы спеки
 * живут в каталоге). Нет поля — значение спеки.
 */
export interface ObserverOptions {
  /** Порог тишины без выученного p95 (спека: 10 мин). */
  stallDefaultMs?: number;
  /** Через сколько тишины с ходом в работе сессия `silent` (спека: 60 с). */
  silentAfterMs?: number;
  /** Сверка хостов открытых сеансов (этап 11): не чаще, чем раз в столько; нет — 5 с, 0 — каждый тик. */
  hostCheckMs?: number;
  /** Проба жизни (pid + старт, CPU); нет — проба платформы. */
  probe?: LivenessProbe;
  /** Тикающие часы ядра (`startClockJumps`); нет — часы загрузки. */
  clock?: CoreClock;
}

export type ObserverNote = (event: string, data: Record<string, unknown>) => void;
