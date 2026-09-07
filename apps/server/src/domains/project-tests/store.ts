import { existsSync, rmSync } from 'node:fs';
import type {
  ProjectTestAutomation,
  ProjectTestBulkInput,
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestFilter,
  ProjectTestGroup,
  ProjectTestKind,
  ProjectTestLink,
  ProjectTestParameter,
  ProjectTestPriority,
  ProjectTestReadiness,
  ProjectTestStatus,
  ProjectTestStep,
} from '@agentdeck/contracts';
import { toStatus, toSteps, stepText } from '@agentdeck/contracts/test-format';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  TESTS_DIR,
  assertId,
  listFiles,
  optional,
  readJson,
  stringList,
  testsFile,
  testsPath,
  text,
  writeJson,
} from './files.ts';
import { readSchema } from './library.ts';

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
 * Модель кейса выросла до уровня TMS (предусловия, ожидание на шаг, приоритет,
 * теги, параметры, вложения, привязка к автотесту), но СТАРЫЕ файлы читаются
 * как были: шаг строкой становится шагом-объектом, отсутствующий тип — кейсом.
 * Обратная совместимость здесь не любезность: файлы уже лежат в чужих проектах.
 */

export { TESTS_DIR, ProjectTestsError, ProjectTestsNotFoundError };

/** Суффикс файла группы: по нему группа и опознаётся среди прочего в папке. */
const SUFFIX = '.tests.json';

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

/** Идентификатор группы = имя файла. */
export function assertGroupId(id: string): string {
  return assertId(id, 'Идентификатор группы');
}

/** Путь файла группы от корня проекта — человеку видно, что где лежит. */
export function groupFile(id: string): string {
  return testsFile(`${id}${SUFFIX}`);
}

function groupPath(root: string, id: string): string {
  return testsPath(root, `${assertGroupId(id)}${SUFFIX}`);
}

const KINDS: ProjectTestKind[] = ['case', 'checklist'];
const PRIORITIES: ProjectTestPriority[] = ['blocker', 'high', 'medium', 'low'];
const READINESS: ProjectTestReadiness[] = ['draft', 'ready', 'obsolete'];
const AUTOMATION: ProjectTestAutomation['status'][] = ['manual', 'toAutomate', 'automated'];
const LINK_TYPES: ProjectTestLink['type'][] = ['requirement', 'issue', 'mr', 'doc'];

/** Значение из списка допустимых — или ничего. */
function oneOf<T extends string>(value: unknown, allowed: T[]): T | undefined {
  const word = text(value).trim() as T;
  return allowed.includes(word) ? word : undefined;
}

/** Ссылки кейса: чужой мусор отбрасывается поштучно, а не целиком. */
function parseLinks(raw: unknown): ProjectTestLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const links = raw
    .map((item): ProjectTestLink | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const url = optional(record.url);
      if (!url) return undefined;
      return {
        type: oneOf(record.type, LINK_TYPES) ?? 'doc',
        url,
        title: optional(record.title),
      };
    })
    .filter((item): item is ProjectTestLink => item !== undefined);
  return links.length > 0 ? links : undefined;
}

/** Параметры кейса: имя без `%` и список значений. */
function parseParameters(raw: unknown): ProjectTestParameter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parameters = raw
    .map((item): ProjectTestParameter | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const name = optional(record.name)?.replace(/^%/, '');
      const values = stringList(record.values);
      if (!name || values.length === 0) return undefined;
      return { name, values };
    })
    .filter((item): item is ProjectTestParameter => item !== undefined);
  return parameters.length > 0 ? parameters : undefined;
}

/** Свои поля проекта: только строковые значения, ключи как есть. */
function parseAttributes(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const item = optional(value);
    if (item) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Привязка к коду автотеста. */
function parseAutomation(raw: unknown): ProjectTestAutomation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const status = oneOf(record.status, AUTOMATION);
  const file = optional(record.file);
  const testName = optional(record.testName);
  if (!status && !file && !testName) return undefined;
  return { status: status ?? (file ? 'automated' : 'manual'), file, testName };
}

/** Дефекты, заведённые по провалам. */
function parseDefects(raw: unknown): ProjectTestCase['defects'] {
  if (!Array.isArray(raw)) return undefined;
  const defects = raw
    .map((item) => {
      if (typeof item === 'string') {
        const url = item.trim();
        return url ? { url } : undefined;
      }
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const url = optional(record.url);
      return url
        ? { url, title: optional(record.title), createdAt: optional(record.createdAt) }
        : undefined;
    })
    .filter(
      (item): item is { url: string; title?: string; createdAt?: string } => item !== undefined,
    );
  return defects.length > 0 ? defects : undefined;
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

  const steps = toSteps(item.steps) as ProjectTestStep[];
  const duration = Number(item.duration);

  return {
    id: text(item.id).trim() || `case-${index + 1}`,
    type: oneOf(item.type, KINDS) ?? 'case',
    title,
    purpose: optional(item.purpose),
    area: optional(item.area),
    section: optional(item.section),
    precondition: optional(item.precondition),
    steps,
    expected: optional(item.expected),
    postcondition: optional(item.postcondition),
    oracle: optional(item.oracle),
    priority: oneOf(item.priority, PRIORITIES),
    readiness: oneOf(item.readiness, READINESS),
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    tags: stringList(item.tags).length > 0 ? stringList(item.tags) : undefined,
    links: parseLinks(item.links),
    attributes: parseAttributes(item.attributes),
    parameters: parseParameters(item.parameters),
    attachments: stringList(item.attachments).length > 0 ? stringList(item.attachments) : undefined,
    automation: parseAutomation(item.automation),
    codePaths: stringList(item.codePaths).length > 0 ? stringList(item.codePaths) : undefined,
    defects: parseDefects(item.defects),
    status: toStatus(item.status) as ProjectTestStatus,
    statusId: optional(item.statusId),
    note: optional(item.note),
    lastRunAt: optional(item.lastRunAt),
    lastRunId: optional(item.lastRunId),
    source: text(item.source) === 'human' ? 'human' : 'agent',
    updatedAt: optional(item.updatedAt),
    archived: item.archived === true ? true : undefined,
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
export function readGroup(root: string, id: string): ProjectTestGroup {
  const file = groupFile(id);
  const base: ProjectTestGroup = { id, title: id.toUpperCase(), file, cases: [] };

  const { data, error } = readJson(root, `${id}${SUFFIX}`);
  if (error) return { ...base, error };
  if (data === undefined) return { ...base, error: 'Файл не читается: файла нет.' };

  const group = data as GroupFile;
  const cases = Array.isArray(group?.cases)
    ? withUniqueIds(
        group.cases
          .map((item, index) => parseCase(item, index))
          .filter((item): item is ProjectTestCase => item !== undefined),
      )
    : [];

  return {
    id,
    title: text(group?.title).trim() || base.title,
    description: optional(group?.description),
    file,
    cases,
  };
}

/** Идентификаторы групп, найденные в папке, в алфавитном порядке. */
function groupIds(root: string): string[] {
  return listFiles(root, '', SUFFIX);
}

/** Все группы проекта. Пустой список — тестов в проекте ещё нет. */
export function readGroups(root: string): ProjectTestGroup[] {
  return groupIds(root).map((id) => readGroup(root, id));
}

/** Запись группы целиком. Сломанную группу писать нельзя — иначе затрём файл. */
export function writeGroup(root: string, group: ProjectTestGroup): void {
  if (group.error) throw new ProjectTestsError(group.error);
  writeJson(root, `${assertGroupId(group.id)}${SUFFIX}`, {
    version: 1,
    title: group.title,
    description: group.description,
    cases: group.cases,
  });
}

/** Группа, готовая к правке: сломанную возвращаем ошибкой, а не пустышкой. */
export function loadForWrite(root: string, id: string): ProjectTestGroup {
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

/**
 * Переименовать группу или сменить её описание. Идентификатор не трогаем: он
 * же имя файла, и его смена оторвала бы группу от истории прогонов и от
 * ссылок в планах.
 */
export function updateGroup(
  root: string,
  id: string,
  title?: string,
  description?: string,
): ProjectTestGroup {
  const group = loadForWrite(root, assertGroupId(id));
  if (!existsSync(groupPath(root, group.id))) {
    throw new ProjectTestsNotFoundError(`Группы «${id}» в проекте нет.`);
  }
  const next: ProjectTestGroup = {
    ...group,
    title: title?.trim() || group.title,
    description: description?.trim() || group.description,
  };
  writeGroup(root, next);
  return next;
}

/** Удалить группу вместе с файлом — это осознанное действие человека. */
export function removeGroup(root: string, id: string): void {
  const path = groupPath(root, assertGroupId(id));
  if (!existsSync(path)) throw new ProjectTestsNotFoundError(`Группы «${id}» в проекте нет.`);
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

/** Шаги из формы: строки и объекты приходят вперемешку. */
function inputSteps(steps: ProjectTestCaseInput['steps']): ProjectTestStep[] {
  return toSteps(steps ?? []) as ProjectTestStep[];
}

/**
 * Проверка своих полей проекта при правке ИЗ ПАНЕЛИ.
 *
 * Ровно то, ради чего свои поля заводят: поле, объявленное обязательным,
 * должно быть заполнено, а список — содержать одно из своих значений. Иначе
 * «обязательное поле» остаётся подписью в форме, и в наборе снова заводятся
 * кейсы без компонента и без версии.
 *
 * Файлы, написанные агентом руками, сюда не попадают: их читают щадяще, и
 * ронять из-за незаполненного поля весь раздел было бы хуже, чем пустое поле.
 */
function assertAttributes(root: string, attributes?: Record<string, string>): void {
  const schema = readSchema(root);
  if (schema.attributes.length === 0) return;
  const values = attributes ?? {};
  for (const field of schema.attributes) {
    const value = values[field.key]?.trim();
    if (field.required && !value) {
      throw new ProjectTestsError(`Поле «${field.title}» обязательно.`);
    }
    if (
      value &&
      field.type === 'select' &&
      field.options?.length &&
      !field.options.includes(value)
    ) {
      throw new ProjectTestsError(
        `Поле «${field.title}»: допустимые значения — ${field.options.join(', ')}.`,
      );
    }
    if (value && field.type === 'number' && !Number.isFinite(Number(value))) {
      throw new ProjectTestsError(`Поле «${field.title}» — это число.`);
    }
  }
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
  const existing = input.id ? group.cases.find((item) => item.id === input.id) : undefined;
  if (input.id && !existing) throw new ProjectTestsError('Тест не найден.');
  assertAttributes(root, input.attributes);

  const next: ProjectTestCase = {
    id: existing?.id ?? nextCaseId(group),
    type: input.type ?? existing?.type ?? 'case',
    title,
    purpose: optional(input.purpose),
    area: optional(input.area),
    section: optional(input.section),
    precondition: optional(input.precondition),
    steps: inputSteps(input.steps),
    expected: optional(input.expected),
    postcondition: optional(input.postcondition),
    oracle: optional(input.oracle),
    priority: input.priority ?? existing?.priority,
    readiness: input.readiness ?? existing?.readiness,
    duration: input.duration ?? existing?.duration,
    tags: input.tags?.length ? input.tags : undefined,
    links: input.links?.length ? input.links : undefined,
    attributes:
      input.attributes && Object.keys(input.attributes).length ? input.attributes : undefined,
    parameters: input.parameters?.length ? input.parameters : undefined,
    attachments: input.attachments?.length ? input.attachments : existing?.attachments,
    automation: input.automation ?? existing?.automation,
    codePaths: input.codePaths?.length ? input.codePaths : existing?.codePaths,
    defects: existing?.defects,
    status: input.status ?? existing?.status ?? 'unknown',
    statusId: input.statusId ?? existing?.statusId,
    note: optional(input.note) ?? existing?.note,
    lastRunAt: existing?.lastRunAt,
    lastRunId: existing?.lastRunId,
    source: 'human',
    updatedAt: now,
    archived: input.archived ?? existing?.archived,
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
      : { ...item, status: 'unknown', note: undefined, lastRunAt: undefined, lastRunId: undefined };
  writeGroup(root, { ...group, cases: group.cases.map(touch) });
}

/** Результат прохода, который нужно записать в кейс. */
export interface CaseResultPatch {
  groupId: string;
  caseId: string;
  status: ProjectTestStatus;
  statusId?: string;
  note?: string;
  runId?: string;
  at?: string;
  defect?: { url: string; title?: string; createdAt?: string };
}

/**
 * Проставить результаты в файлы кейсов пачкой.
 *
 * Пачкой — потому что импорт из CI приносит сотню результатов сразу, и сто
 * отдельных перезаписей одного файла означали бы сто шансов встретиться с
 * агентом на той же секунде.
 */
export function applyResults(root: string, patches: CaseResultPatch[], now: string): number {
  const byGroup = new Map<string, CaseResultPatch[]>();
  for (const patch of patches) {
    const list = byGroup.get(patch.groupId) ?? [];
    list.push(patch);
    byGroup.set(patch.groupId, list);
  }

  let applied = 0;
  for (const [groupId, list] of byGroup) {
    const group = loadForWrite(root, groupId);
    const map = new Map(list.map((patch) => [patch.caseId, patch]));
    const cases = group.cases.map((item) => {
      const patch = map.get(item.id);
      if (!patch) return item;
      applied += 1;
      const defects = patch.defect
        ? [...(item.defects ?? []), patch.defect].filter(
            (defect, index, all) => all.findIndex((other) => other.url === defect.url) === index,
          )
        : item.defects;
      return {
        ...item,
        status: patch.status,
        statusId: patch.statusId ?? item.statusId,
        note: patch.note ?? item.note,
        lastRunAt: patch.at ?? now,
        lastRunId: patch.runId ?? item.lastRunId,
        defects,
      };
    });
    writeGroup(root, { ...group, cases });
  }
  return applied;
}

/** Совпал ли кейс с фильтром. Пустой фильтр пропускает всё, кроме архива. */
export function matchesFilter(
  item: ProjectTestCase,
  groupId: string,
  filter: ProjectTestFilter,
): boolean {
  if (item.archived && !filter.includeArchived) return false;
  if (filter.groupIds?.length && !filter.groupIds.includes(groupId)) return false;
  if (filter.types?.length && !filter.types.includes(item.type)) return false;
  if (filter.statuses?.length && !filter.statuses.includes(item.status)) return false;
  if (filter.priorities?.length && !filter.priorities.includes(item.priority ?? 'medium')) {
    return false;
  }
  if (filter.readiness?.length && !filter.readiness.includes(item.readiness ?? 'ready')) {
    return false;
  }
  if (
    filter.automation?.length &&
    !filter.automation.includes(item.automation?.status ?? 'manual')
  ) {
    return false;
  }
  if (filter.areas?.length && !filter.areas.includes(item.area ?? '')) return false;
  if (filter.sections?.length) {
    const section = item.section ?? '';
    if (!filter.sections.some((prefix) => section === prefix || section.startsWith(`${prefix}/`))) {
      return false;
    }
  }
  if (filter.tags?.length && !filter.tags.some((tag) => item.tags?.includes(tag))) return false;
  if (filter.query) {
    const haystack = [
      item.title,
      item.purpose ?? '',
      item.area ?? '',
      item.section ?? '',
      ...item.steps.map((step) => stepText(step)),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filter.query.toLowerCase())) return false;
  }
  return true;
}

/** Кейсы всех групп, прошедшие фильтр, вместе с их группой. */
export function selectCases(
  groups: ProjectTestGroup[],
  filter: ProjectTestFilter = {},
): { groupId: string; testCase: ProjectTestCase }[] {
  const selected: { groupId: string; testCase: ProjectTestCase }[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (matchesFilter(testCase, group.id, filter)) selected.push({ groupId: group.id, testCase });
    }
  }
  return selected;
}

/** Массовое действие над отмеченными кейсами. Возвращает, скольких коснулось. */
export function bulkCases(root: string, input: ProjectTestBulkInput, now: string): number {
  const group = loadForWrite(root, input.groupId);
  const ids = new Set(input.caseIds);
  if (ids.size === 0) throw new ProjectTestsError('Не выбрано ни одного теста.');
  const value = input.value?.trim();

  if (input.action === 'delete') {
    const cases = group.cases.filter((item) => !ids.has(item.id));
    const removed = group.cases.length - cases.length;
    writeGroup(root, { ...group, cases });
    return removed;
  }

  if (input.action === 'move') {
    if (!value) throw new ProjectTestsError('Не указана группа-приёмник.');
    const target = loadForWrite(root, value);
    const moving = group.cases.filter((item) => ids.has(item.id));
    if (moving.length === 0) return 0;
    const taken = new Set(target.cases.map((item) => item.id));
    const moved = moving.map((item) => {
      let id = item.id;
      let attempt = 2;
      while (taken.has(id)) id = `${item.id}-${attempt++}`;
      taken.add(id);
      return { ...item, id, updatedAt: now };
    });
    writeGroup(root, { ...target, cases: [...target.cases, ...moved] });
    writeGroup(root, { ...group, cases: group.cases.filter((item) => !ids.has(item.id)) });
    return moved.length;
  }

  if (input.action === 'duplicate') {
    const copies: ProjectTestCase[] = [];
    const taken = new Set(group.cases.map((item) => item.id));
    for (const item of group.cases) {
      if (!ids.has(item.id)) continue;
      let id = `${item.id}-copy`;
      let attempt = 2;
      while (taken.has(id)) id = `${item.id}-copy-${attempt++}`;
      taken.add(id);
      copies.push({
        ...item,
        id,
        title: `${item.title} (копия)`,
        status: 'unknown',
        note: undefined,
        lastRunAt: undefined,
        lastRunId: undefined,
        source: 'human',
        updatedAt: now,
      });
    }
    writeGroup(root, { ...group, cases: [...group.cases, ...copies] });
    return copies.length;
  }

  let touched = 0;
  const cases = group.cases.map((item) => {
    if (!ids.has(item.id)) return item;
    touched += 1;
    const next: ProjectTestCase = { ...item, updatedAt: now };
    if (input.action === 'tag' && value) {
      next.tags = [...new Set([...(item.tags ?? []), value])];
    }
    if (input.action === 'untag' && value) {
      const rest = (item.tags ?? []).filter((tag) => tag !== value);
      next.tags = rest.length > 0 ? rest : undefined;
    }
    if (input.action === 'priority') next.priority = oneOf(value, PRIORITIES);
    if (input.action === 'readiness') next.readiness = oneOf(value, READINESS);
    if (input.action === 'automation') {
      const status = oneOf(value, AUTOMATION) ?? 'manual';
      next.automation = { ...(item.automation ?? {}), status };
    }
    if (input.action === 'section') next.section = value || undefined;
    if (input.action === 'archive') next.archived = true;
    if (input.action === 'restore') next.archived = undefined;
    return next;
  });
  writeGroup(root, { ...group, cases });
  return touched;
}
