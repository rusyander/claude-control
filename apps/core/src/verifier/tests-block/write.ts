import type { ProjectTestPointResult, ProjectTestRunRecord } from '@agentdeck/contracts';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckRecord } from '@agentdeck/contracts/core/records';
import { summarize } from '@agentdeck/contracts/test-format';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createOnceLinked } from '../../platform/git.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { pathExists, readBytesSync } from '../../platform/safe-io/files.ts';
import { readLinkedCases } from './cases.ts';
import { caseHits } from './map.ts';
import type { CaseHit, CaseScope } from './tests-block.types.ts';

/**
 * Писатель блока тестов (04:65-67, P50, G14, G15): запись проверки, легшая на кейсы, — один
 * прогон истории `origin:'core'` с `coreRecordId`; вердикт кейса существует только таким
 * прогоном. Пишет лишь в уже существующее `<main checkout>/.agent/tests/` — хранилище не
 * создаётся никогда (чужой репозиторий без блока тестов не получает папку от ядра). Запись
 * идемпотентна: id прогона выводится из id записи, файл создаётся один раз целиком — повтор той
 * же записи (рестарт ядра посреди итога) не плодит двойника в истории.
 */

export const TESTS_DIR = join('.agent', 'tests');
const RUNS_DIR = 'runs';
const SUFFIX = '.run.json';

/** Тот же вид, что у панели (`runFileId` блока тестов): время до секунды + 8 знаков id. */
export function runFileId(id: string, startedAt: string): string {
  const stamp = startedAt.replace(/[^0-9]/g, '').slice(0, 14);
  return `${stamp}-${id.slice(0, 8)}`.toLowerCase();
}

/** Id прогона из id записи: одна запись — один прогон, при любом числе попыток записать. */
export function coreRunId(recordId: string): string {
  return createHash('sha256').update(`core-run:${recordId}`).digest('hex').slice(0, 24);
}

function resultOf(hit: CaseHit, at: string, ms: number): ProjectTestPointResult {
  return {
    pointId: `${hit.groupId}:${hit.caseId}`,
    groupId: hit.groupId,
    caseId: hit.caseId,
    status: hit.status,
    finishedAt: at,
    durationMs: ms,
    ...(hit.flakyAttempts !== undefined ? { flakyAttempts: hit.flakyAttempts } : {}),
    ...(hit.failedTests ? { failedTests: hit.failedTests } : {}),
  };
}

export function caseRunRecord(rec: CheckRecord, hits: readonly CaseHit[]): ProjectTestRunRecord {
  const startedAt = new Date(rec.startedAt).toISOString();
  const finishedAt = new Date(rec.startedAt + rec.ms).toISOString();
  const results = hits.map((h) => resultOf(h, finishedAt, rec.ms));
  return {
    id: coreRunId(rec.id),
    mode: 'import',
    actor: 'ci',
    origin: 'core',
    coreRecordId: rec.id,
    scope: `${rec.checkId}:${rec.unit}`,
    status: 'done',
    startedAt,
    finishedAt,
    ...(rec.exit !== null ? { exitCode: rec.exit } : {}),
    results,
    summary: summarize(results),
  };
}

/** Лежит ровно этот текст; не прочитан (P44) — не «тот же»: производный файл переписывается. */
const holds = (path: string, text: string): boolean => {
  const got = readBytesSync(path);
  return 'value' in got && got.value.toString('utf8') === text;
};

/**
 * `value` — путь файла прогона (создан сейчас или уже был); `value: []` — запись ни одного кейса
 * не доказала; `absent` — у репозитория нет блока тестов; `unknown` — кейсы не прочитаны.
 */
export function writeCaseRuns(rec: CheckRecord, project: string, scope: CaseScope): Fact<string[]> {
  const store = join(project, TESTS_DIR);
  if (!pathExists(store)) return { absent: true };
  const cases = readLinkedCases(store);
  if (!('value' in cases)) return cases;
  const hits = caseHits(rec, scope, cases.value);
  if (hits.length === 0) return { value: [] };
  const run = caseRunRecord(rec, hits);
  const path = join(store, RUNS_DIR, `${runFileId(run.id, run.startedAt)}${SUFFIX}`);
  const text = `${JSON.stringify(run, null, 2)}\n`;
  try {
    // Целиком или никак (tmp + ссылка): ядро, упавшее посреди записи, не оставит обрывок,
    // который повтор принял бы за готовый прогон. Уже лежит не то (обрывок с ФС без ссылок,
    // кейсы с тех пор поменялись) — файл производный, переписывается.
    if (createOnceLinked(path, Buffer.from(text, 'utf8')) === 'exists' && !holds(path, text))
      writeFileAtomic(path, text);
  } catch (error) {
    return { unknown: `${path}: ${(error as Error).message}` };
  }
  return { value: [path] };
}
