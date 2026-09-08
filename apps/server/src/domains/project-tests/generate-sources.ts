import type {
  ProjectTestGenerateMaterial,
  ProjectTestGenerateStamp,
  ProjectTestGroup,
  ProjectTestRunRequest,
} from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';
import type { AppStore } from '../../lib/app-store.ts';
import { gitSync } from '../project-git/exec.ts';
import { toAccess } from '../integrations/atlassian/client.ts';
import { readIssue } from '../integrations/atlassian/jira.ts';
import { readIntegrations, readToken } from '../integrations/store.ts';
import { ProjectTestsError, ProjectTestsNotFoundError } from './files.ts';
import { requirementKey } from './coverage.ts';
import { readRun } from './runs-store.ts';

/**
 * Материал для генерации: требование, дифф или провал.
 *
 * Генерация «по коду» отвечает на вопрос «что тут есть». В работе спрашивают
 * другое — покрыть требование, проверить изменённое в ветке, закрепить
 * починенный баг, — и разница между этими заданиями не в режиме прогона, а в
 * том, ЧТО агенту дали прочитать. Собирает это панель, а не агент: она уже
 * умеет ходить в трекер и в git, а лишний поход агента стоит окна и времени.
 *
 * Собирается ДО старта. Не собралось — прогон не начинается, и человек читает
 * причину: генерация «по требованию», не увидевшая требования, написала бы
 * правдоподобные кейсы ни о чём, и отличить их было бы нечем.
 */

export interface GenerateSourceDeps {
  store: AppStore;
  appDataDir: string;
  root: string;
}

/** Диапазон по умолчанию: что моя ветка добавила к общей. */
export const DEFAULT_DIFF_RANGE = 'origin/main..HEAD';

export async function collectSource(
  deps: GenerateSourceDeps,
  request: ProjectTestRunRequest,
  groups: ProjectTestGroup[],
): Promise<ProjectTestGenerateMaterial | undefined> {
  const source = request.source ?? 'code';
  if (source === 'code') return undefined;
  if (source === 'requirement') return { source, requirement: await requirement(deps, request) };
  if (source === 'diff') return { source, diff: diff(deps.root, request.diffRange) };
  return { source, defect: defect(deps.root, request, groups) };
}

/**
 * След источника: то немногое, что панель проставит кейсам САМА при приёмке.
 *
 * Задание агенту требует того же самого словами, но забытая ссылка на
 * требование означает строку матрицы, которая осталась непокрытой после
 * генерации, сделанной ровно ради неё. Проверяемое обещание должен держать код.
 *
 * Пути диффа режутся: `codePaths` из сотни файлов не отбор, а «всегда задето».
 */
export function stampOf(
  material: ProjectTestGenerateMaterial | undefined,
): ProjectTestGenerateStamp | undefined {
  if (!material || material.source === 'code') return undefined;
  return {
    source: material.source,
    requirementUrl: material.requirement?.url,
    requirementKey: material.requirement?.key,
    codePaths: material.diff?.files.slice(0, STAMP_PATHS),
    defectUrl: material.defect?.url,
  };
}

/** Сколько путей диффа доходит до кейса без собственных `codePaths`. */
const STAMP_PATHS = 20;

/**
 * Требование из трекера.
 *
 * Читается ЦЕЛИКОМ, вместе с описанием: кейсы пишутся по тексту задачи, а не по
 * её заголовку. Без подключённого Atlassian источник недоступен — и это отказ с
 * причиной, а не пустое задание: кейсы «по требованию QA-42», написанные без
 * QA-42, покрытием не являются.
 */
async function requirement(
  deps: GenerateSourceDeps,
  request: ProjectTestRunRequest,
): Promise<ProjectTestGenerateMaterial['requirement']> {
  const ref = request.sourceRef?.trim();
  if (!ref) throw new ProjectTestsError('Не указано требование: нужен ключ задачи или ссылка.');

  const settings = readIntegrations(deps.store).atlassian;
  const token = readToken(deps.appDataDir, 'atlassian');
  if (!settings.enabled || !token) {
    throw new ProjectTestsError(
      'Jira не подключена, а «покрыть требование» пишет кейсы по тексту задачи. ' +
        'Подключите Atlassian в разделе интеграций или выберите другой источник.',
    );
  }

  const key = requirementKey(ref);
  try {
    const issue = await readIssue(toAccess(settings, token), key);
    return {
      key: issue.key,
      url: issue.url,
      title: issue.summary,
      description: issue.description,
    };
  } catch (error) {
    // Отказ трекера — состояние, а не поломка: человек прочитает причину и
    // либо поправит ключ, либо пойдёт другим источником.
    throw new ProjectTestsError(
      `Задача «${key}» не прочиталась: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Дифф ветки: ПУТИ и сводка, а не сами хунки.
 *
 * Патч целиком раздул бы задание до размеров изменения и вытеснил из окна
 * библиотеку, ради которой прогон и запущен. Агент работает в том же каталоге —
 * нужный файл он откроет сам, а список путей отвечает на главный вопрос: что
 * вообще трогали.
 */
function diff(root: string, range?: string): ProjectTestGenerateMaterial['diff'] {
  const wanted = range?.trim() || DEFAULT_DIFF_RANGE;
  const names = gitSync(root, ['diff', '--name-only', wanted]);
  if (names === undefined) {
    throw new ProjectTestsError(
      `Сравнение «${wanted}» не сделалось: каталог не репозиторий или такой ветки нет.`,
    );
  }
  const files = names
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line.length > 0 && !line.startsWith('.agent/tests/'));

  if (files.length === 0) {
    throw new ProjectTestsError(`Между «${wanted}» нет изменений — генерировать нечего.`);
  }

  return {
    range: wanted,
    files,
    summary: gitSync(root, ['diff', '--stat', wanted])?.trim().split('\n').slice(-1)[0],
  };
}

/**
 * Провал, из которого заводится регрессионный кейс.
 *
 * Берётся ПОСЛЕДНИЙ результат по этому кейсу в названном прогоне: шаги,
 * заметка исполнителя и вложения. Исходный кейс не трогается — он описывает
 * работающее поведение, а регрессионный закрепляет починку.
 */
function defect(
  root: string,
  request: ProjectTestRunRequest,
  groups: ProjectTestGroup[],
): ProjectTestGenerateMaterial['defect'] {
  const target = request.sourceCase;
  if (!target?.caseId) throw new ProjectTestsError('Не указан кейс, из провала которого заводить.');

  const group = groups.find((item) => item.id === target.groupId);
  const testCase = group?.cases.find((item) => item.id === target.caseId);
  if (!testCase) {
    throw new ProjectTestsNotFoundError(`Кейса «${target.caseId}» в проекте нет.`);
  }

  const run = target.runId ? readRun(root, target.runId) : undefined;
  const result = run?.results.find(
    (item) => item.caseId === target.caseId && item.groupId === target.groupId,
  );

  return {
    groupId: group?.id ?? target.groupId,
    caseId: testCase.id,
    title: testCase.title,
    steps: testCase.steps.map((step) => stepText(step)),
    note: result?.note,
    attachments: result?.attachments ?? [],
    // Заведённый дефект — та самая задача, на которую регрессионный кейс и
    // должен сослаться: по ней потом видно, что починку закрепили.
    url: (testCase.defects ?? [])[0]?.url,
  };
}
