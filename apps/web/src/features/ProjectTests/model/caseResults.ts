import type {
  ProjectTestCaseResultEntry,
  ProjectTestFlakyMark,
  ProjectTestFlakyMarks,
} from '@agentdeck/contracts';
import { resultReason } from '@agentdeck/contracts/test-format';

/** Причина неуспеха одной строкой: номер шага (если разобран) и что вышло. */
export interface ResultReason {
  step?: number;
  text: string;
}

/**
 * Что сломалось в этом прогоне — одной строкой для истории кейса.
 *
 * Порядок общий с выгрузкой и отчётом вехи (`resultReason` в contracts):
 * разобранный провал точнее заметки — в нём «что вышло» на конкретном шаге.
 * Из заметки берётся первая непустая строка — дальше обычно стек или
 * подробности, которые в строке истории только мешают. Провал по шагу без
 * описания строки не даёт: номер шага без текста ничего не объясняет. У
 * пройденного причины нет, даже если исполнитель что-то написал: строка
 * истории объясняет неуспех.
 */
export function reasonOf(entry: ProjectTestCaseResultEntry): ResultReason | undefined {
  if (entry.status !== 'failed' && entry.status !== 'blocked' && entry.status !== 'skipped') {
    return undefined;
  }
  const reason = resultReason(entry);
  const line = reason?.text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? { step: reason?.step, text: line } : undefined;
}

/** Отметки нестабильности по ключу строки таблицы — «группа:кейс». */
export function flakyIndex(
  marks: ProjectTestFlakyMarks | undefined,
): Map<string, ProjectTestFlakyMark> {
  return new Map((marks?.cases ?? []).map((mark) => [`${mark.groupId}:${mark.caseId}`, mark]));
}

/**
 * Адрес записи прогона из истории кейса: вкладка прогонов, раскрытый прогон и
 * ПРОЕКТ. Карточка кейса живёт и в окне тестов чата, где проект — каталог
 * чата, а раздел «Тестирование» помнит свой выбор; без проекта ссылка вела в
 * историю чужого проекта, где такого прогона нет, и раздел молчал.
 */
export function caseRunSearch(
  projectPath: string | undefined,
  runId: string,
): { tab: 'runs'; run: string; project?: string } {
  return { tab: 'runs', run: runId, ...(projectPath ? { project: projectPath } : {}) };
}
