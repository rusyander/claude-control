import type {
  ProjectTestGroup,
  ProjectTestRunDiff,
  ProjectTestRunDiffCase,
  ProjectTestRunDiffSide,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { summarize } from '@agentdeck/contracts/test-format';
import { ProjectTestsNotFoundError } from './files.ts';
import { readRun, readRuns } from './runs-store.ts';
import { coded } from '../../lib/server-text.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Сравнение двух прогонов.
 *
 * Главный вопрос после регресса — «что сломалось с прошлого раза». Ответа на
 * него не было нигде: две записи истории открывались по отдельности, и человек
 * сличал списки глазами, а сотня кейсов глазами не сличается.
 *
 * Списки не пересекаются: кейс попадает ровно в один. Это не украшение — по
 * этим спискам жмут кнопки («перепрогнать провалившиеся»), и кейс, попавший в
 * два списка сразу, был бы запущен дважды.
 *
 * Отдельно считается СРАВНИМОСТЬ. Прогон по другому плану или в другом
 * окружении — это другой набор кейсов, и «починилось» в таком сравнении часто
 * значит «в этот раз не гоняли». Панель не отказывается сравнивать (человек
 * вправе), но говорит об этом прямо.
 */

/** Красное: провал и блокировка. Оба означают «результата нет». */
function isRed(status: ProjectTestStatus | undefined): boolean {
  return status === 'failed' || status === 'blocked';
}

/** Зелёное — только явное «пройдено»: пропуск победой не считается. */
function isGreen(status: ProjectTestStatus | undefined): boolean {
  return status === 'passed';
}

/** Ключ кейса в сравнении: параметры точки здесь не различаются намеренно. */
function keyOf(result: { groupId: string; caseId: string }): string {
  return `${result.groupId}:${result.caseId}`;
}

/** Последний результат кейса в прогоне: точек у кейса бывает несколько. */
function byCase(
  record: ProjectTestRunRecord,
): Map<string, ProjectTestRunRecord['results'][number]> {
  const map = new Map<string, ProjectTestRunRecord['results'][number]>();
  for (const result of record.results) {
    const key = keyOf(result);
    const seen = map.get(key);
    // Из нескольких точек одного кейса берём худшую: кейс, у которого хоть одна
    // точка красная, зелёным не является.
    if (!seen || (isRed(result.status) && !isRed(seen.status))) map.set(key, result);
  }
  return map;
}

function sideOf(record: ProjectTestRunRecord): ProjectTestRunDiffSide {
  return {
    id: record.id,
    startedAt: record.startedAt,
    mode: record.mode,
    planId: record.planId,
    environmentId: record.environmentId,
    release: record.release,
    summary: record.summary ?? summarize(record.results),
  };
}

/** Название кейса из библиотеки: в записи прогона его нет, а человеку нужно. */
function titleOf(groups: ProjectTestGroup[], groupId: string, caseId: string): string | undefined {
  return groups.find((group) => group.id === groupId)?.cases.find((item) => item.id === caseId)
    ?.title;
}

/** Чем наборы различаются — строка для человека, а не отказ сравнивать. */
function warningOf(from: ProjectTestRunRecord, to: ProjectTestRunRecord): string | undefined {
  const parts: string[] = [];
  if ((from.planId ?? '') !== (to.planId ?? ''))
    parts.push(serverText('tests-compare-plans-differ'));
  if ((from.environmentId ?? '') !== (to.environmentId ?? ''))
    parts.push(serverText('tests-compare-envs-differ'));
  if (from.mode !== to.mode) parts.push(serverText('tests-compare-modes-differ'));
  if (parts.length === 0) return undefined;
  return serverText('tests-compare-warning', { parts: parts.join(', ') });
}

/**
 * Сравнить два прогона. `from` — тот, что был раньше; порядок вызова панель
 * держит сама, чтобы «новые провалы» не оказались «починенными» наоборот.
 */
export function diffRuns(
  from: ProjectTestRunRecord,
  to: ProjectTestRunRecord,
  groups: ProjectTestGroup[] = [],
): ProjectTestRunDiff {
  const before = byCase(from);
  const after = byCase(to);

  const diff: ProjectTestRunDiff = {
    from: sideOf(from),
    to: sideOf(to),
    newFailures: [],
    fixed: [],
    stillFailing: [],
    untouched: [],
    added: [],
    removed: [],
    comparable: true,
  };

  for (const [key, result] of after) {
    const old = before.get(key);
    const item: ProjectTestRunDiffCase = {
      groupId: result.groupId,
      caseId: result.caseId,
      title: titleOf(groups, result.groupId, result.caseId),
      from: old?.status,
      to: result.status,
      note: result.note,
    };

    if (!old) {
      // Кейса в прошлом прогоне не было. Красный новичок — это тоже новый
      // провал: человек ищет в этом списке всё, что горит впервые.
      if (isRed(result.status)) diff.newFailures.push(item);
      else diff.added.push(item);
      continue;
    }

    if (isRed(result.status)) {
      if (isRed(old.status)) diff.stillFailing.push(item);
      else diff.newFailures.push(item);
      continue;
    }
    if (isRed(old.status) && isGreen(result.status)) {
      diff.fixed.push(item);
      continue;
    }
    diff.untouched.push(item);
  }

  for (const [key, old] of before) {
    if (after.has(key)) continue;
    diff.removed.push({
      groupId: old.groupId,
      caseId: old.caseId,
      title: titleOf(groups, old.groupId, old.caseId),
      from: old.status,
      note: old.note,
    });
  }

  diff.warning = warningOf(from, to);
  diff.comparable = diff.warning === undefined;
  return diff;
}

/**
 * Сравнить прогон с предыдущим по времени.
 *
 * «Предыдущий» — не «предыдущий в списке»: генерация и импорт тоже лежат в
 * истории, а сравнивать с ними нечего — у них нет пройденных кейсов. Поэтому
 * ищется ближайший прогон СТАРШЕ этого, у которого есть результаты.
 */
export function diffWithPrevious(
  root: string,
  id: string,
  baseId?: string,
  groups: ProjectTestGroup[] = [],
): ProjectTestRunDiff {
  const to = readRun(root, id);
  if (!to)
    throw coded(
      new ProjectTestsNotFoundError(`Прогона «${id}» в истории нет.`),
      'run-not-in-history',
      { id },
    );

  const from = baseId ? readRun(root, baseId) : previousOf(root, to);
  if (!from) {
    const error = new ProjectTestsNotFoundError(
      baseId
        ? serverText('tests-compare-base-missing', { id: baseId })
        : serverText('tests-compare-first-run'),
    );
    throw baseId
      ? coded(error, 'run-base-not-in-history', { baseId })
      : coded(error, 'compare-first-run');
  }
  return diffRuns(from, to, groups);
}

/** Ближайший прогон старше этого, у которого есть результаты. */
function previousOf(root: string, run: ProjectTestRunRecord): ProjectTestRunRecord | undefined {
  return readRuns(root, 200).find(
    (item) => item.id !== run.id && item.startedAt < run.startedAt && item.results.length > 0,
  );
}

/** Кейсы прогона, которые надо перепрогнать: провалы и блокировки. */
export function failedCases(record: ProjectTestRunRecord): string[] {
  const ids = record.results.filter((item) => isRed(item.status)).map((item) => item.caseId);
  return [...new Set(ids)];
}
