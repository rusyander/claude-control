import type { ProjectTestCase, ProjectTestRunRecord } from '@agentdeck/contracts';
import { readGroups, writeGroup } from './store.ts';

/**
 * Починка отметок прогона «из будущего».
 *
 * До того как панель стала штамповать результаты сама, агент писал `lastRunAt`
 * местным временем с буквой Z: на UTC+5 отметка уезжала на пять часов вперёд, и
 * такой «свежий» результат просачивался в запись следующего прогона. Чтение не
 * пишет, поэтому проход одноразовый (маршрут зовёт его раз на проект за жизнь
 * процесса) и только пока в проекте никто не пишет.
 *
 * Откуда берётся верное время, по убыванию доверия: запись прогона, на который
 * кейс ссылается; новейшая запись, где этот кейс есть в результатах; сдвиг
 * часового пояса этой машины; и лишь когда отметка всё равно в будущем — она
 * снимается. Статус кейса не трогается нигде: чинится дата, не результат.
 */

/** Запас на рассинхрон часов: минута вперёд — ещё не «будущее». */
const SLACK_MS = 60_000;

export interface RepairedStamp {
  groupId: string;
  caseId: string;
  from: string;
  /** Новая отметка; нет — отметка снята. */
  to?: string;
  how: 'run' | 'results' | 'timezone' | 'dropped';
}

/** Чем датируется результат прогона: концом, а без него — началом. */
const endOf = (run: ProjectTestRunRecord): string => run.finishedAt ?? run.startedAt;

function repairOne(
  groupId: string,
  testCase: ProjectTestCase,
  runs: ProjectTestRunRecord[],
  now: number,
): RepairedStamp | undefined {
  const from = testCase.lastRunAt;
  if (!from) return undefined;
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed) || parsed <= now + SLACK_MS) return undefined;

  const base = { groupId, caseId: testCase.id, from };
  const byId = testCase.lastRunId ? runs.find((run) => run.id === testCase.lastRunId) : undefined;
  if (byId) return { ...base, to: endOf(byId), how: 'run' };

  // Записи идут от новых к старым — первая найденная и есть последний прогон кейса.
  for (const run of runs) {
    const point = run.results.find(
      (item) => item.groupId === groupId && item.caseId === testCase.id,
    );
    if (point) return { ...base, to: point.finishedAt ?? endOf(run), how: 'results' };
  }

  // Местное время, записанное как UTC: сдвиг пояса ЭТОЙ машины возвращает его назад.
  const shifted = parsed + new Date(parsed).getTimezoneOffset() * 60_000;
  if (shifted <= now + SLACK_MS) {
    return { ...base, to: new Date(shifted).toISOString(), how: 'timezone' };
  }
  return { ...base, how: 'dropped' };
}

/** Починить будущие отметки во всех группах проекта; вернуть, что и как поправлено. */
export function repairFutureStamps(
  root: string,
  runs: ProjectTestRunRecord[],
  now = Date.now(),
): RepairedStamp[] {
  const repaired: RepairedStamp[] = [];
  for (const group of readGroups(root)) {
    const fixes = new Map<string, RepairedStamp>();
    for (const testCase of group.cases) {
      const fix = repairOne(group.id, testCase, runs, now);
      if (fix) fixes.set(testCase.id, fix);
    }
    if (fixes.size === 0) continue;

    writeGroup(root, {
      ...group,
      cases: group.cases.map((testCase) => {
        const fix = fixes.get(testCase.id);
        if (!fix) return testCase;
        const { lastRunAt: _future, ...rest } = testCase;
        return fix.to ? { ...rest, lastRunAt: fix.to } : rest;
      }),
    });
    repaired.push(...fixes.values());
  }
  return repaired;
}
