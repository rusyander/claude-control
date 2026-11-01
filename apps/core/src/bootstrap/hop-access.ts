import {
  ensureHopHost,
  type EnsureHopHostOptions,
  type HopHostHandle,
} from '../routes/hops/hops.ts';

/**
 * Доступ ядра к хосту звеньев (11 §Hop chain, G3): хост поднимается при ПЕРВОМ зове (сеанс через
 * звено, чтение каталога с ключом, факт исчерпания), а не на загрузке — ядро без маршрутов
 * через звено отдельного процесса не заводит. Найденный хост держится в памяти; ушедший (зов
 * управления не прошёл) ищется заново тем же `ensureHopHost`, второго хоста на дом не будет.
 */
export interface HopAccess {
  handle(): Promise<HopHostHandle>;
  /** Хост ответил отказом связи — забыть его, следующий зов найдёт или поднимет заново. */
  forget(): void;
  /** Каталог данных панели, с которым ядро поднимает хост (ключи `panel-store`, правила). */
  readonly panelAppData: string | undefined;
}

export function createHopAccess(options: EnsureHopHostOptions): HopAccess {
  let pending: Promise<HopHostHandle> | undefined;
  return {
    panelAppData: options.panelAppData,
    handle: () => {
      pending ??= ensureHopHost(options).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    forget: () => {
      pending = undefined;
    },
  };
}
