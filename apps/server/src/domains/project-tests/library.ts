import type {
  ProjectTestAttributeDef,
  ProjectTestEnvironment,
  ProjectTestFilter,
  ProjectTestSchema,
  ProjectTestSharedStep,
  ProjectTestStatusDef,
  ProjectTestStep,
  ProjectTestView,
} from '@agentdeck/contracts';
import { toSteps } from '@agentdeck/contracts/test-format';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  assertId,
  optional,
  readJson,
  stringList,
  text,
  writeJson,
} from './files.ts';

/**
 * Обвязка библиотеки тестов: общие шаги, окружения, свои поля и статусы,
 * сохранённые фильтры.
 *
 * Всё это — маленькие файлы рядом с группами кейсов, и правила у них общие:
 * читаем щадяще (сломанный файл = пустой список, а не падение раздела), пишем
 * целиком и атомарно, идентификаторы такие же узкие, как у групп, — они
 * попадают в кейсы и в имена файлов прогонов.
 *
 * Своей базы здесь по-прежнему нет: файл лежит в проверяемом проекте и едет
 * вместе с ним, а версии ему даёт git.
 */

const SHARED_FILE = '_shared.steps.json';
const ENVIRONMENTS_FILE = 'environments.json';
const SCHEMA_FILE = 'schema.json';
const VIEWS_FILE = 'views.json';

/** Значение из списка допустимых — или запасное. */
function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  const word = text(value).trim() as T;
  return allowed.includes(word) ? word : fallback;
}

// ─── Общие шаги ────────────────────────────────────────────────────────────

/** Общие шаги проекта. Сломанный файл — пустой список, а не красный раздел. */
export function readSharedSteps(root: string): ProjectTestSharedStep[] {
  const { data } = readJson(root, SHARED_FILE);
  const raw = (data as { steps?: unknown })?.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ProjectTestSharedStep | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const id = optional(record.id);
      const title = optional(record.title);
      if (!id || !title) return undefined;
      return {
        id,
        title,
        description: optional(record.description),
        steps: toSteps(record.steps) as ProjectTestStep[],
        updatedAt: optional(record.updatedAt),
      };
    })
    .filter((item): item is ProjectTestSharedStep => item !== undefined);
}

/** Создать или обновить общий шаг. */
export function saveSharedStep(
  root: string,
  // Шаги принимаются и строками: из панели они приходят объектами, но тот же
  // файл правят руками, и там строка — обычная форма записи.
  input: Partial<Omit<ProjectTestSharedStep, 'steps'>> & {
    title: string;
    steps?: (ProjectTestStep | string)[];
  },
  now: string,
): ProjectTestSharedStep {
  const title = input.title?.trim();
  if (!title) throw new ProjectTestsError('У общего шага должно быть название.');
  const steps = toSteps(input.steps ?? []) as ProjectTestStep[];
  if (steps.length === 0) throw new ProjectTestsError('В общем шаге нет ни одного шага.');

  const all = readSharedSteps(root);
  const id = input.id
    ? assertId(input.id, 'Идентификатор общего шага')
    : nextId(all, title, 'step');
  const next: ProjectTestSharedStep = {
    id,
    title,
    description: optional(input.description),
    steps,
    updatedAt: now,
  };
  const exists = all.some((item) => item.id === id);
  const steps_ = exists ? all.map((item) => (item.id === id ? next : item)) : [...all, next];
  writeJson(root, SHARED_FILE, { version: 1, steps: steps_ });
  return next;
}

/**
 * Свободный идентификатор из названия. Латиницы в названии может не быть
 * вовсе («Прод-стенд»), поэтому пустая основа заменяется словом, а не пустой
 * строкой: пустой id не пройдёт `assertId` и файл окажется безымянным.
 */
function nextId(all: { id: string }[], title: string, fallback = 'item'): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || fallback;
  const used = new Set(all.map((item) => item.id));
  if (!used.has(base)) return base;
  let attempt = 2;
  while (used.has(`${base}-${attempt}`)) attempt += 1;
  return `${base}-${attempt}`;
}

/** Удалить общий шаг. Ссылки на него в кейсах остаются подписями. */
export function removeSharedStep(root: string, id: string): void {
  const all = readSharedSteps(root);
  if (!all.some((item) => item.id === id)) {
    throw new ProjectTestsNotFoundError(`Общего шага «${id}» в проекте нет.`);
  }
  writeJson(root, SHARED_FILE, { version: 1, steps: all.filter((item) => item.id !== id) });
}

// ─── Окружения ─────────────────────────────────────────────────────────────

/** Окружения-конфигурации проекта. */
export function readEnvironments(root: string): ProjectTestEnvironment[] {
  const { data } = readJson(root, ENVIRONMENTS_FILE);
  const raw = (data as { environments?: unknown })?.environments;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ProjectTestEnvironment | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const id = optional(record.id);
      const title = optional(record.title);
      if (!id || !title) return undefined;
      return {
        id,
        title,
        baseUrl: optional(record.baseUrl),
        browser: optional(record.browser),
        os: optional(record.os),
        start: optional(record.start),
        notes: optional(record.notes),
        isDefault: record.isDefault === true ? true : undefined,
        archived: record.archived === true ? true : undefined,
      };
    })
    .filter((item): item is ProjectTestEnvironment => item !== undefined);
}

/** Создать или обновить окружение; `isDefault` всегда ровно одно. */
export function saveEnvironment(
  root: string,
  input: Partial<ProjectTestEnvironment> & { title: string },
): ProjectTestEnvironment {
  const title = input.title?.trim();
  if (!title) throw new ProjectTestsError('У окружения должно быть название.');
  const all = readEnvironments(root);
  const id = input.id ? assertId(input.id, 'Идентификатор окружения') : nextId(all, title, 'env');

  const next: ProjectTestEnvironment = {
    id,
    title,
    baseUrl: optional(input.baseUrl),
    browser: optional(input.browser),
    os: optional(input.os),
    start: optional(input.start),
    notes: optional(input.notes),
    isDefault: input.isDefault === true ? true : undefined,
    archived: input.archived === true ? true : undefined,
  };

  const exists = all.some((item) => item.id === id);
  let environments = exists ? all.map((item) => (item.id === id ? next : item)) : [...all, next];
  if (next.isDefault) {
    environments = environments.map((item) =>
      item.id === id ? item : { ...item, isDefault: undefined },
    );
  }
  writeJson(root, ENVIRONMENTS_FILE, { version: 1, environments });
  return next;
}

/** Удалить окружение. Прогоны, сделанные на нём, остаются в истории. */
export function removeEnvironment(root: string, id: string): void {
  const all = readEnvironments(root);
  if (!all.some((item) => item.id === id)) {
    throw new ProjectTestsNotFoundError(`Окружения «${id}» в проекте нет.`);
  }
  writeJson(root, ENVIRONMENTS_FILE, {
    version: 1,
    environments: all.filter((item) => item.id !== id),
  });
}

/** Окружение по умолчанию: помеченное, иначе первое живое. */
export function defaultEnvironment(
  environments: ProjectTestEnvironment[],
): ProjectTestEnvironment | undefined {
  const alive = environments.filter((item) => !item.archived);
  return alive.find((item) => item.isDefault) ?? alive[0];
}

// ─── Свои поля и статусы ───────────────────────────────────────────────────

const ATTRIBUTE_TYPES: ProjectTestAttributeDef['type'][] = ['text', 'select', 'number'];
const STATUS_GROUPS: ProjectTestStatusDef['group'][] = [
  'unknown',
  'running',
  'passed',
  'failed',
  'skipped',
  'blocked',
];

/** Схема проекта: свои поля и свои статусы. Нет файла — пустая схема. */
export function readSchema(root: string): ProjectTestSchema {
  const { data } = readJson(root, SCHEMA_FILE);
  const record = (data ?? {}) as { attributes?: unknown; statuses?: unknown };

  const attributes = Array.isArray(record.attributes)
    ? record.attributes
        .map((item): ProjectTestAttributeDef | undefined => {
          if (!item || typeof item !== 'object') return undefined;
          const field = item as Record<string, unknown>;
          const key = optional(field.key);
          if (!key) return undefined;
          return {
            key,
            title: optional(field.title) ?? key,
            type: pick(field.type, ATTRIBUTE_TYPES, 'text'),
            options: stringList(field.options).length > 0 ? stringList(field.options) : undefined,
            required: field.required === true ? true : undefined,
          };
        })
        .filter((item): item is ProjectTestAttributeDef => item !== undefined)
    : [];

  const statuses = Array.isArray(record.statuses)
    ? record.statuses
        .map((item): ProjectTestStatusDef | undefined => {
          if (!item || typeof item !== 'object') return undefined;
          const field = item as Record<string, unknown>;
          const id = optional(field.id);
          if (!id) return undefined;
          return {
            id,
            title: optional(field.title) ?? id,
            group: pick(field.group, STATUS_GROUPS, 'unknown'),
          };
        })
        .filter((item): item is ProjectTestStatusDef => item !== undefined)
    : [];

  return { attributes, statuses };
}

/** Записать схему целиком — форма её и правит целиком. */
export function saveSchema(root: string, schema: ProjectTestSchema): ProjectTestSchema {
  const cleaned: ProjectTestSchema = {
    attributes: (schema.attributes ?? []).filter((item) => item.key?.trim()),
    statuses: (schema.statuses ?? []).filter((item) => item.id?.trim()),
  };
  writeJson(root, SCHEMA_FILE, { version: 1, ...cleaned });
  return cleaned;
}

// ─── Сохранённые фильтры ───────────────────────────────────────────────────

/** Сохранённые фильтры: они же динамические наборы тест-планов. */
export function readViews(root: string): ProjectTestView[] {
  const { data } = readJson(root, VIEWS_FILE);
  const raw = (data as { views?: unknown })?.views;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ProjectTestView | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const id = optional(record.id);
      const title = optional(record.title);
      if (!id || !title) return undefined;
      return {
        id,
        title,
        filter: (record.filter ?? {}) as ProjectTestFilter,
        createdAt: optional(record.createdAt),
      };
    })
    .filter((item): item is ProjectTestView => item !== undefined);
}

/** Создать или обновить сохранённый фильтр. */
export function saveView(
  root: string,
  input: Partial<ProjectTestView> & { title: string },
  now: string,
): ProjectTestView {
  const title = input.title?.trim();
  if (!title) throw new ProjectTestsError('У фильтра должно быть название.');
  const all = readViews(root);
  const id = input.id ? assertId(input.id, 'Идентификатор фильтра') : nextId(all, title, 'view');
  const next: ProjectTestView = {
    id,
    title,
    filter: input.filter ?? {},
    createdAt: all.find((item) => item.id === id)?.createdAt ?? now,
  };
  const views = all.some((item) => item.id === id)
    ? all.map((item) => (item.id === id ? next : item))
    : [...all, next];
  writeJson(root, VIEWS_FILE, { version: 1, views });
  return next;
}

/** Удалить сохранённый фильтр. */
export function removeView(root: string, id: string): void {
  const all = readViews(root);
  if (!all.some((item) => item.id === id)) {
    throw new ProjectTestsNotFoundError(`Фильтра «${id}» в проекте нет.`);
  }
  writeJson(root, VIEWS_FILE, { version: 1, views: all.filter((item) => item.id !== id) });
}
