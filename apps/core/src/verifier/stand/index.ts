import type { StandEpoch, StandState, StandWatch } from './stand.types.ts';

export { createStandWatch, readHealth } from './watch.ts';
export type { StandEpoch, StandState, StandWatch, StandWatchOptions } from './stand.types.ts';

/**
 * Стенды живых задач (04:75-77): один на задачу, когда профиль говорит «без состояния на
 * прогон», иначе на единицу — ключ тогда `<taskId>/<unit>` (решение вызывающего). `standEpoch`
 * — вход зоны C: `null` — стенда нет и не было.
 *
 * Эпоха ключа живёт в реестре, а не в наблюдении: повторное `attach` (стенд перезапущен новым
 * процессом) и `detach` (стенд снят посреди прогона) сдвигают её, а не сбрасывают в 0 / `null`.
 * Каждое чтение — свежее (`tick`), не кэш таймера: падение в последнюю секунду прогона видно.
 * Нездоровое чтение тоже сдвигает эпоху: прогон, начатый или законченный на нездоровом стенде,
 * сравнением до/после получает `no-verdict(stand)`, а не красный на код (04:76).
 */
export interface StandRegistry {
  attach(key: string, watch: StandWatch): void;
  detach(key: string): StandWatch | undefined;
  get(key: string): StandWatch | undefined;
  standEpoch: StandEpoch;
}

const UNREAD: StandState = { epoch: 0, healthy: false, lastReason: 'tick failed' };

export function createStandRegistry(): StandRegistry {
  const watches = new Map<string, StandWatch>();
  // Сдвиг ключа поверх эпохи текущего наблюдения; есть сдвиг без наблюдения — стенд снят.
  const offsets = new Map<string, number>();

  const read = async (key: string): Promise<number | null> => {
    const watch = watches.get(key);
    const offset = offsets.get(key);
    if (!watch) return offset ?? null;
    const state = await watch.tick().catch(() => UNREAD);
    let next = offset ?? 0;
    if (state.healthy !== true) {
      next += 1;
      offsets.set(key, next);
    }
    return next + state.epoch;
  };

  const retire = (key: string): StandWatch | undefined => {
    const watch = watches.get(key);
    if (!watch) return undefined;
    watch.stop();
    watches.delete(key);
    offsets.set(key, (offsets.get(key) ?? 0) + watch.state().epoch + 1);
    return watch;
  };

  return {
    attach(key, watch) {
      if (!retire(key) && offsets.has(key)) offsets.set(key, (offsets.get(key) as number) + 1);
      watches.set(key, watch);
      watch.start();
    },
    detach: (key) => retire(key),
    get: (key) => watches.get(key),
    async standEpoch(taskId, unit) {
      if (unit !== undefined) {
        const own = `${taskId}/${unit}`;
        if (watches.has(own) || offsets.has(own)) return read(own);
        return read(taskId);
      }
      // Без единицы — стенд задачи и стенды её единиц вместе: сдвиг любого виден.
      const keys = [...new Set([...watches.keys(), ...offsets.keys()])]
        .filter((k) => k === taskId || k.startsWith(`${taskId}/`))
        .sort();
      if (keys.length === 0) return null;
      let sum = 0;
      for (const key of keys) sum += (await read(key)) ?? 0;
      return sum;
    },
  };
}
