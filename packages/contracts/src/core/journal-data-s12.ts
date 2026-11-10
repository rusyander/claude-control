import { z } from 'zod';
import { BOARD_PROOF_KINDS, BOARD_SOURCE_KINDS, BOARD_STOPS } from './board.ts';
import { browseGapSchema, browseStepSchema } from './browse.ts';
import { registryId, uuidv7 } from './ids.ts';

/**
 * Виды журнала этапа 12 (08e): перехват единицы человеком, остановка задачи, конец MR, потеря
 * входа маршрута и проход по стенду (`browse.*`, волна 3). Свой модуль, а не строки в `journal-data.ts`: тот и так велик, а таблица видов
 * собирается из обоих (`JOURNAL_DATA_V1`). Строгие, как все виды: лишнее поле — отказ.
 */

const nonNeg = z.number().int().nonnegative();

/**
 * Запись доски, с которой задача стартовала (`task.created.boardEntry`). Нет поля — задача не с
 * доски (журнал до этапа 12, чат, ревью по ссылке): поведение — по настройке репозитория (P157).
 */
export const taskBoardEntrySchema = z.strictObject({
  entryId: uuidv7,
  stop: z.enum(BOARD_STOPS),
  source: z.enum(BOARD_SOURCE_KINDS),
  /** Чьим доказательством старт: ход человека или запись настройки (P183) — `cmdId` того хода. */
  proof: z.strictObject({ kind: z.enum(BOARD_PROOF_KINDS), cmdId: uuidv7 }),
});

/** Чат перехвата (`chat@1` в копии единицы) знает, чью единицу он ведёт: по нему конец чата. */
export const takeoverOfSchema = z.strictObject({ taskId: uuidv7, unitId: uuidv7 });

export const JOURNAL_DATA_S12 = {
  /** Перехват открыт: конвейер задачи стоит, единицу ведёт человек в копии `copy`. */
  'task.takeover': z.strictObject({
    unitId: uuidv7,
    copy: z.string().min(1).max(1000),
    /** Чат перехвата (`chat@1` в копии): ссылка «Открыть чат» на доске и в виде задачи. */
    chatTaskId: uuidv7.optional(),
  }),
  /** Перехват закрыт возвратом ядру; `note` — что сделал человек (уходит в бриф шага). */
  'task.handback': z.strictObject({ note: z.string().max(16_000).optional() }),
  /** Новая остановка задачи (`set-stop`); последняя строка действует. */
  'task.stop': z.strictObject({ stop: z.enum(BOARD_STOPS) }),
  /** Конец MR, прочитанный у форжа: слит или закрыт (колонки «Слито» и «Закрыто», P152). */
  'publish.mr-state': z.strictObject({
    unitId: uuidv7,
    state: z.enum(['merged', 'closed']),
    at: nonNeg,
  }),
  /** Маршрут потерял вход CLI посреди шага: вопрос пункта 4 с источником `login`. */
  'route.login-lost': z.strictObject({ routeId: registryId, stepId: uuidv7 }),
  /** Действие прохода по стенду инструментом ядра (шаг `walk`, P177): основа спека записи. */
  'browse.step': browseStepSchema,
  /** Действие вне умений ядра (наведение, перетаскивание, выбор файла): пробел отчёта. */
  'browse.gap': browseGapSchema,
} as const;
