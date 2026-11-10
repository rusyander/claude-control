import type { ProjectTestPointResult } from '@agentdeck/contracts';
import type { BoardCard, BoardEntryDraft } from '@agentdeck/contracts/core/board';

/** Перевод текста по ключу `coreInbox.tests.*` с подстановками — снаружи, чтобы черновик был чистым. */
export type TestsText = (key: string, values?: Record<string, string | number>) => string;

export interface TestsEntryInput {
  projectPath: string;
  runId: string;
  title: string;
  result: Pick<ProjectTestPointResult, 'groupId' | 'caseId' | 'note' | 'params' | 'failure'>;
  lang: 'ru' | 'en';
}

/** Ключ источника записи: кейс `группа/кейс`; по нему кнопка узнаёт запись кейса на доске. */
export const testsEntryKey = (groupId: string, caseId: string) => `${groupId}/${caseId}`;

/**
 * Текст задачи из провала: кейс и прогон, шаг, ожидалось / вышло, заметка, параметры и цель.
 * Только то, что лежит в записи прогона, — пересказывать провал человеку не нужно.
 */
export function testsRequestOf(input: TestsEntryInput, t: TestsText): string {
  const { result } = input;
  const lines = [
    t('request', {
      group: result.groupId,
      case: result.caseId,
      title: clip(input.title, PART_MAX),
      run: input.runId,
    }),
  ];
  const failure = result.failure;
  if (failure?.step !== undefined) lines.push(t('step', { step: failure.step }));
  if (failure?.expected) lines.push(t('expected', { text: clip(failure.expected, PART_MAX) }));
  if (failure?.actual) lines.push(t('actual', { text: clip(failure.actual, PART_MAX) }));
  if (result.note) lines.push(t('note', { text: clip(result.note, PART_MAX) }));
  const params = Object.entries(result.params ?? {});
  if (params.length > 0) {
    const text = params.map(([name, value]) => `${name}=${value}`).join(', ');
    lines.push(t('params', { text: clip(text, PART_MAX) }));
  }
  // Цель — последней строкой всегда: обрезается разбор провала, а не то, что просят сделать.
  lines.push(t('goal'));
  return lines.join('\n');
}

/**
 * Предел текста задачи — `estimateFieldsSchema.request` (64 000): с ним ядро оценивает запись при
 * старте. Провал раннера бывает со стеком на сотни килобайт — без обрезки запись легла бы во
 * «Входящие», а старт отказал бы. Пять свободных частей (название, ожидалось, вышло, заметка,
 * параметры) по `PART_MAX` с подписями и целью остаются ниже предела.
 */
const PART_MAX = 12_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Запись этого кейса уже на доске: открытая карточка с источником `tests` и тем же ключом. Ядро
 * записи по ключу кейса не склеивает, поэтому «На доске» после перезагрузки держит сама доска;
 * влитая или закрытая карточка не мешает положить новый провал.
 */
export function caseOnBoard(
  cards: readonly Pick<BoardCard, 'column' | 'source'>[] | undefined,
  key: string,
): boolean {
  return (cards ?? []).some(
    (card) =>
      card.column !== 'closed' &&
      card.column !== 'merged' &&
      card.source?.kind === 'tests' &&
      card.source.key === key,
  );
}

/**
 * Запись «Входящих» из красного кейса (этап 12, I7): пресет «исправить дефект», источник `tests`
 * с ключом кейса, поля запуска — текст провала и репозиторий проекта «Тестов». В очередь её
 * ставит человек на доске; задачу запись не создаёт.
 */
export function testsEntryDraft(input: TestsEntryInput, t: TestsText): BoardEntryDraft {
  const { result } = input;
  return {
    preset: 'bug-fix',
    source: {
      kind: 'tests',
      key: testsEntryKey(result.groupId, result.caseId),
      title: t('title', { title: input.title }).slice(0, 500),
    },
    launch: {
      kind: 'fields',
      fields: {
        request: testsRequestOf(input, t),
        repos: [{ path: input.projectPath, baseRef: null }],
        lang: input.lang,
      },
    },
  };
}
