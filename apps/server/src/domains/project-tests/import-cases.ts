import { existsSync, readFileSync } from 'node:fs';
import type {
  ProjectTestAutomation,
  ProjectTestCase,
  ProjectTestImportResult,
  ProjectTestKind,
  ProjectTestLink,
  ProjectTestPriority,
  ProjectTestReadiness,
  ProjectTestStatus,
  ProjectTestStep,
} from '@agentdeck/contracts';
import { toStatus, toSteps } from '@agentdeck/contracts/test-format';
import { readZip } from '../../lib/zip.ts';
import { ProjectFileError, resolveProjectPath } from '../project-files/paths.ts';
import { ProjectTestsError } from './files.ts';
import { findElements, textContent } from './import-xml.ts';
import { requireGroup, writeGroup } from './store.ts';

/**
 * Кейсы ИЗВНЕ: таблица, книга Excel, выгрузка TestRail.
 *
 * У любой команды, которая приходит сюда не с нуля, тесты уже где-то описаны —
 * чаще всего в таблице. Заставлять переписывать их руками значит не получить
 * их вовсе, поэтому вход должен принимать то, что у людей есть, а не то, что
 * нам удобно разбирать.
 *
 * КОЛОНКИ ОПОЗНАЮТСЯ ПО ЗАГОЛОВКУ, а не по порядку: у чужой таблицы свой
 * порядок, и требовать «третьей колонкой шаги» — это гарантированный мусор в
 * базе. Словарь заголовков ниже двуязычный, регистр и пунктуация не важны:
 *
 *   название      | title, name, test case, case, кейс, тест, название, заголовок
 *   секция        | section, suite, folder, раздел, секция, группа, папка
 *   зона          | area, component, module, зона, компонент, модуль
 *   цель          | purpose, objective, description, цель, назначение, описание
 *   предусловие   | precondition(s), preconditions, предусловие, предусловия
 *   шаги          | steps, step, scenario, шаги, шаг, сценарий
 *   ожидание      | expected, expected result, ожидание, ожидаемый результат
 *   постусловие   | postcondition, постусловие
 *   приоритет     | priority, приоритет
 *   теги          | tags, labels, теги, метки
 *   тип           | type, тип
 *   статус        | status, статус, результат
 *   готовность    | readiness, state, готовность
 *   оракул        | oracle, оракул, доказательство
 *   длительность  | duration, estimate, длительность, оценка
 *   ссылки        | links, references, refs, ссылки, требования
 *   автотест      | automation, automated, автоматизация
 *   файл теста    | test file, automation file, файл теста, файл автотеста
 *   имя теста     | test name, automation test, имя теста
 *   файлы кода    | code, code paths, файлы кода, код
 *   идентификатор | id, key, ключ, идентификатор
 *
 * Отдельно понимается разбивка шагов TestRail по колонкам
 * (`Steps Separated (Step 1)` / `(Expected Result 1)`) — иначе выгрузка с
 * раздельными шагами приезжает пустой.
 *
 * XLSX читается своими руками (`lib/zip.ts` + разбор XML): книга Excel — это
 * zip с XML внутри, и ради двух файлов из него тянуть пакет незачем.
 * Поддерживаются общие строки (`sharedStrings.xml`) и строки внутри ячейки
 * (`inlineStr`); формулы, стили, даты как числа — нет, они приезжают тем, что
 * лежит в `<v>`.
 */

/** Строка таблицы, разобранная в поля кейса. */
export interface ParsedCaseRow {
  id?: string;
  title: string;
  /** Сюита из выгрузки: `migrate.ts` делает из неё отдельную группу. */
  suite?: string;
  section?: string;
  area?: string;
  purpose?: string;
  precondition?: string;
  steps: ProjectTestStep[];
  expected?: string;
  postcondition?: string;
  oracle?: string;
  priority?: ProjectTestPriority;
  readiness?: ProjectTestReadiness;
  type?: ProjectTestKind;
  duration?: number;
  tags?: string[];
  links?: ProjectTestLink[];
  automation?: ProjectTestAutomation;
  codePaths?: string[];
  status?: ProjectTestStatus;
}

/** Что и откуда импортировать. `content` для XLSX — base64. */
export interface ImportCasesInput {
  format: 'csv' | 'xlsx' | 'testrail-csv';
  groupId: string;
  content?: string;
  /** Путь файла от корня проекта — им пользуется CLI, где файл уже на диске. */
  file?: string;
  now?: string;
}

/** Заголовок → поле кейса. Ключи уже нормализованы (`normalizeHeader`). */
const HEADERS: Record<string, keyof ParsedCaseRow> = {
  ...spread('title', [
    'title',
    'name',
    'testcase',
    'test case',
    'case',
    'кейс',
    'тест',
    'название',
    'наименование',
    'заголовок',
    'тесткейс',
  ]),
  ...spread('id', ['id', 'key', 'caseid', 'case id', 'ключ', 'идентификатор', 'номер']),
  ...spread('suite', ['suite', 'testsuite', 'сюита', 'набор']),
  ...spread('section', [
    'section',
    'folder',
    'path',
    'раздел',
    'секция',
    'группа',
    'папка',
    'модуль тестов',
  ]),
  ...spread('area', ['area', 'component', 'module', 'зона', 'компонент', 'модуль']),
  ...spread('purpose', [
    'purpose',
    'objective',
    'description',
    'goal',
    'цель',
    'назначение',
    'описание',
  ]),
  ...spread('precondition', [
    'precondition',
    'preconditions',
    'предусловие',
    'предусловия',
    'подготовка',
  ]),
  ...spread('steps', ['steps', 'step', 'scenario', 'teststeps', 'шаги', 'шаг', 'сценарий']),
  ...spread('expected', [
    'expected',
    'expectedresult',
    'expected result',
    'result',
    'ожидание',
    'ожидаемый результат',
    'результат',
  ]),
  ...spread('postcondition', ['postcondition', 'postconditions', 'постусловие', 'постусловия']),
  ...spread('oracle', ['oracle', 'evidence', 'оракул', 'доказательство']),
  ...spread('priority', ['priority', 'severity', 'приоритет', 'важность']),
  ...spread('readiness', ['readiness', 'state', 'готовность', 'состояние']),
  ...spread('type', ['type', 'kind', 'тип', 'вид']),
  ...spread('duration', ['duration', 'estimate', 'длительность', 'оценка', 'время']),
  ...spread('tags', ['tags', 'labels', 'теги', 'метки', 'ярлыки']),
  ...spread('links', ['links', 'references', 'refs', 'ссылки', 'требования']),
  ...spread('status', ['status', 'статус']),
  ...spread('codePaths', ['code', 'codepaths', 'code paths', 'файлы кода', 'код']),
};

/** Колонки автоматизации разобраны отдельно: у них три разных смысла. */
const AUTOMATION_HEADERS: Record<string, 'status' | 'file' | 'testName'> = {
  automation: 'status',
  automated: 'status',
  автоматизация: 'status',
  автотест: 'status',
  'test file': 'file',
  testfile: 'file',
  'automation file': 'file',
  automationfile: 'file',
  'файл теста': 'file',
  'файл автотеста': 'file',
  'test name': 'testName',
  testname: 'testName',
  'automation test': 'testName',
  'имя теста': 'testName',
};

const PRIORITY_WORDS: Record<string, ProjectTestPriority> = {
  blocker: 'blocker',
  critical: 'blocker',
  '4': 'blocker',
  блокер: 'blocker',
  критический: 'blocker',
  блокирующий: 'blocker',
  high: 'high',
  '3': 'high',
  высокий: 'high',
  medium: 'medium',
  normal: 'medium',
  '2': 'medium',
  средний: 'medium',
  обычный: 'medium',
  low: 'low',
  '1': 'low',
  низкий: 'low',
};

const READINESS_WORDS: Record<string, ProjectTestReadiness> = {
  draft: 'draft',
  черновик: 'draft',
  ready: 'ready',
  approved: 'ready',
  готов: 'ready',
  готово: 'ready',
  obsolete: 'obsolete',
  deprecated: 'obsolete',
  устарел: 'obsolete',
  устарело: 'obsolete',
};

const AUTOMATION_WORDS: Record<string, ProjectTestAutomation['status']> = {
  manual: 'manual',
  ручной: 'manual',
  руками: 'manual',
  no: 'manual',
  нет: 'manual',
  toautomate: 'toAutomate',
  'to automate': 'toAutomate',
  planned: 'toAutomate',
  кавтоматизации: 'toAutomate',
  'к автоматизации': 'toAutomate',
  automated: 'automated',
  yes: 'automated',
  да: 'automated',
  автоматизирован: 'automated',
};

/** Разделители, которые встречаются в выгрузках: запятая, точка с запятой, таб. */
const DELIMITERS = [',', ';', '\t'];

/** Одна пара «поле → все его заголовки» в виде словаря. */
function spread(field: keyof ParsedCaseRow, names: string[]): Record<string, keyof ParsedCaseRow> {
  const result: Record<string, keyof ParsedCaseRow> = {};
  for (const name of names) result[normalizeHeader(name)] = field;
  return result;
}

/** Заголовок в сравнимый вид: регистр, пробелы и пунктуация значения не имеют. */
export function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_.:*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Разбор CSV по RFC 4180: кавычки, удвоенная кавычка внутри значения, перевод
 * строки внутри кавычек. Разделитель определяется по первой строке — выгрузки
 * приходят и с запятой (TestRail), и с точкой с запятой (Excel на русской
 * локали), и требовать «сначала поправьте файл» здесь не за что.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const source = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const separator = delimiter ?? detectDelimiter(source);

  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          value += '"';
          index += 1;
        } else quoted = false;
      } else value += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === separator) {
      row.push(value);
      value = '';
      continue;
    }
    if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }
    value += char;
  }
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  // Пустые хвостовые строки — обычный след редактора, а не запись.
  return rows.filter((item) => item.some((cell) => cell.trim()));
}

function detectDelimiter(source: string): string {
  const line = source.split('\n')[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = countOutsideQuotes(line, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, char: string): number {
  let quoted = false;
  let count = 0;
  for (const symbol of line) {
    if (symbol === '"') quoted = !quoted;
    else if (!quoted && symbol === char) count += 1;
  }
  return count;
}

/** Лист книги Excel как таблица строк. Формулы и стили игнорируются. */
export function readXlsx(buffer: Buffer): string[][] {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    throw new ProjectTestsError(`Это не книга Excel: ${(error as Error).message}`);
  }

  const shared = readSharedStrings(entries);
  const sheet =
    entries.find((entry) => entry.path === 'xl/worksheets/sheet1.xml') ??
    entries.find((entry) => /^xl\/worksheets\/[^/]+\.xml$/.test(entry.path));
  if (!sheet)
    throw new ProjectTestsError('В книге нет листа: xl/worksheets/sheet1.xml отсутствует.');

  const xml = sheet.data.toString('utf8');
  const rows: string[][] = [];
  for (const row of findElements(xml, 'row')) {
    const cells: string[] = [];
    for (const cell of findElements(row.body, 'c')) {
      const at = columnIndex(cell.attributes.r ?? '');
      const value = cellText(cell.attributes.t ?? '', cell.body, shared);
      const target = at >= 0 ? at : cells.length;
      while (cells.length < target) cells.push('');
      cells[target] = value;
    }
    rows.push(cells);
  }
  return rows.filter((item) => item.some((cell) => cell.trim()));
}

function readSharedStrings(entries: { path: string; data: Buffer }[]): string[] {
  const file = entries.find((entry) => entry.path === 'xl/sharedStrings.xml');
  if (!file) return [];
  return findElements(file.data.toString('utf8'), 'si').map((item) =>
    // У строки с оформлением текст разбит на куски <r><t>…</t></r> — склеиваем.
    findElements(item.body, 't')
      .map((part) => textContent(part.body))
      .join(''),
  );
}

function cellText(type: string, body: string, shared: string[]): string {
  if (type === 's') {
    const at = Number(textContent(findElements(body, 'v')[0]?.body ?? ''));
    return shared[at] ?? '';
  }
  if (type === 'inlineStr') {
    return findElements(body, 't')
      .map((part) => textContent(part.body))
      .join('');
  }
  return textContent(findElements(body, 'v')[0]?.body ?? '');
}

/** Номер колонки из адреса ячейки: `A1` → 0, `AB7` → 27. */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Таблица → кейсы. Первая строка — заголовки; строки без названия пропускаются. */
export function parseRows(rows: string[][]): ParsedCaseRow[] {
  const header = rows[0];
  if (!header) return [];
  const map = new Map<number, keyof ParsedCaseRow>();
  const automation = new Map<number, 'status' | 'file' | 'testName'>();
  const stepColumns: { index: number; order: number; kind: 'action' | 'expected' }[] = [];

  header.forEach((raw, index) => {
    const name = normalizeHeader(raw);
    const separated = splitStepHeader(name);
    if (separated) {
      stepColumns.push({ index, ...separated });
      return;
    }
    const automationField = AUTOMATION_HEADERS[name];
    if (automationField) {
      automation.set(index, automationField);
      return;
    }
    const field = HEADERS[name];
    if (field) map.set(index, field);
  });

  const cases: ParsedCaseRow[] = [];
  for (const row of rows.slice(1)) {
    const parsed = parseRow(row, map, automation, stepColumns);
    if (parsed) cases.push(parsed);
  }
  return cases;
}

/** `steps separated (step 3)` → шаг №3, действие. Формат выгрузки TestRail. */
function splitStepHeader(name: string): { order: number; kind: 'action' | 'expected' } | undefined {
  const match = /^steps?(?: separated)? \((step|expected result)\s*(\d*)\)$/.exec(name);
  if (!match) return undefined;
  return {
    order: Number(match[2] || '1'),
    kind: match[1] === 'step' ? 'action' : 'expected',
  };
}

function parseRow(
  row: string[],
  map: Map<number, keyof ParsedCaseRow>,
  automationColumns: Map<number, 'status' | 'file' | 'testName'>,
  stepColumns: { index: number; order: number; kind: 'action' | 'expected' }[],
): ParsedCaseRow | undefined {
  const raw: Partial<Record<keyof ParsedCaseRow, string>> = {};
  for (const [index, field] of map) {
    const cell = (row[index] ?? '').trim();
    if (cell) raw[field] = cell;
  }
  const title = raw.title?.trim();
  if (!title) return undefined;

  const automation: ProjectTestAutomation = { status: 'manual' };
  let hasAutomation = false;
  for (const [index, field] of automationColumns) {
    const cell = (row[index] ?? '').trim();
    if (!cell) continue;
    hasAutomation = true;
    if (field === 'status') automation.status = AUTOMATION_WORDS[normalizeHeader(cell)] ?? 'manual';
    if (field === 'file') automation.file = cell;
    if (field === 'testName') automation.testName = cell;
  }
  // Указан файл теста, но не указано состояние — это автоматизированный кейс:
  // иначе он молча приезжал бы «ручным» и не попадал в импорт результатов.
  if (hasAutomation && automation.file && automation.status === 'manual') {
    automation.status = 'automated';
  }

  const duration = Number(raw.duration?.replace(/[^\d.]/g, ''));

  return {
    id: raw.id,
    title,
    suite: raw.suite,
    section: raw.section,
    area: raw.area,
    purpose: raw.purpose,
    precondition: raw.precondition,
    steps: rowSteps(raw.steps ?? '', row, stepColumns),
    expected: raw.expected,
    postcondition: raw.postcondition,
    oracle: raw.oracle,
    priority: raw.priority ? PRIORITY_WORDS[normalizeHeader(raw.priority)] : undefined,
    readiness: raw.readiness ? READINESS_WORDS[normalizeHeader(raw.readiness)] : undefined,
    type: raw.type && /checklist|чек/i.test(raw.type) ? 'checklist' : 'case',
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    tags: splitList(raw.tags),
    links: splitList(raw.links)?.map((url) => ({ type: 'requirement' as const, url })),
    automation: hasAutomation ? automation : undefined,
    codePaths: splitList(raw.codePaths),
    status: raw.status ? (toStatus(raw.status) as ProjectTestStatus) : undefined,
  };
}

/**
 * Шаги строки: либо одна ячейка со строкой на шаг, либо раздельные колонки
 * TestRail. Формат ячейки — тот же, каким его пишет экспорт
 * (`действие · данные: … · ожидание: …`), поэтому выгруженное отсюда читается
 * обратно без потерь.
 */
function rowSteps(
  cell: string,
  row: string[],
  stepColumns: { index: number; order: number; kind: 'action' | 'expected' }[],
): ProjectTestStep[] {
  if (stepColumns.length > 0) {
    const byOrder = new Map<number, ProjectTestStep>();
    for (const column of [...stepColumns].sort((left, right) => left.order - right.order)) {
      const value = (row[column.index] ?? '').trim();
      if (!value) continue;
      const step = byOrder.get(column.order) ?? { action: '' };
      if (column.kind === 'action') step.action = value;
      else step.expected = value;
      byOrder.set(column.order, step);
    }
    const steps = [...byOrder.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, step]) => step)
      .filter((step) => step.action || step.expected);
    for (const step of steps) if (!step.action) step.action = 'Шаг без описания';
    if (steps.length > 0) return steps;
  }

  return cell
    .split('\n')
    .map((line) => parseStepLine(line))
    .filter((step): step is ProjectTestStep => step !== undefined);
}

/** Строка шага: нумерация отбрасывается, `данные:` и `ожидание:` разбираются. */
function parseStepLine(line: string): ProjectTestStep | undefined {
  const clean = line
    .trim()
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[-*]\s*/, '');
  if (!clean) return undefined;
  const parts = clean.split(' · ');
  const step: ProjectTestStep = { action: (parts[0] ?? '').trim() };
  for (const part of parts.slice(1)) {
    const value = part.trim();
    if (/^(данные|data):/i.test(value)) step.data = value.replace(/^[^:]+:\s*/, '');
    else if (/^(ожидание|expected):/i.test(value)) step.expected = value.replace(/^[^:]+:\s*/, '');
    else step.action = `${step.action} · ${value}`;
  }
  return step.action ? step : undefined;
}

function splitList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Разобранная строка → кейс. Статус нового кейса — «не гоняли», а не выдумка. */
export function toCase(row: ParsedCaseRow, id: string, now: string): ProjectTestCase {
  return {
    id,
    type: row.type ?? 'case',
    title: row.title,
    purpose: row.purpose,
    area: row.area,
    section: row.section,
    precondition: row.precondition,
    steps: toSteps(row.steps) as ProjectTestStep[],
    expected: row.expected,
    postcondition: row.postcondition,
    oracle: row.oracle,
    priority: row.priority,
    readiness: row.readiness,
    duration: row.duration,
    tags: row.tags,
    links: row.links,
    automation: row.automation,
    codePaths: row.codePaths,
    status: row.status ?? 'unknown',
    // Кейс пришёл из чужой таблицы, а её вёл человек: агенту такие удалять
    // запрещено, иначе первый же прогон снесёт перенесённую базу.
    source: 'human',
    updatedAt: now,
  };
}

/** Свободный идентификатор кейса в группе. */
export function freeCaseId(groupId: string, taken: Set<string>, seed: number): string {
  let index = seed;
  let id = `${groupId}-${String(index).padStart(3, '0')}`;
  while (taken.has(id)) {
    index += 1;
    id = `${groupId}-${String(index).padStart(3, '0')}`;
  }
  return id;
}

/**
 * Положить разобранные строки в группу одной записью.
 *
 * Одной — потому что таблица приносит сотни строк сразу, и сотня перезаписей
 * одного файла означала бы сотню шансов встретиться с агентом на той же
 * секунде. Совпадение по идентификатору или по названию обновляет кейс, а не
 * плодит двойник: повторный импорт правленой таблицы — обычное дело.
 */
export function applyRows(
  root: string,
  groupId: string,
  rows: ParsedCaseRow[],
  now: string,
): { matched: number; created: number } {
  const group = requireGroup(root, groupId);
  const taken = new Set(group.cases.map((item) => item.id));
  const byId = new Map(group.cases.map((item) => [item.id.toLowerCase(), item.id]));
  const byTitle = new Map(group.cases.map((item) => [item.title.trim().toLowerCase(), item.id]));

  let matched = 0;
  let created = 0;
  let seed = group.cases.length + 1;
  const cases = [...group.cases];

  for (const row of rows) {
    const existingId =
      (row.id ? byId.get(row.id.toLowerCase()) : undefined) ??
      byTitle.get(row.title.trim().toLowerCase());
    if (existingId) {
      const at = cases.findIndex((item) => item.id === existingId);
      const previous = cases[at];
      if (!previous) continue;
      // Статус и след прогона остаются прежними: таблица описывает кейс, а не
      // его результат, и затирать зелёное «не гоняли» из файла нельзя.
      cases[at] = {
        ...toCase(row, previous.id, now),
        status: row.status ?? previous.status,
        note: previous.note,
        lastRunAt: previous.lastRunAt,
        lastRunId: previous.lastRunId,
        defects: previous.defects,
        archived: previous.archived,
      };
      matched += 1;
      continue;
    }
    const id =
      row.id && !taken.has(row.id) && /^[\w-]{1,40}$/.test(row.id)
        ? row.id
        : freeCaseId(groupId, taken, seed);
    taken.add(id);
    seed += 1;
    cases.push(toCase(row, id, now));
    byTitle.set(row.title.trim().toLowerCase(), id);
    created += 1;
  }

  writeGroup(root, { ...group, cases });
  return { matched, created };
}

/** Импорт кейсов в одну группу. Группа должна существовать — её заводит панель. */
export function importCases(root: string, input: ImportCasesInput): ProjectTestImportResult {
  const now = input.now ?? new Date().toISOString();
  const rows =
    input.format === 'xlsx' ? readXlsx(readBinary(root, input)) : parseCsv(readText(root, input));
  const parsed = parseRows(rows);
  if (parsed.length === 0) {
    throw new ProjectTestsError(
      'В файле не нашлось ни одного кейса: проверьте, что первая строка — заголовки и среди них есть «Название».',
    );
  }

  const { matched, created } = applyRows(root, input.groupId, parsed, now);
  return {
    format: input.format,
    read: parsed.length,
    matched,
    created,
    unmatched: [],
  };
}

/** Текстовое содержимое: из тела запроса или из файла внутри проекта. */
function readText(root: string, input: ImportCasesInput): string {
  if (typeof input.content === 'string' && input.content.trim()) return input.content;
  return insideProject(root, input.file).toString('utf8');
}

/**
 * Двоичное содержимое: книга приходит в base64, потому что тело запроса —
 * JSON, а в него байты не положить.
 */
function readBinary(root: string, input: ImportCasesInput): Buffer {
  if (typeof input.content === 'string' && input.content.trim()) {
    const base64 = input.content.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) throw new ProjectTestsError('Пустое содержимое книги.');
    return buffer;
  }
  return insideProject(root, input.file);
}

function insideProject(root: string, file?: string): Buffer {
  const relative = file?.trim();
  if (!relative) {
    throw new ProjectTestsError('Нечего импортировать: нет ни содержимого, ни пути к файлу.');
  }
  let path: string;
  try {
    path = resolveProjectPath(root, relative);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new ProjectTestsError(error.message);
    throw error;
  }
  if (!existsSync(path)) throw new ProjectTestsError(`Файл не найден: ${relative}`);
  return readFileSync(path);
}
