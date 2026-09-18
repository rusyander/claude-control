import type {
  ProjectTestAttributeDef,
  ProjectTestEnvironment,
  ProjectTestFilter,
  ProjectTestSchema,
  ProjectTestSecretRef,
  ProjectTestSharedStep,
  ProjectTestStatusDef,
  ProjectTestStep,
  ProjectTestView,
} from '@agentdeck/contracts';
import { toSteps } from '@agentdeck/contracts/test-format';
import { slugify } from '../../lib/slug.ts';
import { assertSecretName } from './env-secrets.ts';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  assertId,
  optional,
  readJson,
  stringList,
  testsFile,
  text,
  writeJson,
} from './files.ts';
import { coded } from '../../lib/server-text.ts';

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

/** Человеческое имя файла — им же названа причина на экране. */
const FILE_TITLES: Record<string, string> = {
  [SHARED_FILE]: 'общих шагов',
  [ENVIRONMENTS_FILE]: 'окружений',
  [SCHEMA_FILE]: 'своих полей',
  [VIEWS_FILE]: 'сохранённых видов',
};

/**
 * Что из обвязки не прочиталось. Чтение остаётся щадящим — этот список нужен
 * тем, кто показывает файлы человеку, а не тем, кто просто берёт из них данные.
 */
export function readLibraryIssues(root: string): { file: string; error: string }[] {
  const issues: { file: string; error: string }[] = [];
  for (const file of [SHARED_FILE, ENVIRONMENTS_FILE, SCHEMA_FILE, VIEWS_FILE]) {
    const { error } = readJson(root, file);
    if (error) issues.push({ file: testsFile(file), error });
  }
  return issues;
}

/**
 * Запись целиком в файл, который не прочитался, — это стирание чужой работы:
 * список вышел пустым не потому, что в нём ничего нет, а потому что его не
 * разобрали. Поэтому перед КАЖДОЙ записью файл проверяется, и сломанный
 * останавливает правку с названной причиной.
 */
function assertWritable(root: string, file: string): void {
  const { error } = readJson(root, file);
  if (!error) return;
  throw coded(
    new ProjectTestsError(
      `Файл ${FILE_TITLES[file] ?? file} не разобрался, и переписывать его целиком нельзя: ` +
        `${error} Почините ${testsFile(file)} — правка ждёт.`,
    ),
    'library-file-broken',
    { file: testsFile(file), reason: error },
  );
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
  if (!title)
    throw coded(
      new ProjectTestsError('У общего шага должно быть название.'),
      'shared-step-title-required',
    );
  const steps = toSteps(input.steps ?? []) as ProjectTestStep[];
  if (steps.length === 0)
    throw coded(new ProjectTestsError('В общем шаге нет ни одного шага.'), 'shared-step-empty');

  assertWritable(root, SHARED_FILE);
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
 * Свободный идентификатор из названия. Кириллица транслитерируется общим
 * `slugify` («Прод-стенд» → `prod-stend`): отбрасывание оставляло от русского
 * названия пустую строку или одни цифры, а id тут становится именем файла.
 * Пустая основа всё равно заменяется словом — пустой id не пройдёт `assertId`.
 */
function nextId(all: { id: string }[], title: string, fallback = 'item'): string {
  const base = slugify(title, 30) || fallback;
  const used = new Set(all.map((item) => item.id));
  if (!used.has(base)) return base;
  let attempt = 2;
  while (used.has(`${base}-${attempt}`)) attempt += 1;
  return `${base}-${attempt}`;
}

/** Удалить общий шаг. Ссылки на него в кейсах остаются подписями. */
export function removeSharedStep(root: string, id: string): void {
  assertWritable(root, SHARED_FILE);
  const all = readSharedSteps(root);
  if (!all.some((item) => item.id === id)) {
    throw coded(
      new ProjectTestsNotFoundError(`Общего шага «${id}» в проекте нет.`),
      'shared-step-id-not-found',
      { id },
    );
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
        secrets: readSecretRefs(record.secrets),
      };
    })
    .filter((item): item is ProjectTestEnvironment => item !== undefined);
}

/**
 * Объявления доступов из файла проекта: ТОЛЬКО имена переменных.
 *
 * Чтение щадящее, как у всей библиотеки: негодное имя пропускается молча, и
 * одна опечатка в правленом руками файле не гасит всё окружение. Значение,
 * дописанное в файл руками (`"value": "..."`), сюда не попадает вовсе — у
 * секрета в проекте нет места, куда его положить.
 */
function readSecretRefs(raw: unknown): ProjectTestSecretRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw
    .map((item): ProjectTestSecretRef | undefined => {
      const name = optional(typeof item === 'string' ? item : (item as { name?: unknown })?.name);
      if (!name || !isSecretName(name)) return undefined;
      const title =
        typeof item === 'object' && item
          ? optional((item as { title?: unknown }).title)
          : undefined;
      return { name, title };
    })
    .filter((item): item is ProjectTestSecretRef => item !== undefined);
  return refs.length > 0 ? refs : undefined;
}

/** Имя годится — без падения: чтение файла ошибок не поднимает. */
function isSecretName(name: string): boolean {
  try {
    assertSecretName(name);
    return true;
  } catch {
    return false;
  }
}

/** Создать или обновить окружение; `isDefault` всегда ровно одно. */
export function saveEnvironment(
  root: string,
  input: Partial<ProjectTestEnvironment> & { title: string },
): ProjectTestEnvironment {
  const title = input.title?.trim();
  if (!title)
    throw coded(
      new ProjectTestsError('У окружения должно быть название.'),
      'environment-title-required',
    );
  assertWritable(root, ENVIRONMENTS_FILE);
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
    // Имена доступов проверяются с отказом, а не молча: их прислала форма, и
    // человек должен узнать про негодное имя сразу, а не по пустому окружению.
    secrets: input.secrets?.length
      ? input.secrets.map((ref) => ({
          name: assertSecretName(ref.name),
          title: optional(ref.title),
        }))
      : undefined,
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
  assertWritable(root, ENVIRONMENTS_FILE);
  const all = readEnvironments(root);
  if (!all.some((item) => item.id === id)) {
    throw coded(
      new ProjectTestsNotFoundError(`Окружения «${id}» в проекте нет.`),
      'environment-id-not-found',
      { id },
    );
  }
  writeJson(root, ENVIRONMENTS_FILE, {
    version: 1,
    environments: all.filter((item) => item.id !== id),
  });
}

/** Окружение по имени — или отказ: оно называет то, чего в проекте нет. */
function requireEnvironment(root: string, id: string): ProjectTestEnvironment {
  const found = readEnvironments(root).find((item) => item.id === id);
  if (!found)
    throw coded(
      new ProjectTestsNotFoundError(`Окружения «${id}» в проекте нет.`),
      'environment-id-not-found',
      { id },
    );
  return found;
}

/**
 * Объявить доступ окружения: в файл проекта уезжает ИМЯ переменной и подпись.
 * Значение здесь не участвует вовсе — его хранит панель (`env-secrets.ts`).
 */
export function declareSecret(
  root: string,
  environmentId: string,
  ref: ProjectTestSecretRef,
): ProjectTestEnvironment {
  const environment = requireEnvironment(root, environmentId);
  const name = assertSecretName(ref.name);
  const rest = (environment.secrets ?? []).filter((item) => item.name !== name);
  return saveEnvironment(root, {
    ...environment,
    secrets: [...rest, { name, title: optional(ref.title) }],
  });
}

/** Убрать объявление доступа. Значение стирает маршрут — оно лежит не здесь. */
export function undeclareSecret(
  root: string,
  environmentId: string,
  name: string,
): ProjectTestEnvironment {
  const environment = requireEnvironment(root, environmentId);
  return saveEnvironment(root, {
    ...environment,
    secrets: (environment.secrets ?? []).filter((item) => item.name !== name),
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

/**
 * Записать схему целиком — форма её и правит целиком.
 *
 * Проверки строгие, в отличие от чтения: ключ поля уезжает в КАЖДЫЙ кейс
 * (`attributes[key]`), и поле, заведённое с ключом «Своё поле», осталось бы в
 * файлах навсегда. Повтор ключа так же запрещён: две колонки с одним ключом —
 * это одна колонка, второе описание которой никто больше не увидит.
 */
export function saveSchema(root: string, schema: ProjectTestSchema): ProjectTestSchema {
  const attributes = (schema.attributes ?? []).filter((item) => item.key?.trim());
  const seen = new Set<string>();
  const cleaned: ProjectTestSchema = {
    attributes: attributes.map((item) => {
      const key = assertId(item.key.trim(), 'Ключ своего поля');
      if (seen.has(key))
        throw coded(
          new ProjectTestsError(`Поле с ключом «${key}» уже есть.`),
          'attribute-key-duplicate',
          { key },
        );
      seen.add(key);
      const type = pick(item.type, ATTRIBUTE_TYPES, 'text');
      const options = stringList(item.options);
      if (type === 'select' && options.length === 0) {
        throw coded(
          new ProjectTestsError(`У поля «${item.title || key}» не задано ни одного варианта.`),
          'attribute-no-options',
          { field: item.title || key },
        );
      }
      return {
        key,
        title: item.title?.trim() || key,
        type,
        options: type === 'select' ? options : undefined,
        required: item.required === true ? true : undefined,
      };
    }),
    statuses: (schema.statuses ?? []).filter((item) => item.id?.trim()),
  };
  assertWritable(root, SCHEMA_FILE);
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
  if (!title)
    throw coded(new ProjectTestsError('У фильтра должно быть название.'), 'view-title-required');
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
  assertWritable(root, VIEWS_FILE);
  writeJson(root, VIEWS_FILE, { version: 1, views });
  return next;
}

/** Удалить сохранённый фильтр. */
export function removeView(root: string, id: string): void {
  const all = readViews(root);
  if (!all.some((item) => item.id === id)) {
    throw coded(new ProjectTestsNotFoundError(`Фильтра «${id}» в проекте нет.`), 'view-not-found', {
      id,
    });
  }
  assertWritable(root, VIEWS_FILE);
  writeJson(root, VIEWS_FILE, { version: 1, views: all.filter((item) => item.id !== id) });
}
