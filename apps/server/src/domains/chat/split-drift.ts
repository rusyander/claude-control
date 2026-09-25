import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { serverText } from '../../lib/server-texts.ts';
import type { ChatEvent } from './ChatRunner.ts';

/**
 * Дрейф основной ветки под идущей группой (находка 61, решение владельца W3-3).
 *
 * Пересечения (`split-overlap.ts`) сверяют группы друг с другом, а основная
 * ветка за часы работы группы тоже уходит вперёд — и если она переписала тот же
 * файл, панель узнавала об этом конфликтом при слиянии. Здесь это становится
 * отметкой на группе и заметкой родителю — ОДИН раз на набор файлов.
 *
 * Ветку посреди работы панель не перестраивает: rebase — дело звена доставки
 * (`deliverStagePrompt`), где конфликт разбирает агент с человеком.
 */

/** Сколько общих файлов хранить на группу — как у счёта пересечений. */
const DRIFT_FILES_MAX = 20;
/** Сколько имён назвать в заметке — остальное числом. */
const DRIFT_FILES_NAMED = 3;

/** Группа ещё работает — её ветка живая, и дрейф под ней имеет смысл. */
const ACTIVE = new Set(['started', 'background', 'awaiting']);

/** Что основная ветка задела с развилки — `readTargetMoved`. */
export type MovedFiles = (input: {
  mainDir: string;
  target: string;
  branch: string;
}) => Promise<string[]>;

/**
 * Общие файлы: что задела группа и что задела основная с развилки. Ключ —
 * индекс группы; группы, чью основную прочитать не вышло, в ответе нет вовсе:
 * по ним отметку не трогаем, а не снимаем.
 */
export async function readDrift(input: {
  moved: MovedFiles;
  mainDir: string;
  target: string;
  groups: readonly { index: number; branch: string; files: readonly string[] }[];
  log: (message: string, error?: unknown) => void;
}): Promise<Map<number, string[]>> {
  const shared = new Map<number, string[]>();
  for (const group of input.groups) {
    try {
      const moved = new Set(
        await input.moved({ mainDir: input.mainDir, target: input.target, branch: group.branch }),
      );
      shared.set(
        group.index,
        group.files.filter((file) => moved.has(file)),
      );
    } catch (error) {
      input.log(`split drift: target unreadable for ${group.branch}`, error);
    }
  }
  return shared;
}

/** Группы, под которыми дрейф вообще считается: идут и держат копию. */
export function driftCandidates(record: SplitPlanRecord): Set<number> {
  return new Set(
    record.groups
      .filter((group) => group.path && !group.cleaned && ACTIVE.has(group.status))
      .map((group) => group.index),
  );
}

/**
 * Разложить прочитанное по записи и сказать о новом. Запись меняется на месте;
 * `emit` вернул `false` — сказать некуда, отметка остаётся несказанной и
 * догонит следующим пересчётом. Группа больше не идёт — отметку снимаем: дальше
 * её ветку переносит доставка, а старый список только врал бы.
 */
export function applyDrift(input: {
  record: SplitPlanRecord;
  target: string;
  shared: ReadonlyMap<number, string[]>;
  at: string;
  emit: (event: ChatEvent) => boolean;
}): void {
  const active = driftCandidates(input.record);
  for (const group of input.record.groups) {
    if (!active.has(group.index)) {
      delete group.drift;
      continue;
    }
    const files = input.shared.get(group.index);
    if (!files) continue;
    if (files.length === 0) {
      delete group.drift;
      continue;
    }
    const kept = files.slice(0, DRIFT_FILES_MAX);
    const same =
      group.drift?.target === input.target && group.drift.files.join('\0') === kept.join('\0');
    if (same && group.drift?.told) continue;
    const params = {
      group: group.title,
      target: input.target,
      files: files.slice(0, DRIFT_FILES_NAMED).join(', '),
      count: String(files.length),
    };
    const told = input.emit({
      kind: 'notice',
      code: 'defaultDrift',
      text: serverText('split-default-drift-notice', params),
      textCode: 'split-default-drift-notice',
      textParams: params,
    });
    group.drift = {
      at: same && group.drift ? group.drift.at : input.at,
      target: input.target,
      files: kept,
      ...(told ? { told: true } : {}),
    };
  }
}
