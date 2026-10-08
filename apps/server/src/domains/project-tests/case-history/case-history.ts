import type {
  ProjectTestCaseHistory,
  ProjectTestCaseResultEntry,
  ProjectTestFlakyMark,
  ProjectTestFlakyMarks,
  ProjectTestFlakyVerdict,
  ProjectTestPointResult,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';
import { FLAKY_MIN_FLIPS, FLAKY_WINDOW } from '@agentdeck/contracts/project-test-case-history';
import { caseStatusHistory, HISTORY_SEVERITY, readRuns } from '../runs-store/runs-store.ts';

/**
 * История результатов одного кейса и отметка «нестабилен» — только чтение
 * записей прогонов, ничего не пишет.
 *
 * Своим модулем, а не в `runs-store.ts`: хранилище прогонов ведёт другая
 * сторона работы, а это — взгляд на него из карточки кейса и строки
 * библиотеки.
 */

/** Сколько последних прогонов читается: история длиннее в карточке не читается. */
const HISTORY_RUNS = 50;

/**
 * Тяжесть исхода: в прогоне решает худший проход кейса. Таблица одна — та же,
 * что у отметок библиотеки (`runs-store.ts`): своя копия ставила пропуск выше
 * прохода, и карточка кейса молча расходилась с библиотекой.
 */
const SEVERITY = HISTORY_SEVERITY;

/** Проходы этого кейса в прогоне и решающий среди них (худший). */
function pointsOf(
  run: ProjectTestRunRecord,
  groupId: string,
  caseId: string,
): { decisive: ProjectTestPointResult; count: number } | undefined {
  let decisive: ProjectTestPointResult | undefined;
  let count = 0;
  for (const result of run.results) {
    if (result.groupId !== groupId || result.caseId !== caseId) continue;
    count += 1;
    if (!decisive || (SEVERITY[result.status] ?? 0) > (SEVERITY[decisive.status] ?? 0)) {
      decisive = result;
    }
  }
  return decisive ? { decisive, count } : undefined;
}

/**
 * Нестабилен ли кейс по его исходам, от старых к новым.
 *
 * Считаются только решающие исходы (пройден/провален) из последних
 * `FLAKY_WINDOW`: пропуск ничего не говорит о тесте, а давняя чехарда не
 * должна метить кейс, который с тех пор стабильно зелёный. Одна смена — это
 * поломка или починка; `FLAKY_MIN_FLIPS` и больше — мигающий тест.
 */
export function flakyVerdict(statusesOldestFirst: readonly string[]): ProjectTestFlakyVerdict {
  const decisive = statusesOldestFirst
    .filter((status) => status === 'passed' || status === 'failed')
    .slice(-FLAKY_WINDOW);
  let flips = 0;
  for (let index = 1; index < decisive.length; index += 1) {
    if (decisive[index] !== decisive[index - 1]) flips += 1;
  }
  return { isFlaky: flips >= FLAKY_MIN_FLIPS, flips, runs: decisive.length };
}

/** История кейса по прогонам (прогоны — от новых к старым, как их отдаёт хранилище). */
export function caseHistory(
  runs: readonly ProjectTestRunRecord[],
  groupId: string,
  caseId: string,
): ProjectTestCaseHistory {
  const entries: ProjectTestCaseResultEntry[] = [];
  for (const run of runs) {
    const found = pointsOf(run, groupId, caseId);
    if (!found) continue;
    const { decisive, count } = found;
    entries.push({
      runId: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      mode: run.mode,
      actor: run.actor,
      release: run.release,
      environmentId: decisive.environmentId ?? run.environmentId,
      branch: run.branch,
      commit: run.commit,
      status: decisive.status,
      points: count,
      note: decisive.note,
      failure: decisive.failure,
      defects: decisive.defects,
      durationMs: decisive.durationMs,
    });
  }
  const oldestFirst = entries.map((entry) => entry.status).reverse();
  return { groupId, caseId, entries, flaky: flakyVerdict(oldestFirst) };
}

/**
 * Нестабильные кейсы всего проекта — для отметки в строках библиотеки.
 *
 * Последовательность исходов берётся из `caseStatusHistory` хранилища — той же
 * раскладки (одна точка на прогон, худший проход решает), по которой судят
 * отчёт и карантин: своя копия цикла разошлась бы с ними молча. Своё здесь
 * только правило вердикта — строже списка в отчёте, где хватает одной смены.
 */
export function flakyMarks(runs: readonly ProjectTestRunRecord[]): ProjectTestFlakyMarks {
  const cases: ProjectTestFlakyMark[] = [];
  for (const [key, statuses] of caseStatusHistory([...runs])) {
    const verdict = flakyVerdict(statuses);
    if (!verdict.isFlaky) continue;
    const split = key.indexOf(':');
    cases.push({ groupId: key.slice(0, split), caseId: key.slice(split + 1), ...verdict });
  }
  return { window: FLAKY_WINDOW, minFlips: FLAKY_MIN_FLIPS, cases };
}

export function readCaseHistory(
  root: string,
  groupId: string,
  caseId: string,
): ProjectTestCaseHistory {
  return caseHistory(readRuns(root, HISTORY_RUNS), groupId, caseId);
}

export function readFlakyMarks(root: string): ProjectTestFlakyMarks {
  return flakyMarks(readRuns(root, HISTORY_RUNS));
}
