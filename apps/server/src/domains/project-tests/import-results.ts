import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProjectTestGroup,
  ProjectTestImportResult,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { pointId, summarize, toStatus } from '@agentdeck/contracts/test-format';
import { ProjectFileError, resolveProjectPath } from '../project-files/paths.ts';
import { ProjectTestsError } from './files.ts';
import { gitContext } from './impact.ts';
import { findElements, textContent } from './import-xml.ts';
import { writeRun } from './runs-store.ts';
import { applyResults, readGroups, type CaseResultPatch } from './store.ts';

/**
 * Результаты автотестов из CI — в статусы кейсов.
 *
 * Зачем это здесь. Кейс, который уже автоматизирован, никто не проходит руками,
 * и без импорта его статус в панели навсегда остаётся «не гоняли»: человек
 * смотрит на список, где половина строк серая, и не понимает, что именно эта
 * половина как раз и проверяется каждым пушем. Импорт закрывает разрыв — CI
 * прогнал, панель показала.
 *
 * Форматов три, и это не прихоть:
 *   - JUnit XML — общий знаменатель: его умеют Playwright, vitest, jest, pytest
 *     и сам JUnit, поэтому один разбор закрывает почти любой проект;
 *   - JSON-репортёр Playwright — там есть то, чего в JUnit нет: разбивка по
 *     файлам, повторы и признак нестабильного теста;
 *   - каталог результатов Allure (`*-result.json`) — по файлу на тест, так его
 *     кладут прогоны, ещё не собранные в отчёт.
 *
 * Сопоставление результата с кейсом идёт по правилам подряд, от точного к
 * догадке: `automation.externalId` (свойство junit, метка allure, аннотация
 * Playwright или маркер `@TC-14` в имени) → `automation.testName` совпал с именем
 * теста → маркер `[gui-001]` внутри имени → точное совпадение с названием кейса.
 * Не сошлось — имя уходит в `unmatched`, а НЕ в чей-нибудь чужой кейс: ложно
 * зелёный кейс хуже серого.
 *
 * Ключ идёт первым не из вкуса: имя теста меняется при первом рефакторинге, и
 * сопоставление по нему обрывает историю кейса молча, без единой ошибки.
 *
 * Импорт всегда оставляет след: запись прогона `runs/<id>.run.json` с
 * `mode:'import'` и `actor:'ci'`. Без неё в истории был бы разрыв — статусы
 * поменялись, а прогона, который их поменял, не существует.
 */

/** Один результат из чужого отчёта, приведённый к нашему виду. */
export interface ImportedTestResult {
  /** Имя теста, как его назвал прогон, — оно же уходит в `unmatched`. */
  name: string;
  /** Другие написания того же имени: с классом, с файлом, с сюитами. */
  aliases?: string[];
  /**
   * Устойчивый ключ теста, если отчёт его принёс: свойство junit, метка allure,
   * аннотация Playwright. Сильнее любого имени и проверяется первым.
   */
  externalId?: string;
  status: ProjectTestStatus;
  durationMs?: number;
  /** Текст падения — он ложится в заметку кейса. */
  message?: string;
}

/** Что и откуда импортировать. Либо содержимое, либо путь внутри проекта. */
export interface ImportResultsInput {
  format: 'junit' | 'playwright' | 'allure';
  content?: string;
  /** Путь от корня проекта: файл, а для Allure — каталог с `*-result.json`. */
  file?: string;
  environmentId?: string;
  /** Момент импорта; передаётся снаружи, чтобы тест был воспроизводим. */
  now?: string;
}

/** Насколько результат «хуже»: при двух результатах на кейс побеждает худший. */
const SEVERITY: Record<string, number> = {
  unknown: 0,
  running: 1,
  passed: 2,
  skipped: 3,
  blocked: 4,
  failed: 5,
};

/** Хвост чужого текста падения: полный стек в заметке кейса не нужен. */
const MAX_MESSAGE = 400;

/** Слова Playwright, которых нет в общем словаре статусов. */
const PLAYWRIGHT_WORDS: Record<string, string> = {
  expected: 'passed',
  unexpected: 'failed',
  // Нестабильный тест В ИТОГЕ зелёный: он упал и прошёл на повторе. Красить
  // такой кейс красным значит врать — но и молчать нельзя, поэтому причина
  // уезжает в заметку.
  flaky: 'passed',
  timedout: 'failed',
  interrupted: 'failed',
};

/** Ссылка на кейс: группа плюс идентификатор внутри неё. */
interface CaseRef {
  groupId: string;
  caseId: string;
}

export function parseJUnit(xml: string): ImportedTestResult[] {
  const results: ImportedTestResult[] = [];
  for (const suite of findElements(xml, 'testsuite')) {
    const suiteName = suite.attributes.name ?? '';
    for (const item of findElements(suite.body, 'testcase')) {
      results.push(junitCase(item.attributes, item.body, suiteName));
    }
  }
  // Отчёт без обёртки `<testsuite>` — редкость, но встречается у самодельных
  // репортёров; тогда берём случаи напрямую, иначе импорт молча пуст.
  if (results.length === 0) {
    for (const item of findElements(xml, 'testcase')) {
      results.push(junitCase(item.attributes, item.body, ''));
    }
  }
  return results;
}

function junitCase(
  attributes: Record<string, string>,
  body: string,
  suiteName: string,
): ImportedTestResult {
  const name = (attributes.name ?? '').trim();
  const className = (attributes.classname ?? attributes.class ?? '').trim();
  const failure = findElements(body, 'failure')[0] ?? findElements(body, 'error')[0];
  const externalId = junitProperty(body) ?? markerIn(name);
  const skipped = findElements(body, 'skipped')[0];

  let status: ProjectTestStatus = 'passed';
  if (failure) status = 'failed';
  else if (skipped) status = 'skipped';
  else if (attributes.status) status = toStatus(attributes.status) as ProjectTestStatus;

  const seconds = Number(attributes.time);
  const detail = failure ?? skipped;
  const message = detail
    ? (detail.attributes.message ?? '').trim() || textContent(detail.body)
    : undefined;

  return {
    name,
    aliases: nameAliases(name, className, suiteName),
    externalId,
    status,
    durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined,
    message: message ? message.slice(0, MAX_MESSAGE) : undefined,
  };
}

/**
 * Имена свойств junit, которыми адаптеры TMS помечают тест. Их несколько,
 * потому что единого стандарта нет: pytest пишет `test_id`, JUnit 5 — `testId`,
 * адаптеры Zephyr и Xray — `tms` и `externalId`.
 */
const ID_PROPERTIES = new Set([
  'externalid',
  'testid',
  'test_id',
  'tms',
  'tms_id',
  'case_id',
  'id',
  'allure_id',
]);

/** Ключ теста из `<properties>` случая junit. */
function junitProperty(body: string): string | undefined {
  for (const element of findElements(body, 'property')) {
    const name = (element.attributes.name ?? '').trim().toLowerCase();
    const value = (element.attributes.value ?? '').trim();
    if (value && ID_PROPERTIES.has(name)) return value;
  }
  return undefined;
}

/**
 * Ключ из имени теста: `@TC-14` или `[TC-14]`.
 *
 * Так помечают тест там, где репортёр своих полей не даёт, — а это самый частый
 * случай: приписать `@QA-42` к названию может кто угодно и в любом фреймворке.
 */
function markerIn(name: string): string | undefined {
  const at = name.match(/@([A-Za-z][\w-]{1,40})/);
  if (at?.[1]) return at[1];
  const bracket = name.match(/\[([^\]]{1,60})]/);
  return bracket?.[1]?.trim() || undefined;
}

/** Форма отчёта Playwright ровно в тех полях, которые нам нужны. */
interface PlaywrightResult {
  status?: string;
  duration?: number;
  error?: { message?: string };
  errors?: { message?: string }[];
}
interface PlaywrightAnnotation {
  type?: string;
  description?: string;
}
interface PlaywrightTest {
  status?: string;
  results?: PlaywrightResult[];
  annotations?: PlaywrightAnnotation[];
}
interface PlaywrightSpec {
  title?: string;
  file?: string;
  ok?: boolean;
  tests?: PlaywrightTest[];
  annotations?: PlaywrightAnnotation[];
}
interface PlaywrightSuite {
  title?: string;
  file?: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

export function parsePlaywrightJson(content: string): ImportedTestResult[] {
  const report = safeJson(content) as { suites?: PlaywrightSuite[] } | undefined;
  if (!report || !Array.isArray(report.suites)) return [];
  const results: ImportedTestResult[] = [];
  for (const suite of report.suites) walkPlaywrightSuite(suite, [], '', results);
  return results;
}

function walkPlaywrightSuite(
  suite: PlaywrightSuite,
  titles: string[],
  file: string,
  out: ImportedTestResult[],
): void {
  const nextFile = suite.file ?? file;
  // Заголовок корневой сюиты — это имя файла; в путь названий он не идёт,
  // иначе алиас получался бы вида `chat.spec.ts > chat.spec.ts > тест`.
  const nextTitles =
    suite.title && suite.title !== nextFile ? [...titles, suite.title] : [...titles];

  for (const spec of suite.specs ?? []) out.push(playwrightSpec(spec, nextTitles, nextFile));
  for (const nested of suite.suites ?? []) walkPlaywrightSuite(nested, nextTitles, nextFile, out);
}

function playwrightSpec(spec: PlaywrightSpec, titles: string[], file: string): ImportedTestResult {
  const name = (spec.title ?? '').trim();
  const attempts = spec.tests ?? [];
  const last = attempts[attempts.length - 1];
  const word = last?.status ?? last?.results?.[last.results.length - 1]?.status;
  const status = toStatus(
    PLAYWRIGHT_WORDS[String(word).toLowerCase()] ?? word,
  ) as ProjectTestStatus;

  const duration = attempts
    .flatMap((attempt) => attempt.results ?? [])
    .reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  const failed = attempts
    .flatMap((attempt) => attempt.results ?? [])
    .find((item) => item.error?.message ?? item.errors?.[0]?.message);
  const note =
    String(word).toLowerCase() === 'flaky'
      ? 'Нестабильный: прошёл только на повторе.'
      : (failed?.error?.message ?? failed?.errors?.[0]?.message);

  const path = [...titles, name].filter(Boolean).join(' › ');
  return {
    name,
    aliases: [path, file ? `${file} › ${path}` : '', spec.file ? `${spec.file} › ${name}` : ''],
    // Аннотация спека и аннотация прогона — одно и то же поле в разных версиях
    // репортёра; берём ту, что есть, иначе метку из имени.
    externalId:
      annotationId(spec.annotations) ??
      attempts.map((attempt) => annotationId(attempt.annotations)).find(Boolean) ??
      markerIn(name),
    status,
    durationMs: duration > 0 ? Math.round(duration) : undefined,
    message: note ? note.slice(0, MAX_MESSAGE) : undefined,
  };
}

/** Ключ теста из аннотаций Playwright. */
function annotationId(annotations?: PlaywrightAnnotation[]): string | undefined {
  for (const annotation of annotations ?? []) {
    const type = (annotation.type ?? '').trim().toLowerCase();
    const value = (annotation.description ?? '').trim();
    if (value && ID_PROPERTIES.has(type)) return value;
  }
  return undefined;
}

/** Одна запись Allure (`*-result.json`) — тоже только нужные поля. */
interface AllureResult {
  name?: string;
  fullName?: string;
  status?: string;
  statusDetails?: { message?: string };
  start?: number;
  stop?: number;
  labels?: { name?: string; value?: string }[];
  links?: { type?: string; name?: string; url?: string }[];
}

/**
 * Ключ теста из Allure: метка (`as_id`, `tms`, `testId`) или ссылка типа `tms`.
 * У ссылки берётся имя, а не адрес: адрес ведёт в сам TMS, а сопоставляемся мы
 * с ключом, который в этом имени и записан.
 */
function allureId(record: AllureResult): string | undefined {
  for (const label of record.labels ?? []) {
    const name = (label.name ?? '').trim().toLowerCase();
    const value = (label.value ?? '').trim();
    if (value && (ID_PROPERTIES.has(name) || name === 'as_id')) return value;
  }
  const link = (record.links ?? []).find((item) => (item.type ?? '').toLowerCase() === 'tms');
  return link?.name?.trim() || undefined;
}

export function parseAllure(contents: string[]): ImportedTestResult[] {
  const results: ImportedTestResult[] = [];
  for (const content of contents) {
    const data = safeJson(content);
    const items: unknown[] = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as AllureResult;
      const name = (record.name ?? '').trim();
      if (!name) continue;
      const suite = record.labels?.find((label) => label.name === 'suite')?.value ?? '';
      const started = Number(record.start);
      const stopped = Number(record.stop);
      const durationMs =
        Number.isFinite(started) && Number.isFinite(stopped) && stopped >= started
          ? stopped - started
          : undefined;
      results.push({
        name,
        aliases: nameAliases(name, record.fullName ?? '', suite),
        externalId: allureId(record) ?? markerIn(name),
        status: toStatus(record.status) as ProjectTestStatus,
        durationMs,
        message: record.statusDetails?.message?.slice(0, MAX_MESSAGE),
      });
    }
  }
  return results;
}

/**
 * Импорт результатов: разобрать, разложить по кейсам, записать прогон.
 *
 * Порядок важен: статусы кладутся ПОСЛЕ записи прогона, чтобы `lastRunId` в
 * кейсе всегда указывал на существующий файл истории.
 */
export function importResults(root: string, input: ImportResultsInput): ProjectTestImportResult {
  const now = input.now ?? new Date().toISOString();
  const sources = readSources(root, input);
  const parsed = parseByFormat(input.format, sources);

  const groups = readGroups(root);
  const index = buildIndex(groups);
  const matched = new Map<string, { ref: CaseRef; result: ImportedTestResult }>();
  const unmatched: string[] = [];

  for (const result of parsed) {
    const ref = matchCase(result, index);
    if (!ref) {
      if (result.name && !unmatched.includes(result.name)) unmatched.push(result.name);
      continue;
    }
    const key = `${ref.groupId}/${ref.caseId}`;
    const previous = matched.get(key);
    // Один кейс мог получить несколько результатов (параметризованный тест,
    // прогон на нескольких браузерах). Побеждает худший: «где-то упало» — это
    // падение, а не «в одном месте прошло».
    if (!previous || severity(result.status) > severity(previous.result.status)) {
      matched.set(key, { ref, result });
    }
  }

  const runId = randomUUID();
  const points: ProjectTestPointResult[] = [...matched.values()].map(({ ref, result }) => ({
    pointId: pointId(ref.groupId, ref.caseId, input.environmentId),
    groupId: ref.groupId,
    caseId: ref.caseId,
    environmentId: input.environmentId,
    status: result.status,
    note: result.message,
    startedAt: now,
    finishedAt: now,
    durationMs: result.durationMs,
  }));

  const record: ProjectTestRunRecord = {
    id: runId,
    mode: 'import',
    actor: 'ci',
    environmentId: input.environmentId,
    ...gitContext(root),
    scope: `Импорт результатов (${input.format})`,
    status: 'done',
    startedAt: now,
    finishedAt: now,
    results: points,
    summary: summarize(points),
  };
  writeRun(root, record);

  const patches: CaseResultPatch[] = points.map((point) => ({
    groupId: point.groupId,
    caseId: point.caseId,
    status: point.status,
    note: point.note,
    runId,
    at: now,
  }));
  const applied = applyResults(root, patches, now);

  return {
    format: input.format,
    read: parsed.length,
    matched: applied,
    created: 0,
    unmatched,
    runId,
  };
}

function parseByFormat(
  format: ImportResultsInput['format'],
  sources: string[],
): ImportedTestResult[] {
  if (format === 'junit') return sources.flatMap((source) => parseJUnit(source));
  if (format === 'playwright') return sources.flatMap((source) => parsePlaywrightJson(source));
  if (format === 'allure') return parseAllure(sources);
  throw new ProjectTestsError(`Неизвестный формат результатов: ${String(format)}.`);
}

/** Содержимое отчёта: из тела запроса или из файла (каталога) внутри проекта. */
function readSources(root: string, input: ImportResultsInput): string[] {
  if (typeof input.content === 'string' && input.content.trim()) return [input.content];
  const file = input.file?.trim();
  if (!file) {
    throw new ProjectTestsError('Нечего импортировать: нет ни содержимого, ни пути к файлу.');
  }

  let path: string;
  try {
    path = resolveProjectPath(root, file);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new ProjectTestsError(error.message);
    throw error;
  }
  if (!existsSync(path)) throw new ProjectTestsError(`Файл результатов не найден: ${file}`);

  if (statSync(path).isDirectory()) {
    const names = readdirSync(path).filter((name) => name.endsWith('-result.json'));
    if (names.length === 0) {
      throw new ProjectTestsError(`В каталоге «${file}» нет файлов *-result.json.`);
    }
    return names.map((name) => readFileSync(join(path, name), 'utf8'));
  }
  return [readFileSync(path, 'utf8')];
}

/** Указатели на кейсы — по одному на каждое правило сопоставления. */
interface CaseIndex {
  byExternalId: Map<string, CaseRef>;
  byTestName: Map<string, CaseRef>;
  byId: Map<string, CaseRef>;
  byTitle: Map<string, CaseRef>;
}

function buildIndex(groups: ProjectTestGroup[]): CaseIndex {
  const index: CaseIndex = {
    byExternalId: new Map(),
    byTestName: new Map(),
    byId: new Map(),
    byTitle: new Map(),
  };
  for (const group of groups) {
    if (group.error) continue;
    for (const item of group.cases) {
      const ref: CaseRef = { groupId: group.id, caseId: item.id };
      // Первый победил: одинаковые названия в разных группах — не повод
      // переписывать уже найденный кейс более поздним.
      remember(index.byId, item.id, ref);
      remember(index.byTitle, item.title, ref);
      if (item.automation?.externalId) {
        remember(index.byExternalId, item.automation.externalId, ref);
      }
      if (item.automation?.testName) remember(index.byTestName, item.automation.testName, ref);
    }
  }
  return index;
}

function remember(map: Map<string, CaseRef>, key: string, ref: CaseRef): void {
  const normalized = normalize(key);
  if (normalized && !map.has(normalized)) map.set(normalized, ref);
}

function matchCase(result: ImportedTestResult, index: CaseIndex): CaseRef | undefined {
  const names = [result.name, ...(result.aliases ?? [])].filter(Boolean);

  // Ключ первым: он и заведён ради того, чтобы пережить переименование теста.
  if (result.externalId) {
    const hit = index.byExternalId.get(normalize(result.externalId));
    if (hit) return hit;
  }
  for (const name of names) {
    const hit = index.byTestName.get(normalize(name));
    if (hit) return hit;
  }
  for (const name of names) {
    for (const marker of name.matchAll(/\[([^\]]{1,60})]/g)) {
      const hit = index.byId.get(normalize(marker[1] ?? ''));
      if (hit) return hit;
    }
  }
  for (const name of names) {
    const hit = index.byTitle.get(normalize(name));
    if (hit) return hit;
  }
  return undefined;
}

/** Написания одного имени, по которым стоит попробовать сопоставление. */
function nameAliases(name: string, owner: string, suite: string): string[] {
  return [
    owner && name ? `${owner}.${name}` : '',
    owner && name ? `${owner} › ${name}` : '',
    suite && name ? `${suite} › ${name}` : '',
    owner,
  ].filter(Boolean);
}

/** Ключ сравнения: регистр, пробелы и разные тире именами теста не считаются. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[›»>]/g, '>').replace(/\s+/g, ' ');
}

function severity(status: string): number {
  return SEVERITY[status] ?? 0;
}

function safeJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new ProjectTestsError(`Файл результатов не разобрался: ${(error as Error).message}`);
  }
}
