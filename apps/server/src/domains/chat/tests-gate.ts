import type {
  ProjectTestGroup,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { serverText } from '../../lib/server-texts.ts';
import { casesTouching, readGroups, readRuns } from '../project-tests.ts';
import { touchedPaths } from '../project-git/sieve-facts.ts';

/**
 * Группа разделения проверяет свою работу через блок «Тесты» (решение
 * владельца 29.09): вердикт — из кейсов и записанных прогонов блока в её
 * копии, а не из её слов. Так же agentdeck проверяет себя: кейс привязан к
 * файлу, прогон записан в историю, и «проверено» — это запись, а не ответ.
 *
 * Что требуется перед «доставлено»:
 * - задетые диффом группы кейсы находятся по `codePaths` (или зоне);
 * - автоматические среди них прогнаны прогоном, записанным ПОСЛЕ старта
 *   группы, и последний их результат не красный (карантин не держит);
 * - красный кейс любого прогона группы — тоже пробел, даже не задетый диффом;
 * - проект, где кейсы привязаны к файлам, но дифф группы не покрыт ни одним, —
 *   пробел «заведите кейс».
 *
 * Блока «Тесты» в копии нет вовсе (ни одного кейса) — проверять нечем:
 * проект им не пользуется, и группу это не держит.
 */

export interface GroupTestsVerdict {
  /** Автоматических кейсов, задетых диффом группы. */
  cases: number;
  /** Из них зелёных в последнем прогоне группы. */
  passed: number;
  /** Последний прогон группы в блоке. */
  runId?: string;
  runAt?: string;
}

export interface TestsDeliveryGaps {
  missing: string[];
  verdict?: GroupTestsVerdict;
  /** Почему не проверено (блока нет) — в журнал, не в пробелы. */
  unchecked?: string;
}

/** Сколько кейсов назвать по имени: дальше — числом. */
const NAMED = 5;

const RED: readonly ProjectTestStatus[] = ['failed', 'blocked'];

function named(ids: readonly string[]): string {
  const head = ids.slice(0, NAMED).join(', ');
  return ids.length > NAMED ? `${head} (+${ids.length - NAMED})` : head;
}

/**
 * Последний результат кейса по прогонам группы (новые первыми). Прогон
 * записан раньше старта группы — не её прогон, а чужой, и не в счёт.
 */
function latestResults(
  runs: readonly ProjectTestRunRecord[],
): Map<string, { status: ProjectTestStatus; runId: string }> {
  const latest = new Map<string, { status: ProjectTestStatus; runId: string }>();
  for (const run of runs) {
    for (const result of run.results) {
      const key = `${result.groupId}:${result.caseId}`;
      if (!latest.has(key)) latest.set(key, { status: result.status, runId: run.id });
    }
  }
  return latest;
}

/** Пробелы блока «Тесты» группы перед «доставлено». Чистая часть — для тестов. */
export function judgeTests(input: {
  groups: ProjectTestGroup[];
  runs: readonly ProjectTestRunRecord[];
  paths: readonly string[];
  startedAt?: string;
  command: string;
}): TestsDeliveryGaps {
  const live = input.groups.filter((group) => !group.error);
  const all = live.flatMap((group) =>
    group.cases
      .filter((testCase) => !testCase.archived)
      .map((testCase) => ({ group: group.id, testCase })),
  );
  if (all.length === 0) return { missing: [], unchecked: 'no-cases' };

  const since = input.startedAt ? Date.parse(input.startedAt) : Number.NEGATIVE_INFINITY;
  const own = input.runs
    .filter((run) => run.status !== 'running')
    .filter((run) => {
      const at = Date.parse(run.startedAt);
      return Number.isFinite(at) && at >= since;
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const latest = latestResults(own);
  // Автоматический кейс засчитывается только исполненным прогоном: запись
  // «проверил» от агента (`tests-cli record`) — слово, а не команда (ревью 30.09).
  const executed = own.filter((run) => !run.attested);
  const latestExecuted = latestResults(executed);
  const byKey = new Map(all.map((item) => [`${item.group}:${item.testCase.id}`, item]));

  const touched = casesTouching(input.paths, live).cases.map(
    (item) => `${item.groupId}:${item.caseId}`,
  );
  const automated = touched.filter(
    (key) => byKey.get(key)?.testCase.automation?.status === 'automated',
  );
  const missing: string[] = [];

  const linked = all.some((item) => (item.testCase.codePaths ?? []).length > 0);
  const code = input.paths.filter((path) => !path.startsWith('.agent/'));
  if (touched.length === 0 && linked && code.length > 0) {
    missing.push(serverText('tests-gap-uncovered', { files: named(code) }));
  }

  if (automated.length > 0 && executed.length === 0) {
    missing.push(
      serverText('tests-gap-no-run', {
        cases: named(automated.map((key) => key.split(':')[1] ?? key)),
        command: input.command,
      }),
    );
  } else {
    const unrun = automated.filter((key) => {
      const status = latestExecuted.get(key)?.status;
      return !status || status === 'skipped' || status === 'unknown';
    });
    if (unrun.length > 0) {
      missing.push(
        serverText('tests-gap-unrun', {
          cases: named(unrun.map((key) => key.split(':')[1] ?? key)),
          command: input.command,
        }),
      );
    }
  }

  // Красное в прогонах группы — пробел, задет кейс диффом или нет: группа
  // сама его прогнала и сама увидела. Карантин (`muted`) не держит.
  const red = [...latest]
    .filter(([key, result]) => RED.includes(result.status) && !byKey.get(key)?.testCase.muted)
    .map(([key]) => key.split(':')[1] ?? key);
  if (red.length > 0) missing.push(serverText('tests-gap-failed', { cases: named(red) }));

  const passed = automated.filter((key) => latestExecuted.get(key)?.status === 'passed').length;
  const last = executed[0] ?? own[0];
  return {
    missing,
    verdict: {
      cases: automated.length,
      passed,
      ...(last ? { runId: last.id, runAt: last.finishedAt ?? last.startedAt } : {}),
    },
  };
}

/** Пробелы блока «Тесты» в копии группы: кейсы и прогоны читаются с диска копии. */
export async function testsDeliveryGaps(input: {
  cwd: string;
  startedAt?: string;
  /** Команда, которой группа записывает прогон в блок своей копии. */
  command: string;
}): Promise<TestsDeliveryGaps> {
  const groups = readGroups(input.cwd);
  if (!groups.some((group) => group.cases.length > 0)) {
    return { missing: [], unchecked: 'no-cases' };
  }
  return judgeTests({
    groups,
    runs: readRuns(input.cwd),
    paths: await touchedPaths(input.cwd),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    command: input.command,
  });
}
