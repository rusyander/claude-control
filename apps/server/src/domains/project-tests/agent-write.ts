import { randomUUID } from 'node:crypto';
import type {
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { coded } from '../../lib/server-text.ts';
import { writeDraft } from './drafts.ts';
import { ProjectTestsNotFoundError } from './files.ts';
import { gitContext } from './impact.ts';
import { writeRun } from './runs-store.ts';
import { applyResults, createGroup, readGroup, upsertCase } from './store.ts';

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
  | { kind: 'saved'; testCase: ProjectTestCase; created: boolean }
  | { kind: 'draft'; runId: string; caseId: string };

/** Поля результата прогона — их пишет `record`, а не правка описания. */
const RUN_OWNED = ['status', 'statusId', 'note', 'muted', 'muteReason', 'archived'] as const;

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
  const existing = clean.id
    ? readGroup(root, groupId).cases.find((item) => item.id === clean.id)
    : undefined;
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
  const testCase = upsertCase(root, groupId, clean, now, 'agent');
  return { kind: 'saved', testCase, created: !existing };
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
  const id = randomUUID();
  const count = (status: AgentResult['status']): number =>
    results.filter((result) => result.status === status).length;
  const record: ProjectTestRunRecord = {
    id,
    mode: 'run',
    actor: 'agent',
    // Проверено руками агента, не командой: автокейсу это прогон не заменяет.
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
  // Автокейсу слово прогон не заменяет — и статус в библиотеке ему не переписывает:
  // в истории запись есть (помечена `attested`), статус ставит только исполненный прогон.
  applyResults(
    root,
    results
      .filter((result) => !automated.has(`${result.groupId}:${result.caseId}`))
      .map((result) => ({
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
