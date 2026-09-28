import { z } from 'zod';
import type { ProjectTestSchema, ProjectTestsView } from '@agentdeck/contracts';
import type { InjectRoute } from './registry.ts';
import { maskDeep, readRoute } from './action-kit.ts';
import { testsQuery } from './tests-page.ts';

/**
 * Общее у действий блока «Тестирование» (планы, ручные прогоны, эталоны,
 * автотесты, отчёты, обвязка библиотеки): вход проекта, вид раздела — тем же
 * маршрутом, что читает окно, — и ужатие большого ответа под окно модели.
 */

export const projectPath = z.string().trim().min(1).describe('Absolute project directory');

export const idOf = (what: string) => z.string().trim().min(1).describe(what);

/**
 * Блок работает только с проектом из списка панели (копия не в счёт): без
 * проверки модель писала бы планы и запускала команду `automation.json` в папке,
 * которой человек панели не давал. Сама проверка — `registered-folder.ts`.
 */
export { assertRegistered, registeredOnly } from './registered-folder.ts';

/** Вид раздела тестов — источник карточек: план, окружение, шаг, фильтр, прогон. */
export const viewOf = (inject: InjectRoute, path: string): Promise<ProjectTestsView> =>
  readRoute<ProjectTestsView>(inject, `/api/project-tests?${testsQuery(path)}`);

/** Потолок ответа модели в JSON: переходник режет на 20 000 символов. */
const MODEL_JSON_LIMIT = 15_000;

/**
 * Ответ отчёта для модели: секреты маской, длинные списки — первыми `keep`
 * элементами с пометкой, сколько было. Молча обрезанный JSON переходника
 * модель читала бы как полный отчёт, а обрыв посреди строки — как мусор.
 */
export function fitForModel(value: unknown): unknown {
  const masked = maskDeep(value);
  if (JSON.stringify(masked).length <= MODEL_JSON_LIMIT) return masked;
  for (const keep of [50, 20, 10, 5, 2]) {
    const cut: Record<string, number> = {};
    const trimmed = trimArrays(masked, keep, '', cut);
    const out = { ...(trimmed as object), truncatedLists: cut };
    if (JSON.stringify(out).length <= MODEL_JSON_LIMIT) return out;
  }
  const text = JSON.stringify(masked);
  return {
    truncated: true,
    note: 'The report is too large even with short lists; ask for a narrower kind (a group, a case, a run).',
    head: text.slice(0, MODEL_JSON_LIMIT - 400),
  };
}

function trimArrays(
  value: unknown,
  keep: number,
  path: string,
  cut: Record<string, number>,
): unknown {
  if (Array.isArray(value)) {
    if (value.length > keep) cut[path || '(root)'] = value.length;
    return value
      .slice(0, keep)
      .map((item, index) => trimArrays(item, keep, `${path}[${index}]`, cut));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        trimArrays(item, keep, path ? `${path}.${key}` : key, cut),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 2_000) {
    return `${value.slice(0, 2_000)}… (${value.length} chars)`;
  }
  return value;
}

/** Статус прохода словами: сводка карточки на языке окна. */
export const STATUS_WORDS: Record<string, { ru: string; en: string }> = {
  passed: { ru: 'пройден', en: 'passed' },
  failed: { ru: 'провален', en: 'failed' },
  blocked: { ru: 'заблокирован', en: 'blocked' },
  skipped: { ru: 'пропущен', en: 'skipped' },
  unknown: { ru: 'не проверен', en: 'not checked' },
};

/** Фильтр кейсов — у плана (динамический набор) и у сохранённого фильтра. */
export const caseFilter = z
  .object({
    groupIds: z.array(z.string().trim().min(1)).max(100).optional(),
    sections: z.array(z.string().trim().min(1)).max(100).optional(),
    areas: z.array(z.string().trim().min(1)).max(100).optional(),
    tags: z.array(z.string().trim().min(1)).max(100).optional(),
    priorities: z.array(z.enum(['blocker', 'high', 'medium', 'low'])).optional(),
    statuses: z.array(z.enum(['unknown', 'passed', 'failed', 'skipped', 'blocked'])).optional(),
    types: z.array(z.enum(['case', 'checklist'])).optional(),
    automation: z.array(z.enum(['manual', 'toAutomate', 'automated'])).optional(),
    readiness: z.array(z.enum(['draft', 'ready', 'obsolete'])).optional(),
    query: z.string().trim().max(300).optional().describe('Substring of title, purpose and steps'),
    includeArchived: z.boolean().optional(),
    muted: z.boolean().optional().describe('true = only quarantined, false = all but quarantined'),
  })
  .describe('Case filter; every list narrows the set, empty = no narrowing');

/**
 * Схема библиотеки для глаз модели и человека: у своего поля ключ зовётся `id`.
 * Поле с именем `key` маска секретов прячет целиком — модель прочла бы «••••••»
 * вместо «component», вернула бы маску на запись, а карточка не показала бы,
 * какое поле меняется.
 */
export function schemaShown(schema: ProjectTestSchema) {
  return {
    attributes: schema.attributes.map(({ key, ...rest }) => ({ id: key, ...rest })),
    statuses: schema.statuses,
  };
}

/** Поля входа, которые модель назвала: остальное карточка и маршрут берут с диска. */
export function named<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
