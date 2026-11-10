import type { ProjectTestCase, RecordedCaseView } from '@agentdeck/contracts';
import { RECORDED_HISTORY_MAX } from '@agentdeck/contracts/project-tests-recorded';
import { caseHistory } from '../case-history/case-history.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { readGroups } from '../store/store.ts';
import { RECORDED_SUFFIX } from './codegen.ts';
import { RECORDED_TASK_ATTRIBUTE } from './record.ts';

/**
 * Записанные проходы проекта и их последние прогоны (R4): кейс считается записанным, когда его
 * автотест — спек `*.recorded.mjs`. История — те же записи прогонов, что у карточки кейса, не
 * больше `RECORDED_HISTORY_MAX` на кейс: полоска показывает, давно ли сценарий зелёный.
 */

/** Сколько записей прогонов читается, чтобы набрать по 20 на кейс и не читать всю историю. */
const RUNS_READ = 200;

export interface RecordedKey {
  groupId: string;
  testCase: ProjectTestCase;
}

/** Записанные кейсы по порядку групп и кейсов — в этом порядке их и гоняет «Прогнать все». */
export function recordedKeys(root: string): RecordedKey[] {
  const keys: RecordedKey[] = [];
  for (const group of readGroups(root)) {
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      if (!testCase.automation?.file?.endsWith(RECORDED_SUFFIX)) continue;
      keys.push({ groupId: group.id, testCase });
    }
  }
  return keys;
}

export function recordedCases(root: string): RecordedCaseView[] {
  const keys = recordedKeys(root);
  if (keys.length === 0) return [];
  const runs = readRuns(root, RUNS_READ);
  return keys.map(({ groupId, testCase }) => {
    const entries = caseHistory(runs, groupId, testCase.id).entries.slice(0, RECORDED_HISTORY_MAX);
    const taskId = testCase.attributes?.[RECORDED_TASK_ATTRIBUTE];
    return {
      groupId,
      caseId: testCase.id,
      title: testCase.title,
      file: testCase.automation?.file ?? '',
      testName: testCase.automation?.testName ?? '',
      ...(taskId ? { taskId } : {}),
      unchecked: testCase.steps.filter((step) => step.action.startsWith('Не проверено')).length,
      status: testCase.status,
      history: entries.map((entry) => ({
        runId: entry.runId,
        startedAt: entry.startedAt,
        status: entry.status,
      })),
    };
  });
}
