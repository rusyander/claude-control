import type { PlatformSpendRecord } from '@agentdeck/contracts';
import type { AppState } from './app-store.types.ts';

/**
 * Расход через контур, переживающий перезапуск панели.
 *
 * Живой счётчик шлюза считает от запуска процесса: панель перезапустилась —
 * бюджет «обнулился», и человек, у которого ключ уже на исходе, видел бы ноль.
 * Поэтому дневные итоги лежат здесь, рядом с прочим состоянием панели.
 *
 * СКЛАДЫВАЕТ ЗАПИСЬ ДОМЕН, а не это место: обрезка по числу дней, цены и
 * внутренняя единица контура — его дело (`domains/platform/spend.ts`). Здесь
 * только чтение, замена и уборка за удалённым контуром, как у `platformHealth`.
 *
 * Ключа контура тут нет и быть не может: в записи одни числа и имена моделей.
 */

// compromise: telemetry-local — приёма телеметрии от клиента у контура нет: расход панель пишет к себе на машину и никуда не отправляет

export function getPlatformSpend(state: AppState): Record<string, PlatformSpendRecord> {
  return structuredClone(state.platformSpend ?? {});
}

export function savePlatformSpend(state: AppState, record: PlatformSpendRecord): void {
  state.platformSpend ??= {};
  state.platformSpend[record.platformId] = record;
}

/** Контур удалён — расход уходит вместе с ним. */
export function forgetPlatformSpend(state: AppState, id: string): boolean {
  if (!state.platformSpend || !(id in state.platformSpend)) return false;
  delete state.platformSpend[id];
  return true;
}
