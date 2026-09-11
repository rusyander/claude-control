import type {
  ProjectTestGenerateMaterial,
  ProjectTestGenerateStamp,
  ProjectTestGroup,
  ProjectTestRunRequest,
} from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';
import type { AppStore } from '../../lib/app-store.ts';
import { gitSync, gitSyncOutcome } from '../project-git/exec.ts';
import { GIT_READ_TIMEOUT_MS } from '../project-git/constants.ts';
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
 * Кандидаты диапазона, когда явного не задали. Панель локальная: у половины
 * проектов нет `origin`, а ветка одна — и `origin/main..HEAD` отвечал «не
 * репозиторий или нет ветки» про каталог, в котором git есть. Первый диапазон
 * с изменениями и берётся; чистые все — остаётся рабочая копия.
 */
const RANGE_CANDIDATES = [DEFAULT_DIFF_RANGE, 'origin/master..HEAD', 'main..HEAD', 'master..HEAD'];
/** Подпись источника, когда сравнивали не ветки, а незакоммиченные правки. */
export const WORKING_TREE_RANGE = 'рабочая копия';

/**
 * Срок диффа — не тот же, что у вопроса «изменилось ли хоть что-то».
 *
 * `gitSync` заведён с пятисекундным потолком под мгновенный вопрос планировщика,
 * а здесь git обходит настоящий дифф ветки: на большом репозитории, на медленном
 * диске и под антивирусом это дольше пяти секунд легко. Вышедший срок отдавался
 * тем же «ответа нет», и человек читал про несуществующую ветку в каталоге, где
 * и репозиторий, и ветка на месте.
 */
const DIFF_TIMEOUT_MS = GIT_READ_TIMEOUT_MS;

function changedFiles(root: string, range: string): string[] | undefined {
  const names = gitSync(root, ['diff', '--name-only', range], DIFF_TIMEOUT_MS);
  return names === undefined ? undefined : cleanPaths(names);
}

/**
 * Почему сравнение не получилось — словами, а не одним «не вышло». Срок,
 * отсутствующий git и настоящий отказ git чинятся в разных местах, а иногда
 * (срок) не чинятся вовсе, и тогда честнее сказать это прямо.
 */
function diffFailure(root: string, range: string): string {
  const outcome = gitSyncOutcome(root, ['diff', '--name-only', range], DIFF_TIMEOUT_MS);
  if (outcome.ok) return `Сравнение «${range}» не сделалось.`;
  if (outcome.reason === 'timeout') {
    return `Сравнение «${range}» не сделалось: git не ответил за ${DIFF_TIMEOUT_MS / 1000} с. Репозиторий тут ни при чём — так бывает на большом дереве, на медленном диске и под антивирусом.`;
  }
  if (outcome.reason === 'no-git') {
    return 'Команда git не найдена. Установите git или добавьте его в PATH.';
  }
  return `Сравнение «${range}» не сделалось: каталог не репозиторий или такой ветки нет.`;
}

function cleanPaths(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line.length > 0 && !line.startsWith('.agent/tests/'));
}

function statOf(root: string, range: string): string | undefined {
  // Сводка — тот же обход дерева, что и сам дифф, и срок ей нужен тот же.
  return gitSync(root, ['diff', '--stat', range], DIFF_TIMEOUT_MS)?.trim().split('\n').slice(-1)[0];
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
  const explicit = range?.trim();
  if (explicit) {
    const files = changedFiles(root, explicit);
    if (files === undefined) throw new ProjectTestsError(diffFailure(root, explicit));
    if (files.length === 0) {
      throw new ProjectTestsError(`Между «${explicit}» нет изменений — генерировать нечего.`);
    }
    return { range: explicit, files, summary: statOf(root, explicit) };
  }

  if (gitSync(root, ['rev-parse', '--verify', 'HEAD']) === undefined) {
    throw new ProjectTestsError(
      `Сравнение «${DEFAULT_DIFF_RANGE}» не сделалось: каталог не git-репозиторий ` +
        'или в нём нет ни одного коммита.',
    );
  }
  for (const candidate of RANGE_CANDIDATES) {
    const files = changedFiles(root, candidate);
    if (files && files.length > 0) {
      return { range: candidate, files, summary: statOf(root, candidate) };
    }
  }
  // Ветки чистые или их нет: незакоммиченные правки плюс новые файлы — то, над
  // чем человек работает прямо сейчас.
  const tracked = changedFiles(root, 'HEAD') ?? [];
  const untracked = cleanPaths(
    gitSync(root, ['ls-files', '--others', '--exclude-standard'], DIFF_TIMEOUT_MS) ?? '',
  );
  const files = [...new Set([...tracked, ...untracked])];
  if (files.length === 0) {
    throw new ProjectTestsError(
      `Ни «${RANGE_CANDIDATES.join('», «')}», ни рабочая копия изменений не дали — ` +
        'генерировать нечего. Укажите диапазон явно, например «v1.0.0..HEAD».',
    );
  }
  return { range: WORKING_TREE_RANGE, files, summary: statOf(root, 'HEAD') };
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
