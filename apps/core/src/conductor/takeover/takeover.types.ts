import type { LiveTask } from '../../journal/resume.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';

/**
 * Порты перехвата и доработки (этап 12, зона Z4). Тело — проводка `bootstrap/takeover-wiring.ts`
 * над `conductor/takeover/**`. Нет порта — команда отказывает `takeover-unwired` /
 * `rework-unwired`, а не идёт мимо.
 */

export type TakeoverRefusal = { ok: false; code: string; reason: string };

/** Перехват единицы человеком: пауза в безопасной точке, место сеанса свободно, чат в копии. */
export interface TakeoverPort {
  /**
   * Открыть чат перехвата (`chat@1` на месте в копии единицы, грант на эту копию): ключ оценки —
   * `cmdId` команды, повтор находит тот же чат. Строки задачи-источника пишет команда, не порт.
   */
  open(
    task: LiveTask,
    cmdId: string,
  ): Promise<{ ok: true; unitId: string; copy: string; chatTaskId: string } | TakeoverRefusal>;
  /**
   * Вернуть ядру: чаты перехвата кончаются первыми (их сеансы сняты — иначе две руки в одной
   * копии); `ok` — ни одного живого сеанса чата перехвата не осталось.
   */
  close(task: LiveTask, cmdId: string): Promise<{ ok: true; ended: string[] } | TakeoverRefusal>;
}

/** Задача-источник доработки: законченная живой не бывает, поэтому — свёртка, не `LiveTask`. */
export interface ReworkSource {
  taskId: string;
  state: TaskFoldState;
}

/**
 * Доработка готовой работы словами человека (P162): один носитель ответов на открытый MR, ключ
 * его оценки — `cmdId` доработки, поэтому тот же `cmdId` дважды — та же задача.
 */
export interface ReworkPort {
  carrier(
    source: ReworkSource,
    cmdId: string,
    note: string,
  ): Promise<{ ok: true; carrierTaskId: string } | TakeoverRefusal>;
}
