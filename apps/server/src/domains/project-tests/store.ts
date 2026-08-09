import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestGroup,
  ProjectTestStatus,
} from '@claude-control/contracts';
import { writeJsonFile } from '../../lib/safe-io.ts';
import { ProjectFileError, resolveProjectPath } from '../project-files/paths.ts';

/**
 * Файлы тест-кейсов в `.agent/tests/` проверяемого проекта.
 *
 * Пишут сюда двое: панель (человек правит кейс руками) и агент (прогон
 * проставляет статусы, генерация заводит новые кейсы). Отсюда все решения ниже.
 *
 * Разбор ЩАДЯЩИЙ: чужой файл может быть недописан, с лишним полем или просто
 * сломан — тогда группа отдаётся с `error`, а её файл НЕ трогается. Молча
 * перезаписать сломанный JSON значит стереть работу, которую агент писал
 * полчаса, и человек об этом даже не узнает.
 *
 * Запись — только через `writeJsonFile` (атомарная замена): агент может читать
 * файл ровно в тот момент, когда панель его сохраняет.
 */

/** Папка с кейсами внутри проекта. Клиентская форма пути — всегда через `/`. */
export const TESTS_DIR = '.agent/tests';

/** Суффикс файла группы: по нему группа и опознаётся среди прочего в папке. */
const SUFFIX = '.tests.json';

/** Потолок на файл: кейсы — текст, мегабайты здесь означают порчу. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Группы, которые панель заводит сама, если в проекте ещё ничего нет. */
export const DEFAULT_GROUPS: { id: string; title: string; description: string }[] = [
  {
    id: 'gui',
    title: 'GUI',
    description: 'Проверки интерфейса: что нажали, что увидели.',
  },
  {
    id: 'e2e',
    title: 'E2E',
    description: 'Сквозные сценарии целиком — от действия пользователя до результата в данных.',
  },
];

/** Содержимое файла группы на диске. */
interface GroupFile {
  version: number;
  title?: string;
  description?: string;
  cases?: unknown;
}

export class ProjectTestsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectTestsError';
  }
}

/** Идентификатор группы = имя файла: диапазон сужен намеренно. */
export function assertGroupId(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    throw new ProjectTestsError(
      'Идентификатор группы: латиница в нижнем регистре, цифры и дефис, до 40 символов.',
    );
  }
  return id;
}

/** Абсолютный путь файла группы — с той же защитой от обхода, что у файлов проекта. */
function groupPath(root: string, id: string): string {
  try {
    return resolveProjectPath(root, `${TESTS_DIR}/${assertGroupId(id)}${SUFFIX}`);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new ProjectTestsError(error.message);
    throw error;
  }
}

/** Путь файла группы от корня проекта — его же видит человек в модалке. */
export function groupFile(id: string): string {
  return `${TESTS_DIR}/${id}${SUFFIX}`;
}

const STATUSES: ProjectTestStatus[] = ['unknown', 'running', 'passed', 'failed', 'skipped'];

/** Строка из чужого файла — или значение по умолчанию. */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Кейс из сырых данных. Агент пишет файл руками и ошибается в мелочах: шаги
 * одной строкой вместо списка, статус словом «ok», отсутствующий id. Всё это
 * чинится здесь, потому что альтернатива — красная вкладка вместо списка.
 */
function parseCase(raw: unknown, index: number): ProjectTestCase | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const title = text(item.title).trim();
  if (!title) return undefined;

  const rawSteps = item.steps;
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((step) => text(step).trim()).filter(Boolean)
    : text(rawSteps)
        .split('\n')
        .map((step) => step.trim())
        .filter(Boolean);

  const status = text(item.status) as ProjectTestStatus;

  return {
    id: text(item.id).trim() || `case-${index + 1}`,
    title,
    purpose: text(item.purpose).trim() || undefined,
    area: text(item.area).trim() || undefined,
    steps,
    expected: text(item.expected).trim() || undefined,
    status: STATUSES.includes(status) ? status : 'unknown',
    note: text(item.note).trim() || undefined,
    lastRunAt: text(item.lastRunAt).trim() || undefined,
    source: text(item.source) === 'human' ? 'human' : 'agent',
    updatedAt: text(item.updatedAt).trim() || undefined,
  };
}

/** Одинаковые id внутри группы ломают адресацию правок — разводим их здесь. */
function withUniqueIds(cases: ProjectTestCase[]): ProjectTestCase[] {
  const seen = new Set<string>();
  return cases.map((item) => {
    let id = item.id;
    let attempt = 2;
    while (seen.has(id)) id = `${item.id}-${attempt++}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/** Одна группа с диска. Файл сломан → группа с `error` и пустым списком. */
function readGroup(root: string, id: string): ProjectTestGroup {
  const file = groupFile(id);
  const path = groupPath(root, id);
  const base: ProjectTestGroup = { id, title: id.toUpperCase(), file, cases: [] };

  let raw: string;
  try {
    const stats = readFileSync(path);
    if (stats.byteLength > MAX_FILE_BYTES) {
      return { ...base, error: 'Файл слишком велик для списка тестов.' };
    }
    raw = stats.toString('utf8');
  } catch (error) {
    return { ...base, error: `Файл не читается: ${(error as Error).message}` };
  }

  let data: GroupFile;
  try {
    data = JSON.parse(raw) as GroupFile;
  } catch (error) {
    // Файл НЕ чиним и не перезаписываем: за сломанным JSON стоит чья-то работа.
    return { ...base, error: `Файл не разобрался: ${(error as Error).message}` };
  }

  const cases = Array.isArray(data?.cases)
    ? withUniqueIds(
        data.cases
          .map((item, index) => parseCase(item, index))
          .filter((item): item is ProjectTestCase => item !== undefined),
      )
    : [];

  return {
    id,
    title: text(data?.title).trim() || base.title,
    description: text(data?.description).trim() || undefined,
    file,
    cases,
  };
}

/** Идентификаторы групп, найденные в папке, в алфавитном порядке. */
function groupIds(root: string): string[] {
  const dir = join(root, ...TESTS_DIR.split('/'));
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(SUFFIX))
      .map((entry) => entry.name.slice(0, -SUFFIX.length))
      .filter((id) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
      .sort();
  } catch {
    return [];
  }
}

/** Все группы проекта. Пустой список — тестов в проекте ещё нет. */
export function readGroups(root: string): ProjectTestGroup[] {
  return groupIds(root).map((id) => readGroup(root, id));
}

/** Запись группы целиком. Сломанную группу писать нельзя — иначе затрём файл. */
function writeGroup(root: string, group: ProjectTestGroup): void {
  if (group.error) throw new ProjectTestsError(group.error);
  mkdirSync(join(root, ...TESTS_DIR.split('/')), { recursive: true });
  writeJsonFile(groupPath(root, group.id), {
    version: 1,
    title: group.title,
    description: group.description,
    cases: group.cases,
  });
}

/** Группа, готовая к правке: сломанную возвращаем ошибкой, а не пустышкой. */
function loadForWrite(root: string, id: string): ProjectTestGroup {
  const group = readGroup(root, assertGroupId(id));
  if (group.error && existsSync(groupPath(root, id))) throw new ProjectTestsError(group.error);
  return { ...group, error: undefined };
}

/** Создать группу (вкладку). Существующую не трогаем — вернём как есть. */
export function createGroup(
  root: string,
  id: string,
  title?: string,
  description?: string,
): ProjectTestGroup {
  const groupId = assertGroupId(id);
  if (existsSync(groupPath(root, groupId))) return readGroup(root, groupId);
  const known = DEFAULT_GROUPS.find((item) => item.id === groupId);
  const group: ProjectTestGroup = {
    id: groupId,
    title: title?.trim() || known?.title || groupId.toUpperCase(),
    description: description?.trim() || known?.description,
    file: groupFile(groupId),
    cases: [],
  };
  writeGroup(root, group);
  return group;
}

/** Удалить группу вместе с файлом — это осознанное действие человека. */
export function removeGroup(root: string, id: string): void {
  const path = groupPath(root, assertGroupId(id));
  rmSync(path, { force: true });
}

/** Свободный идентификатор кейса внутри группы. */
function nextCaseId(group: ProjectTestGroup): string {
  const used = new Set(group.cases.map((item) => item.id));
  let index = group.cases.length + 1;
  let id = `${group.id}-${String(index).padStart(3, '0')}`;
  while (used.has(id)) {
    index += 1;
    id = `${group.id}-${String(index).padStart(3, '0')}`;
  }
  return id;
}

/**
 * Создать или обновить кейс. Правка из панели помечает кейс человеческим:
 * агенту велено такие не удалять, иначе он снесёт то, что человек только что
 * дописал, посчитав это своим устаревшим кейсом.
 */
export function upsertCase(
  root: string,
  groupId: string,
  input: ProjectTestCaseInput,
  now: string,
): ProjectTestCase {
  const title = input.title?.trim();
  if (!title) throw new ProjectTestsError('У теста должно быть название.');

  const group = loadForWrite(root, groupId);
  const steps = (input.steps ?? []).map((step) => step.trim()).filter(Boolean);
  const existing = input.id ? group.cases.find((item) => item.id === input.id) : undefined;
  if (input.id && !existing) throw new ProjectTestsError('Тест не найден.');

  const next: ProjectTestCase = {
    id: existing?.id ?? nextCaseId(group),
    title,
    purpose: input.purpose?.trim() || undefined,
    area: input.area?.trim() || undefined,
    steps,
    expected: input.expected?.trim() || undefined,
    status: input.status ?? existing?.status ?? 'unknown',
    note: input.note?.trim() ?? existing?.note,
    lastRunAt: existing?.lastRunAt,
    source: 'human',
    updatedAt: now,
  };

  const cases = existing
    ? group.cases.map((item) => (item.id === next.id ? next : item))
    : [...group.cases, next];
  writeGroup(root, { ...group, cases });
  return next;
}

/** Удалить кейс. */
export function removeCase(root: string, groupId: string, caseId: string): void {
  const group = loadForWrite(root, groupId);
  writeGroup(root, { ...group, cases: group.cases.filter((item) => item.id !== caseId) });
}

/**
 * Сбросить статусы перед полным перетестом. Без этого «пройдено» осталось бы от
 * прошлого прогона и человек не отличил бы проверенное сейчас от старого.
 */
export function resetStatuses(root: string, groupId: string, caseIds?: string[]): void {
  const group = loadForWrite(root, groupId);
  const touch = (item: ProjectTestCase): ProjectTestCase =>
    caseIds && !caseIds.includes(item.id)
      ? item
      : { ...item, status: 'unknown', note: undefined, lastRunAt: undefined };
  writeGroup(root, { ...group, cases: group.cases.map(touch) });
}
