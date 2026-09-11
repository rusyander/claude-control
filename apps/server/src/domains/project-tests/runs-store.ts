import { existsSync, rmSync } from 'node:fs';
import type {
  ProjectTestEvidenceSummary,
  ProjectTestFailureGroup,
  ProjectTestFlaky,
  ProjectTestGroup,
  ProjectTestReleaseSummary,
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
    release: optional(record.release),
    status: (optional(record.status) ?? 'done') as ProjectTestRunRecord['status'],
    startedAt,
    finishedAt: optional(record.finishedAt),
    error: optional(record.error),
    tokens: typeof record.tokens === 'number' ? record.tokens : undefined,
    costUsd: typeof record.costUsd === 'number' ? record.costUsd : undefined,
    sessionId: optional(record.sessionId),
    results,
    summary,
    draft: parseDraftOutcome(record.draft),
    generate: parseStamp(record.generate),
    tms: parseTms(record.tms),
  };
}

/**
 * След отправки в тест-менеджмент. Разбирается так же придирчиво, как всё
 * остальное: по этому полю повторная отправка решает, что ран уже есть, и
 * мусор в нём означал бы либо отказ чужой системы, либо попадание в чужой ран.
 */
function parseTms(raw: unknown): ProjectTestRunRecord['tms'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const kind = optional(value.kind);
  const runId = optional(value.runId);
  if (!runId || (kind !== 'zephyr' && kind !== 'xray' && kind !== 'testit')) return undefined;
  return {
    kind,
    runId,
    url: optional(value.url),
    pushed: typeof value.pushed === 'number' ? value.pushed : 0,
    pushedAt: optional(value.pushedAt) ?? '',
  };
}

/**
 * След источника генерации. Читается с диска, потому что черновик применяют
 * позже самого прогона — панель узнаёт по нему, что проставить кейсам.
 */
function parseStamp(raw: unknown): ProjectTestRunRecord['generate'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const source = optional(value.source);
  if (source !== 'requirement' && source !== 'diff' && source !== 'defect') return undefined;
  const paths = Array.isArray(value.codePaths)
    ? value.codePaths.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    source,
    requirementUrl: optional(value.requirementUrl),
    requirementKey: optional(value.requirementKey),
    codePaths: paths.length > 0 ? paths : undefined,
    defectUrl: optional(value.defectUrl),
  };
}

/** Итог генерации в записи прогона: сколько предложено, сколько принято и кем. */
function parseDraftOutcome(raw: unknown): ProjectTestRunRecord['draft'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const runId = optional(value.runId);
  if (!runId) return undefined;
  const count = (input: unknown): number => (typeof input === 'number' && input >= 0 ? input : 0);
  return {
    runId,
    proposed: count(value.proposed),
    accepted: count(value.accepted),
    auto: value.auto === true,
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
 * История результатов каждого кейса, от старых к новым.
 *
 * Прогоны хранилище отдаёт от новых к старым — разворачиваем, потому что по
 * времени читаются все три вопроса к истории: стабильность, зелёная серия и
 * давность. Одна раскладка на всех: три копии этого цикла разошлись бы молча, и
 * карантин судил бы кейс по одной истории, а риск — по другой.
 */
export function caseStatusHistory(runs: ProjectTestRunRecord[]): Map<string, string[]> {
  const byCase = new Map<string, string[]>();
  for (const run of [...runs].reverse()) {
    for (const result of run.results) {
      const key = `${result.groupId}:${result.caseId}`;
      const list = byCase.get(key) ?? [];
      if (list.length < STABILITY_WINDOW) list.push(result.status);
      byCase.set(key, list);
    }
  }
  return byCase;
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
  const byCase = caseStatusHistory(runs);

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

/**
 * Чем доказаны провалы.
 *
 * Считается по САМОМУ СВЕЖЕМУ провалу каждого кейса, а не по всем подряд:
 * провал, доказанный снимком месяц назад и голословный сегодня, — это
 * голословный провал, и перепройти надо именно его.
 *
 * Результат при этом не выбрасывается: панель не отменяет полчаса работы агента
 * из-за формальности, она называет её неполной и показывает, что перепройти.
 */
export function evidenceOf(
  runs: ProjectTestRunRecord[],
  groups: ProjectTestGroup[],
): ProjectTestEvidenceSummary {
  const titles = new Map<string, string>();
  for (const group of groups) {
    for (const testCase of group.cases) titles.set(`${group.id}:${testCase.id}`, testCase.title);
  }

  const seen = new Set<string>();
  const summary: ProjectTestEvidenceSummary = {
    failed: 0,
    proven: 0,
    detailed: 0,
    missing: [],
    flaky: [],
  };

  // Прогоны идут от новых к старым — первый встреченный результат кейса и есть
  // его последнее слово.
  for (const run of runs) {
    for (const result of run.results) {
      if (result.status !== 'failed' && result.status !== 'blocked') continue;
      const key = `${result.groupId}:${result.caseId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const row = {
        groupId: result.groupId,
        caseId: result.caseId,
        title: titles.get(key) ?? result.caseId,
      };
      summary.failed += 1;
      if ((result.attachments ?? []).length > 0) summary.proven += 1;
      else summary.missing.push(row);
      if (result.failure?.step !== undefined || result.failure?.actual) summary.detailed += 1;
      if (result.failure?.retry === 'flaky') summary.flaky.push(row);
    }
  }

  return summary;
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
  let muted = 0;
  let liveCases = 0;

  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      liveCases += 1;
      if (testCase.muted) muted += 1;
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
    evidence: evidenceOf(runs, groups),
    releases: releaseSummaries(runs, liveCases),
    totals: { ...totals, muted },
  };
}

/**
 * Прогоны, сведённые по вехам.
 *
 * Непроверенное считается по УНИКАЛЬНЫМ кейсам вехи: один и тот же кейс,
 * пройденный в трёх прогонах релиза, проверен один раз, а не трижды, — иначе
 * «проверено 40 из 30» стало бы обычным ответом отчёта.
 */
function releaseSummaries(
  runs: ProjectTestRunRecord[],
  liveCases: number,
): ProjectTestReleaseSummary[] {
  const byRelease = new Map<
    string,
    { runs: number; passed: number; failed: number; touched: Set<string>; lastRunAt?: string }
  >();

  for (const run of runs) {
    const release = run.release?.trim();
    if (!release) continue;
    const row = byRelease.get(release) ?? { runs: 0, passed: 0, failed: 0, touched: new Set() };
    row.runs += 1;
    row.passed += run.summary?.passed ?? 0;
    row.failed += run.summary?.failed ?? 0;
    for (const result of run.results) row.touched.add(`${result.groupId}:${result.caseId}`);
    // Прогоны приходят от новых к старым, поэтому первая дата вехи и есть
    // последняя по времени.
    row.lastRunAt = row.lastRunAt ?? run.startedAt;
    byRelease.set(release, row);
  }

  return [...byRelease.entries()]
    .map(([release, row]) => ({
      release,
      runs: row.runs,
      passed: row.passed,
      failed: row.failed,
      untested: Math.max(liveCases - row.touched.size, 0),
      lastRunAt: row.lastRunAt,
    }))
    .sort((left, right) => (right.lastRunAt ?? '').localeCompare(left.lastRunAt ?? ''));
}
