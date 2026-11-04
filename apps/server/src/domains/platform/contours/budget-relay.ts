import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HopBudgetNotice } from '@agentdeck/contracts/core/hops';
import type { ContourReader } from './contours.types.ts';

/**
 * Пороги бюджета контуров — людям (A-5), теперь из учёта звена ядра (C3b). Звено ставит отметку
 * «сказано» в запись расхода и кладёт извещение с растущим `seq`; панель забирает извещения
 * опросом и отдаёт каналам (Telegram, вебхук) — секреты каналов живут здесь, ядро о них не
 * знает. Курсор (`seq` последнего отданного) — в файле дома панели: перезапуск панели не
 * повторяет сказанное.
 *
 * Push сюда НЕ входит намеренно (как и раньше): его тело открывает разговор, а у бюджета
 * разговора нет — он свойство контура, и тратят его все прогоны разом.
 */

export const BUDGET_RELAY_FILE = 'contour-notices.json';
const DEFAULT_INTERVAL_MS = 5_000;

export interface BudgetRelayDeps {
  contours: Pick<ContourReader, 'notices'>;
  /** `<дом панели>/contour-notices.json`. */
  statePath: string;
  deliver(notice: HopBudgetNotice): void;
  log(line: string): void;
  intervalMs?: number;
}

export interface BudgetRelay {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

function readCursor(path: string): number {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { seq?: unknown };
    return typeof raw.seq === 'number' && Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0;
  } catch {
    return 0;
  }
}

function writeCursor(path: string, seq: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, seq })}\n`);
  renameSync(temp, path);
}

export function createBudgetRelay(deps: BudgetRelayDeps): BudgetRelay {
  let cursor = readCursor(deps.statePath);
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | undefined;
  let down = '';

  const once = async (): Promise<void> => {
    let notices: HopBudgetNotice[];
    try {
      // Все хранимые (их не больше 50), а не «после курсора»: учёт звена, начатый заново (файл
      // учёта стёрт), считает `seq` с единицы, и курсор выше последнего значил бы вечное молчание.
      notices = await deps.contours.notices(0);
      down = '';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== down) deps.log(`budget-relay: notices not read: ${reason}`);
      down = reason;
      return;
    }
    const latest = notices.at(-1)?.seq ?? 0;
    if (latest < cursor) cursor = 0;
    for (const notice of notices) {
      if (notice.seq <= cursor) continue;
      deps.deliver(notice);
      cursor = notice.seq;
      try {
        writeCursor(deps.statePath, cursor);
      } catch (error) {
        deps.log(
          `budget-relay: cursor not written: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  };

  const tick = (): Promise<void> => {
    ticking ??= once().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };

  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
