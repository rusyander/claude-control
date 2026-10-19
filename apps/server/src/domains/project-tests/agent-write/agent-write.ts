import { randomUUID } from 'node:crypto';
import type {
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { writeDraft } from '../drafts/drafts.ts';
import { ProjectTestsError, ProjectTestsNotFoundError } from '../files.ts';
import { gitContext } from '../impact/impact.ts';
import { writeRun } from '../runs-store/runs-store.ts';
import { applyResults, createGroup, readGroup, upsertCase } from '../store/store.ts';

/**
 * Запись в блок «Тесты» от агента ЧАТА — того, что работает над проектом, а не
 * прогона раздела (решение владельца 30.09: блок участвует в тестировании
 * продукта, пока агент делает свою задачу). Через `tests-cli case` и
 * `tests-cli record` агент заводит кейс на то, что поменял, и записывает то,
 * что проверил, — прогоном в истории, а не словами в ответе.
 *
 * Границы те же, что у генерации: кейс, написанный человеком, агент не
 * переписывает — его правка уходит ЧЕРНОВИКОМ на приёмку; статус кейса ставит
 * только запись результата, а не правка описания.
 */

export type AgentCaseWrite =
  | {
      kind: 'saved';
      testCase: ProjectTestCase;
      created: boolean;
      /** id из запроса, которого в группе не было: кейс заведён под id блока. */
      requested?: string;
      /**
       * Живой кейс с id в одну-две буквы от `requested` — вероятная опечатка
       * (ревью B2-F19). Кейс всё равно заведён: `login-2` рядом с `login-1` —
       * обычный новый кейс, и отказ стоил бы ему хода; агенту — подсказка.
       */
      similar?: string;
    }
  | { kind: 'draft'; runId: string; caseId: string };

/** Поля результата прогона — их пишет `record`, а не правка описания. */
const RUN_OWNED = ['status', 'statusId', 'note', 'muted', 'muteReason', 'archived'] as const;

/** Атрибут кейса с id, под которым агент просил его завести. */
const AGENT_ID = 'agent-id';

/** Завести или обновить кейс от имени агента чата. */
export function agentUpsertCase(
  root: string,
  groupId: string,
  input: ProjectTestCaseInput,
  now: string,
): AgentCaseWrite {
  const clean: ProjectTestCaseInput = { ...input };
  for (const key of RUN_OWNED) delete clean[key];
  createGroup(root, groupId);
  const cases = clean.id ? readGroup(root, groupId).cases : [];
  // Придуманный агентом id помнится атрибутом заведённого кейса: повтор того же id
  // в следующем ходе — правка этого кейса, а не ещё один такой же (ревью A2-F9).
  const existing =
    cases.find((item) => item.id === clean.id) ??
    cases.find((item) => !item.archived && item.attributes?.[AGENT_ID] === clean.id);
  if (existing && clean.id !== existing.id) {
    clean.id = existing.id;
    clean.attributes = { ...existing.attributes, ...clean.attributes };
  }
  if (existing?.source === 'human') {
    // Кейс человека — предложением: библиотеку меняет его приёмка.
    const runId = `chat-edit-${existing.id}-${Date.parse(now).toString(36)}`.slice(0, 64);
    writeDraft(root, {
      version: 1,
      runId,
      source: 'chat',
      createdAt: now,
      items: [
        {
          op: 'update',
          groupId,
          caseId: existing.id,
          testCase: { ...existing, ...(clean as Partial<ProjectTestCase>), id: existing.id },
          state: 'pending',
        },
      ],
      file: '',
      status: 'pending',
    });
    return { kind: 'draft', runId, caseId: existing.id };
  }
  // id, которого нет, у агента — придуманное имя нового кейса, а не правка
  // удалённого (3.4 плана экономии, 17.10): отказ стоил ему хода на повтор.
  // Хранилище отказывает по-прежнему — там это защита открытой формы.
  const requested = clean.id && !existing ? clean.id : undefined;
  if (requested) {
    delete clean.id;
    clean.attributes = { ...clean.attributes, [AGENT_ID]: requested };
  }
  const similar = requested
    ? cases.find(
        (item) =>
          !item.archived &&
          [item.id, item.attributes?.[AGENT_ID]].some(
            (id) => typeof id === 'string' && withinTwoEdits(id, requested),
          ),
      )?.id
    : undefined;
  const testCase = upsertCase(root, groupId, clean, now, 'agent');
  return {
    kind: 'saved',
    testCase,
    created: !existing,
    ...(requested ? { requested } : {}),
    ...(similar ? { similar } : {}),
  };
}

/** Расстояние Левенштейна не больше двух — без таблицы на длинные id. */
function withinTwoEdits(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length]! <= 2;
}

export interface AgentResult {
  groupId: string;
  caseId: string;
  status: Extract<ProjectTestStatus, 'passed' | 'failed' | 'blocked' | 'skipped'>;
  note?: string;
}

/**
 * Записать проверенное агентом чата: прогон в истории блока (режим `run`,
 * агент) и статусы кейсов. Кейса нет — отказ целиком, до записи: прогон с
 * результатом «в никуда» читался бы как проверка, которой не было.
 */
export function recordAgentResults(
  root: string,
  results: readonly AgentResult[],
  now: string,
): ProjectTestRunRecord {
  const automated = new Set<string>();
  for (const result of results) {
    const found = readGroup(root, result.groupId).cases.find((item) => item.id === result.caseId);
    if (found?.automation?.status === 'automated')
      automated.add(`${result.groupId}:${result.caseId}`);
    if (!found) {
      throw coded(
        new ProjectTestsNotFoundError(`No case "${result.caseId}" in group "${result.groupId}".`),
        'case-not-in-named-group',
        { caseId: result.caseId, groupId: result.groupId },
      );
    }
  }
  // Решение владельца 10.10: `record` — только для ручных кейсов. Автокейс
  // проверяет его тест, а не слово агента: отказ целиком, до записи, с командой
  // прогона — иначе в истории лежала бы «проверка», которой тест не делал.
  if (automated.size > 0) {
    const cases = [...automated];
    throw coded(
      new ProjectTestsError(
        `Automated cases are not recorded by word: ${cases.join(', ')}. Run them instead: tests-cli run --case ${cases.join(',')}.`,
      ),
      'record-automated-case',
      { cases: cases.join(', ') },
    );
  }
  const id = randomUUID();
  const count = (status: AgentResult['status']): number =>
    results.filter((result) => result.status === status).length;
  const record: ProjectTestRunRecord = {
    id,
    mode: 'run',
    actor: 'agent',
    // Проверено руками агента, не командой: в разделе запись помечена «вручную».
    attested: true,
    ...gitContext(root),
    status: 'done',
    startedAt: now,
    finishedAt: now,
    results: results.map((result) => ({
      pointId: `${result.groupId}:${result.caseId}`,
      groupId: result.groupId,
      caseId: result.caseId,
      status: result.status,
      finishedAt: now,
      ...(result.note ? { note: result.note } : {}),
    })),
    summary: {
      total: results.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped'),
      blocked: count('blocked'),
    },
  };
  writeRun(root, record);
  applyResults(
    root,
    results.map((result) => ({
      groupId: result.groupId,
      caseId: result.caseId,
      status: result.status,
      ...(result.note ? { note: result.note } : {}),
      runId: id,
      at: now,
    })),
    now,
  );
  return record;
}
