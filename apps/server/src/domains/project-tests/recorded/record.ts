import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { browseGapSchema, browseStepSchema } from '@agentdeck/contracts/core/browse';
import type {
  ProjectTestCaseInput,
  RecordedRecordBody,
  RecordedRecordReply,
} from '@agentdeck/contracts';
import { writeTextFile } from '../../../lib/safe-io/safe-io.ts';
import { agentUpsertCase } from '../agent-write/agent-write.ts';
import { ProjectTestsError, ProjectTestsNotFoundError } from '../files.ts';
import { readGroup } from '../store/store.ts';
import { buildRecorded, recordedFile, recordedTestName } from './codegen.ts';

/**
 * Записать проход в блок «Тесты» (R3, P179): спек из строк прохода и кейс, привязанный к нему
 * файлом и ПОЛНЫМ именем теста — тем самым, что спек объявляет о себе строкой-меткой. Шаги,
 * которых проход не умел или которые не прошли при записи, ложатся в кейс «не проверено»:
 * отчёт не выдаёт непроверенное за проверенное.
 *
 * Кейс пишется от имени агента: кейс, написанный человеком, перезаписью из прохода не
 * трогается — отказ 409, а не тихий черновик (человек нажал кнопку и ждёт спек, а не приёмку).
 */

/** Отказ записи: кейс человека проходом не перезаписывается. */
export class RecordedHumanCaseError extends ProjectTestsError {
  override statusCode = 409;
  constructor(caseId: string) {
    super(
      `Кейс ${caseId} написан человеком — проход его не перезаписывает. Заведите новый кейс записью.`,
    );
    this.name = 'RecordedHumanCaseError';
  }
}

const rowsSchema = z.object({
  steps: z.array(browseStepSchema).max(500),
  gaps: z.array(browseGapSchema).max(200),
});

/** Метка кейса: из какой задачи прохода он собран. */
export const RECORDED_TASK_ATTRIBUTE = 'recorded-task';

/** Метки записанного кейса — по ним список записанных проходов и находит их. */
export const RECORDED_TAGS = ['recorded', 'browser'];

export function recordWalk(
  root: string,
  body: RecordedRecordBody,
  now: string,
): RecordedRecordReply {
  const rows = rowsSchema.safeParse({ steps: body.steps, gaps: body.gaps });
  if (!rows.success) {
    throw new ProjectTestsError(
      `Строки прохода не разобрались: ${rows.error.issues[0]?.message ?? ''}`,
    );
  }
  const title = body.title.replace(/\s+/g, ' ').trim();
  if (!title) throw new ProjectTestsError('Назовите сценарий: из названия собирается имя теста.');
  const testName = recordedTestName(title);
  const built = buildRecorded({ testName, steps: rows.data.steps, gaps: rows.data.gaps });
  if (built.playable.length === 0) {
    throw new ProjectTestsError('В проходе нет ни одного удавшегося шага — записывать нечего.');
  }
  const caseId = body.caseId ? existingCase(root, body.groupId, body.caseId) : undefined;
  const fields: ProjectTestCaseInput = {
    title,
    steps: built.caseSteps,
    precondition: `Стенд окружения запущен; адрес — E2E_BASE_URL (записано на ${built.origin}).`,
    tags: RECORDED_TAGS,
    attributes: { [RECORDED_TASK_ATTRIBUTE]: body.taskId },
  };
  // Новый кейс: id даёт хранилище, а путь спека зависит от id — сначала кейс, потом спек и привязка.
  const first = agentUpsertCase(
    root,
    body.groupId,
    { ...fields, ...(caseId ? { id: caseId } : {}) },
    now,
  );
  if (first.kind !== 'saved') throw new RecordedHumanCaseError(first.caseId);
  const id = first.testCase.id;
  const file = recordedFile(body.groupId, id);
  const absolute = join(root, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeTextFile(absolute, built.spec);
  const last = built.playable[built.playable.length - 1]!;
  agentUpsertCase(
    root,
    body.groupId,
    {
      id,
      title,
      automation: { status: 'automated', file, testName },
      codePaths: [file],
      expected:
        `Спек доходит до шага ${last.n} («${last.title}») без расхождений` +
        (built.unchecked > 0 ? `; не проверено шагов: ${built.unchecked}.` : '.'),
    },
    now,
  );
  return {
    groupId: body.groupId,
    caseId: id,
    file,
    testName,
    created: first.created,
    unchecked: built.unchecked,
  };
}

/** Перезапись: кейс есть и он не человека — иначе отказ до любой записи на диск. */
function existingCase(root: string, groupId: string, caseId: string): string {
  const found = readGroup(root, groupId).cases.find((item) => item.id === caseId);
  if (!found) throw new ProjectTestsNotFoundError(`Кейса ${groupId}:${caseId} нет.`);
  if (found.source === 'human') throw new RecordedHumanCaseError(caseId);
  return found.id;
}
