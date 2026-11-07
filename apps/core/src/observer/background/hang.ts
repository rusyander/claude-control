import type { BgItem, BgKind } from '@agentdeck/contracts/core/agents';
import type { FiredVerdict } from '../observer.types.ts';

export const BG_HANG_SIGNAL = 'bg-hang';

/** Сколько вывод фоновой работы может стоять, пока владелец жив, прежде чем о ней сказать. */
export const BG_HANG_AFTER_MS = 600_000;

/**
 * Сервер и монитор молчат по своей природе (ждут запросов, событий): тишина вывода у них не
 * зависание. Прочее (оболочка, долгий инструмент) с неподвижным выводом — повод показать.
 */
export const HANG_EXEMPT: readonly BgKind[] = ['server', 'monitor'];

/** Что сторож помнит о выводе работы: размер и когда он последний раз менялся. */
export interface HangMark {
  size: number;
  since: number;
  /** Сигнал по работе уже выдан (не `fired`: поиск каталога читает `fired: true` как вердикт). */
  told: boolean;
}

/**
 * Шаг сторожа зависания (этап 11, P148): новый замер размера файла вывода. Размер сдвинулся —
 * отсчёт заново; стоит `afterMs` и дольше при живом владельце — один вердикт `bg-hang` на работу.
 * Работа без файла вывода (`size === null` с первого замера) и исключённые виды — молчат: судить
 * не по чему. Пропавший файл — тоже не зависание (его снёс CLI).
 */
export function hangStep(
  item: BgItem,
  mark: HangMark | undefined,
  size: number | null,
  now: number,
  afterMs: number = BG_HANG_AFTER_MS,
): { mark: HangMark | undefined; verdict: FiredVerdict | null } {
  if (HANG_EXEMPT.includes(item.kind) || size === null) return { mark, verdict: null };
  if (!mark || mark.size !== size)
    return { mark: { size, since: now, told: false }, verdict: null };
  const quiet = now - mark.since;
  if (mark.told || quiet < afterMs) return { mark, verdict: null };
  return {
    mark: { ...mark, told: true },
    verdict: {
      fired: true,
      signal: BG_HANG_SIGNAL,
      subject: item.itemId,
      detail: `background ${item.kind} ${item.itemId} wrote no output for ${Math.round(quiet / 1000)} s (output stuck at ${size} bytes) while its owner is alive`,
      reasons: [
        `output size unchanged for ${quiet} ms >= ${afterMs} ms`,
        'owner session still running; shown only, nothing is stopped',
      ],
      key: `${BG_HANG_SIGNAL}:${item.itemId}`,
      stepId: item.ownerChain.stepId,
      sessionId: item.ownerChain.sessionId,
    },
  };
}
