import { existsSync, rmSync } from 'node:fs';
import type {
  ProjectTestFailureGroup,
  ProjectTestFlaky,
  ProjectTestGroup,
  ProjectTestReport,
  ProjectTestRunRecord,
  ProjectTestRunSummary,
} from '@agentdeck/contracts';
import { stabilityOf, summarize } from '@agentdeck/contracts/test-format';
import { listFiles, optional, readJson, testsPath, writeJson } from './files.ts';

/**
 * История прогонов: файлы `runs/<id>.run.json` в самом проекте.
 *
 * Раньше история жила только в памяти процесса и умирала вместе с панелью —
 * а без неё нельзя ответить ни «что сломалось между вчера и сегодня», ни
 * «какие кейсы нестабильны», ни «сколько стоит регресс». Поэтому запись прогона
 * ложится на диск рядом с кейсами: она едет с веткой, попадает в ревью и
 * читается без панели.
 *
 * Файлов не должно становиться бесконечно много: при записи хвост старше
 * `KEEP` удаляется. Это осознанная потеря — отчёты смотрят на последние
 * десятки прогонов, а репозиторий не место для гигабайта JSON.
 */

const SUFFIX = '.run.json';
const RUNS_DIR = 'runs';

/** Сколько прогонов хранить. Дальше — обрезаем самые старые. */
const KEEP = 200;

/** Сколько последних результатов кейса участвует в расчёте стабильности. */
const STABILITY_WINDOW = 100;

/** Идентификатор файла прогона: время + короткий ключ, чтобы сортировка = хронология. */
export function runFileId(id: string, startedAt: string): string {
  const stamp = startedAt.replace(/[^0-9]/g, '').slice(0, 14);
  return `${stamp}-${id.slice(0, 8)}`.toLowerCase();
}

/** Записать прогон. Ошибка записи не должна ронять сам прогон. */
export function writeRun(root: string, record: ProjectTestRunRecord): void {
  const fileId = runFileId(record.id, record.startedAt);
  writeJson(root, `${RUNS_DIR}/${fileId}${SUFFIX}`, record);
  prune(root);
}

/** Убрать самые старые записи, оставив `KEEP` свежих. */
function prune(root: string): void {
  const ids = listFiles(root, RUNS_DIR, SUFFIX);
  if (ids.length <= KEEP) return;
  for (const id of ids.slice(0, ids.length - KEEP)) {
    const path = testsPath(root, `${RUNS_DIR}/${id}${SUFFIX}`);
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/**
 * Один прогон. Ключом принимается И имя файла (`<время>-<ключ>`), И собственный
 * идентификатор прогона: список отдаёт записи под их `id`, а имя файла сделано
 * хронологическим ради сортировки — принимать только его значило бы, что
 * открыть прогон из истории нельзя.
 */
export function readRun(root: string, id: string): ProjectTestRunRecord | undefined {
  const direct = parseRun(readJson(root, `${RUNS_DIR}/${id}${SUFFIX}`).data, id);
  if (direct) return direct;
  for (const fileId of listFiles(root, RUNS_DIR, SUFFIX).reverse()) {
    const record = parseRun(readJson(root, `${RUNS_DIR}/${fileId}${SUFFIX}`).data, fileId);
    if (record?.id === id) return record;
  }
  return undefined;
}

/** Прогоны от новых к старым. */
export function readRuns(root: string, limit = 50): ProjectTestRunRecord[] {
  const ids = listFiles(root, RUNS_DIR, SUFFIX).reverse().slice(0, limit);
  return ids
    .map((id) => readRun(root, id))
    .filter((run): run is ProjectTestRunRecord => run !== undefined);
}

/** Разбор записи прогона: чужой файл может быть неполным. */
function parseRun(data: unknown, fileId: string): ProjectTestRunRecord | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const startedAt = optional(record.startedAt);
  if (!startedAt) return undefined;

  const results = Array.isArray(record.results)
    ? (record.results as ProjectTestRunRecord['results'])
    : [];
  const summary = (record.summary ?? summarize(results)) as ProjectTestRunSummary;

  return {
    id: optional(record.id) ?? fileId,
    mode: (optional(record.mode) ?? 'run') as ProjectTestRunRecord['mode'],
    actor: (optional(record.actor) ?? 'agent') as ProjectTestRunRecord['actor'],
    groupId: optional(record.groupId),
    planId: optional(record.planId),
    environmentId: optional(record.environmentId),
    branch: optional(record.branch),
    commit: optional(record.commit),
    scope: optional(record.scope),
    status: (optional(record.status) ?? 'done') as ProjectTestRunRecord['status'],
    startedAt,
    finishedAt: optional(record.finishedAt),
    error: optional(record.error),
    tokens: typeof record.tokens === 'number' ? record.tokens : undefined,
    costUsd: typeof record.costUsd === 'number' ? record.costUsd : undefined,
    sessionId: optional(record.sessionId),
    results,
    summary,
  };
}

/** Длительность прогона в миллисекундах — сколько удалось посчитать. */
function durationOf(run: ProjectTestRunRecord): number {
  if (!run.finishedAt) return 0;
  const from = Date.parse(run.startedAt);
  const to = Date.parse(run.finishedAt);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;
}

/**
 * Нестабильные кейсы по истории.
 *
 * Стабильность считается по последовательности РЕЗУЛЬТАТОВ одного кейса: доля
 * переходов, в которых результат не менялся. Кейс, который то зелёный, то
 * красный при одном и том же коде, — это не найденный баг, а сломанный тест, и
 * отделить одно от другого можно только по истории.
 */
export function flakyCases(
  runs: ProjectTestRunRecord[],
  groups: ProjectTestGroup[],
): ProjectTestFlaky[] {
  const byCase = new Map<string, string[]>();
  // Прогоны приходят от новых к старым — разворачиваем, чтобы смотреть по времени.
  for (const run of [...runs].reverse()) {
    for (const result of run.results) {
      const key = `${result.groupId}:${result.caseId}`;
      const list = byCase.get(key) ?? [];
      if (list.length < STABILITY_WINDOW) list.push(result.status);
      byCase.set(key, list);
    }
  }

  const titles = new Map<string, string>();
  for (const group of groups) {
    for (const testCase of group.cases) titles.set(`${group.id}:${testCase.id}`, testCase.title);
  }

  const flaky: ProjectTestFlaky[] = [];
  for (const [key, statuses] of byCase) {
    const [groupId = '', caseId = ''] = key.split(':');
    const { stability, flips } = stabilityOf(statuses);
    if (flips === 0) continue;
    flaky.push({
      caseId,
      groupId,
      title: titles.get(key) ?? caseId,
      stability,
      runs: statuses.length,
      flips,
    });
  }
  return flaky.sort((left, right) => left.stability - right.stability);
}

/**
 * Ключ причины: заметка без цифр, путей и регистра.
 *
 * Одна поломка приходит с разным текстом — «таймаут 30000 мс» и «таймаут 5000
 * мс» — а сводить их надо вместе. Числа, кавычки и адреса убираем, потому что
 * различаются именно они; остаётся то, чем поломка называется.
 */
function reasonKey(note: string): string {
  return (note.toLowerCase().split(/[.\n]/)[0] ?? '')
    .replace(/[a-z]:\\[^\s]+|\/[^\s]*\//g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Провалы, сведённые по причине.
 *
 * Отчёт отвечает на «что сломалось», а не на «сколько красного»: одна упавшая
 * авторизация красит половину набора, и без группировки это читается как
 * полсотни разных бед. Сводим по тексту исполнителя — он единственный, кто
 * видел падение; результат без заметки в группировку не идёт, потому что
 * причины у него нет.
 */
export function failureGroups(
  runs: ProjectTestRunRecord[],
  groups: ProjectTestGroup[],
): ProjectTestFailureGroup[] {
  const titles = new Map<string, string>();
  for (const group of groups) {
    for (const testCase of group.cases) titles.set(`${group.id}:${testCase.id}`, testCase.title);
  }

  const byReason = new Map<
    string,
    {
      reason: string;
      cases: Map<string, { groupId: string; caseId: string; title: string }>;
      count: number;
      lastSeenAt?: string;
    }
  >();

  // Прогоны идут от новых к старым — первая встреченная заметка и есть свежая.
  for (const run of runs) {
    for (const result of run.results) {
      if (result.status !== 'failed' && result.status !== 'blocked') continue;
      const note = result.note?.trim();
      if (!note) continue;
      const key = reasonKey(note);
      if (!key) continue;
      const row = byReason.get(key) ?? {
        reason: note,
        cases: new Map(),
        count: 0,
        lastSeenAt: run.finishedAt ?? run.startedAt,
      };
      row.count += 1;
      const caseKey = `${result.groupId}:${result.caseId}`;
      if (!row.cases.has(caseKey)) {
        row.cases.set(caseKey, {
          groupId: result.groupId,
          caseId: result.caseId,
          title: titles.get(caseKey) ?? result.caseId,
        });
      }
      byReason.set(key, row);
    }
  }

  return [...byReason.values()]
    .map((row) => ({
      reason: row.reason,
      count: row.count,
      cases: [...row.cases.values()],
      lastSeenAt: row.lastSeenAt,
    }))
    .sort((left, right) => right.count - left.count || right.cases.length - left.cases.length);
}

/** Отчёт по проекту: тренды, покрытие, нестабильные, деньги и время. */
export function buildReport(
  root: string,
  groups: ProjectTestGroup[],
  limit = 50,
): ProjectTestReport {
  const runs = readRuns(root, limit);

  const areas = new Map<
    string,
    { total: number; passed: number; failed: number; unknown: number }
  >();
  const automation = { manual: 0, toAutomate: 0, automated: 0 };

  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      const key = testCase.area ?? 'без зоны';
      const row = areas.get(key) ?? { total: 0, passed: 0, failed: 0, unknown: 0 };
      row.total += 1;
      if (testCase.status === 'passed') row.passed += 1;
      if (testCase.status === 'failed') row.failed += 1;
      if (testCase.status === 'unknown') row.unknown += 1;
      areas.set(key, row);
      automation[testCase.automation?.status ?? 'manual'] += 1;
    }
  }

  const totals = runs.reduce(
    (sum, run) => ({
      runs: sum.runs + 1,
      tokens: sum.tokens + (run.tokens ?? 0),
      costUsd: sum.costUsd + (run.costUsd ?? 0),
      durationMs: sum.durationMs + durationOf(run),
      lastRunAt: sum.lastRunAt ?? run.startedAt,
    }),
    { runs: 0, tokens: 0, costUsd: 0, durationMs: 0, lastRunAt: undefined as string | undefined },
  );

  return {
    runs,
    areas: [...areas.entries()]
      .map(([area, row]) => ({ area, ...row }))
      .sort((left, right) => right.total - left.total),
    automation,
    flaky: flakyCases(runs, groups),
    failures: failureGroups(runs, groups),
    totals,
  };
}
