import type { ChatMessage } from './chat';

/**
 * Время работы агента по записям транскрипта.
 *
 * У каждой записи есть `timestamp`, но времени «сколько агент думал над этим
 * блоком» в транскрипте нет: оно и есть разница между соседними записями одного
 * прогона. Прогон — всё от реплики человека до следующей реплики человека, а
 * шаг — от предыдущей записи (человека или агента) до этой. Последняя запись
 * прогона несёт ещё и его сумму: от реплики человека до конца.
 *
 * Считается ОДИН раз на ленту и одинаково в панели и на телефоне — поэтому
 * живёт в контрактах, а не в двух копиях по приложениям.
 */
export interface MessageTiming {
  /** От предыдущей записи прогона до этой, мс. */
  stepMs: number;
  /** Границы шага — для подсказки «старт → конец». */
  from: string;
  to: string;
  /** Есть только у последней записи ЗАКОНЧЕННОГО прогона: от реплики человека до неё. */
  runTotalMs?: number;
}

export interface MessageTimingOptions {
  /**
   * Прогон ещё идёт: у его последней записи суммы нет — она не последняя, просто
   * следующая ещё пишется. Без этого флага хвост ленты врал бы «итог» на каждом
   * шаге живого прогона.
   */
  openRun?: boolean;
}

/**
 * Время каждой записи агента по её id. Записи без `timestamp` (старые
 * транскрипты) времени не получают и соседям его не дают: измерять «от
 * неизвестно когда» значит показывать выдуманное число.
 */
export function collectMessageTimings(
  messages: readonly ChatMessage[],
  options: MessageTimingOptions = {},
): Map<string, MessageTiming> {
  const out = new Map<string, MessageTiming>();
  let prev: { at: number; iso: string } | undefined;
  let runStart: number | undefined;
  let lastOfRun: string | undefined;

  const closeRun = (): void => {
    if (lastOfRun !== undefined && runStart !== undefined) {
      const timing = out.get(lastOfRun);
      if (timing) timing.runTotalMs = Math.max(0, Date.parse(timing.to) - runStart);
    }
    lastOfRun = undefined;
  };

  for (const message of messages) {
    const at = Date.parse(message.timestamp);
    const known = !Number.isNaN(at);

    if (message.role === 'user') {
      closeRun();
      runStart = known ? at : undefined;
      prev = known ? { at, iso: message.timestamp } : undefined;
      continue;
    }

    if (known && prev) {
      out.set(message.id, {
        stepMs: Math.max(0, at - prev.at),
        from: prev.iso,
        to: message.timestamp,
      });
      lastOfRun = message.id;
    }
    prev = known ? { at, iso: message.timestamp } : undefined;
  }
  if (!options.openRun) closeRun();
  return out;
}

export interface DurationUnits {
  h: string;
  m: string;
  s: string;
}

/**
 * `4с` · `1м 12с` · `1ч 03м` — одна форма для панели и телефона. Секунды
 * пропадают за часом: там они уже не читаются как информация.
 */
export function formatDurationWith(ms: number, units: DurationUnits): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}${units.s}`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}${units.m} ${String(total % 60).padStart(2, '0')}${units.s}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${units.h} ${String(minutes % 60).padStart(2, '0')}${units.m}`;
}
