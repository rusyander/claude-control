import {
  BOARD_STOPS,
  type BoardEntryDraft,
  type BoardLaunch,
  type BoardLimits,
  type BoardSource,
  type BoardStop,
} from '@agentdeck/contracts/core/board';
import { BOARD_DEFAULTS } from '@agentdeck/contracts/core/config';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';

/**
 * «В очередь» формы запуска (этап 12, B9): вместо оценки сейчас форма кладёт запись на доску ядра,
 * и ядро стартует задачу само, когда освободится место (P183). Запись несёт ровно поля оценки —
 * старт идёт тем же путём оценки, что и кнопка «Оценить», — плюс остановку, выбранную человеком.
 */

type LaunchFields = Extract<BoardLaunch, { kind: 'fields' }>['fields'];

/** Варианты остановки по порядку: до плана, до MR, до конца. */
export const STOP_CHOICES: readonly BoardStop[] = BOARD_STOPS;

/**
 * Остановка по умолчанию — из пределов доски (раздел `board` ядра, D5); ответа доски нет — то же
 * умолчание, что у ядра (`BOARD_DEFAULTS`, «до MR»), а не своя догадка формы.
 */
export function defaultStopOf(limits: Pick<BoardLimits, 'defaultStop'> | undefined): BoardStop {
  return limits?.defaultStop ?? BOARD_DEFAULTS.defaultStop;
}

/** Источник карточки: задача трекера — с ключом (по нему доска узнаёт повтор), остальное — ручная. */
function sourceOf(fields: EstimateFields): BoardSource {
  const tracker = fields.source?.kind === 'tracker' ? fields.source : undefined;
  return {
    kind: tracker ? 'tracker' : 'manual',
    ...(tracker?.key ? { key: tracker.key } : {}),
    title: fields.title,
  };
}

/**
 * Черновик записи доски из готовых полей оценки. `preset` — пресет сценария; у сценария библиотеки
 * пресета нет, и запись несёт его id (поле — подпись для доски, старт берёт сценарий из `fields`).
 */
export function entryDraftOf(fields: EstimateFields, stop: BoardStop): BoardEntryDraft {
  const preset = 'preset' in fields.scenario ? fields.scenario.preset : fields.scenario.id;
  return {
    stop,
    preset,
    source: sourceOf(fields),
    // Поля оценки — JSON по схеме ядра; тип контракта записи шире (`z.json()`), сужение без копии.
    launch: { kind: 'fields', fields: fields as unknown as LaunchFields },
  };
}
