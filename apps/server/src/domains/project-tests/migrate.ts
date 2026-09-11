import type { ProjectTestImportResult, ProjectTestStep } from '@agentdeck/contracts';
import { toStatus } from '@agentdeck/contracts/test-format';
import { slugify } from '../../lib/slug.ts';
import { ProjectTestsError } from './files.ts';
import { applyRows, parseCsv, parseRows, type ParsedCaseRow } from './import-cases.ts';
import { createGroup } from './store.ts';

/**
 * Переезд из чужой TMS: TestRail и Allure TestOps — целиком, вместе с деревом.
 *
 * Отличие от `import-cases.ts` ровно одно и оно принципиальное: обычный импорт
 * кладёт таблицу в ОДНУ группу, которую человек выбрал сам, а переезд разбирает
 * выгрузку по её собственному дереву — сюита выгрузки становится группой
 * (вкладкой), а путь секции ложится в `case.section`. Без этого переезд
 * нескольких сотен кейсов превращается в одну плоскую простыню, где ничего не
 * найти, и человек справедливо решает, что переехать нельзя.
 *
 * Что переносится: название, цель, предусловие, шаги (в том числе разложенные
 * TestRail по колонкам), ожидание, приоритет, теги, ссылки и привязка к
 * автотесту. Что НЕ переносится и не будет: история прогонов чужой системы,
 * вложения и права. История чужой TMS не воспроизводима в наших файлах, а
 * подделывать её — врать; вложения тянут за собой скачивание из чужого API.
 *
 * Все перенесённые кейсы помечены человеческими (`source: 'human'`, ставится в
 * `toCase`): агенту запрещено удалять такие, иначе первый же прогон снесёт
 * то, что переносили полдня.
 */

/** Итог переезда: обычный итог импорта плюс список заведённых групп. */
export interface MigrationResult extends ProjectTestImportResult {
  groups: string[];
}

/** Настройки переезда. */
export interface MigrationInput {
  /** Куда класть кейсы без сюиты. По умолчанию — имя системы-источника. */
  fallbackGroupId?: string;
  now?: string;
}

/** Выгрузка TestRail (CSV) → группы и кейсы. */
export function migrateTestRail(
  root: string,
  content: string,
  input: MigrationInput = {},
): MigrationResult {
  const rows = parseRows(parseCsv(content));
  if (rows.length === 0) {
    throw new ProjectTestsError(
      'Выгрузка TestRail не разобралась: не нашлось ни заголовков, ни строк с названием кейса.',
    );
  }
  return distribute(root, rows, input.fallbackGroupId ?? 'testrail', 'testrail-csv', input.now);
}

/**
 * Выгрузка Allure TestOps → группы и кейсы.
 *
 * TestOps отдаёт и JSON, и CSV, причём JSON бывает и голым массивом, и
 * обёрткой `{content:[…]}` постраничного ответа его API. Все три случая тут
 * разбираются одинаково: выбор по первому непробельному символу, а не по
 * названию файла — имя выгрузки ничего не гарантирует.
 */
export function migrateAllureTestOps(
  root: string,
  content: string,
  input: MigrationInput = {},
): MigrationResult {
  const head = content.trimStart()[0];
  const rows =
    head === '{' || head === '[' ? parseTestOpsJson(content) : parseRows(parseCsv(content));
  if (rows.length === 0) {
    throw new ProjectTestsError('Выгрузка Allure TestOps не разобралась: кейсов в ней не нашлось.');
  }
  return distribute(root, rows, input.fallbackGroupId ?? 'allure', 'allure', input.now);
}

/** Кейс Allure TestOps в тех полях, которые вообще имеют смысл переносить. */
interface TestOpsCase {
  id?: number | string;
  name?: string;
  fullName?: string;
  description?: string;
  precondition?: string;
  preconditions?: string;
  expectedResult?: string;
  expected?: string;
  status?: string;
  automated?: boolean;
  layer?: string | { name?: string };
  suite?: string | { name?: string };
  parentSuite?: string;
  path?: string | string[];
  epic?: string;
  feature?: string;
  story?: string;
  tags?: (string | { name?: string })[];
  links?: (string | { url?: string; name?: string })[];
  scenario?: { steps?: TestOpsStep[] };
  steps?: TestOpsStep[];
  testCaseId?: string;
}

interface TestOpsStep {
  name?: string;
  keyword?: string;
  expectedResult?: string;
  expected?: string;
  steps?: TestOpsStep[];
}

function parseTestOpsJson(content: string): ParsedCaseRow[] {
  let data: unknown;
  try {
    data = JSON.parse(content) as unknown;
  } catch (error) {
    throw new ProjectTestsError(`Выгрузка не разобралась: ${(error as Error).message}`);
  }

  const container = data as { content?: unknown; testCases?: unknown; items?: unknown };
  const list = [data, container?.content, container?.testCases, container?.items].find((item) =>
    Array.isArray(item),
  ) as unknown[] | undefined;
  if (!list) return [];

  const rows: ParsedCaseRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as TestOpsCase;
    const title = (record.name ?? record.fullName ?? '').trim();
    if (!title) continue;

    const suite = pickName(record.suite) || record.parentSuite || pickName(record.layer) || '';
    const section = [record.epic, record.feature, record.story]
      .map((part) => (part ?? '').trim())
      .filter(Boolean)
      .join('/');

    rows.push({
      id: record.testCaseId ?? (record.id === undefined ? undefined : String(record.id)),
      title,
      suite: suite || undefined,
      section: section || sectionFromPath(record.path),
      purpose: record.description?.trim() || undefined,
      precondition: (record.precondition ?? record.preconditions)?.trim() || undefined,
      steps: testOpsSteps(record.scenario?.steps ?? record.steps ?? []),
      expected: (record.expectedResult ?? record.expected)?.trim() || undefined,
      tags: record.tags
        ?.map((tag) => (typeof tag === 'string' ? tag : (tag?.name ?? '')).trim())
        .filter(Boolean),
      links: record.links
        ?.map((link) => (typeof link === 'string' ? link : (link?.url ?? '')).trim())
        .filter(Boolean)
        .map((url) => ({ type: 'requirement' as const, url })),
      automation: record.automated ? { status: 'automated' } : undefined,
      status: record.status ? (toStatus(record.status) as ParsedCaseRow['status']) : undefined,
    });
  }
  return rows;
}

/** Шаги TestOps: вложенные разворачиваются в плоский список, как и у нас. */
function testOpsSteps(steps: TestOpsStep[]): ProjectTestStep[] {
  const flat: ProjectTestStep[] = [];
  for (const step of steps) {
    const action = (step.name ?? step.keyword ?? '').trim();
    const expected = (step.expectedResult ?? step.expected ?? '').trim();
    if (action) flat.push(expected ? { action, expected } : { action });
    if (step.steps?.length) flat.push(...testOpsSteps(step.steps));
  }
  return flat;
}

function pickName(value: string | { name?: string } | undefined): string {
  if (typeof value === 'string') return value.trim();
  return (value?.name ?? '').trim();
}

function sectionFromPath(path: string | string[] | undefined): string | undefined {
  if (Array.isArray(path)) return path.filter(Boolean).join('/') || undefined;
  return normalizeSection(path);
}

/** Путь секции чужой системы к нашему виду: разделитель один — косая черта. */
function normalizeSection(value: string | undefined): string | undefined {
  const section = (value ?? '')
    .split(/\s*(?:>|›|\\|\/|»)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
  return section || undefined;
}

/**
 * Разложить разобранные кейсы по группам и записать.
 *
 * Записывается ПО ГРУППЕ ЗА РАЗ (`applyRows`), а не по кейсу: переезд — это
 * сотни строк, и построчная запись означала бы сотни перезаписей одного файла.
 */
function distribute(
  root: string,
  rows: ParsedCaseRow[],
  fallbackGroup: string,
  format: ProjectTestImportResult['format'],
  now?: string,
): MigrationResult {
  const moment = now ?? new Date().toISOString();
  const byGroup = new Map<string, { title: string; rows: ParsedCaseRow[] }>();

  for (const row of rows) {
    const source = row.suite?.trim() || '';
    const id = groupIdFrom(source, fallbackGroup);
    const bucket = byGroup.get(id) ?? { title: source || fallbackGroup, rows: [] };
    bucket.rows.push({ ...row, suite: undefined, section: normalizeSection(row.section) });
    byGroup.set(id, bucket);
  }

  let matched = 0;
  let created = 0;
  const groups: string[] = [];
  const unmatched: string[] = [];
  for (const [id, bucket] of byGroup) {
    createGroup(root, id, bucket.title, `Перенесено из внешней системы (${format}).`);
    const applied = applyRows(root, id, bucket.rows, moment);
    matched += applied.matched;
    created += applied.created;
    unmatched.push(...applied.conflicts);
    groups.push(id);
  }

  return { format, read: rows.length, matched, created, unmatched, groups };
}

/** Имя сюиты → идентификатор группы (он же имя файла): латиница, цифры, дефис. */
export function groupIdFrom(name: string, fallback: string): string {
  const slug = slugify(name, 40).replace(/^-+|-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : fallback;
}
