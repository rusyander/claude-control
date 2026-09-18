import { existsSync, rmSync } from 'node:fs';
import type {
  ProjectTestCase,
  ProjectTestEnvironment,
  ProjectTestFilter,
  ProjectTestGroup,
  ProjectTestPlan,
  ProjectTestPoint,
  ProjectTestView,
} from '@agentdeck/contracts';
import { combineParams, pointId } from '@agentdeck/contracts/test-format';
import { slugify } from '../../lib/slug.ts';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  assertId,
  listFiles,
  optional,
  readJson,
  stringList,
  testsPath,
  writeJson,
} from './files.ts';
import { selectCases } from './store.ts';
import { defaultEnvironment } from './library.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Тест-планы и разворачивание их в тест-поинты.
 *
 * План отвечает на «что проверяем в этот раз»: список кейсов или ФИЛЬТР (тогда
 * набор динамический и обновляется сам), окружения и сроки. Разворачивать план
 * в поинты заранее и хранить их незачем — кейс мог измениться между
 * планированием и прогоном, и сохранённый поинт врал бы про шаги.
 *
 * Тест-поинт = кейс × окружение × набор значений параметров. Полный перебор
 * значений растёт произведением, поэтому от трёх параметров и больше берётся
 * попарный набор (`pairwise`): каждая пара значений встречается хотя бы раз, а
 * проходов в разы меньше.
 */

const SUFFIX = '.plan.json';
const PLANS_DIR = 'plans';

/** Планы проекта, по алфавиту идентификаторов. */
export function readPlans(root: string): ProjectTestPlan[] {
  return listFiles(root, PLANS_DIR, SUFFIX)
    .map((id) => readPlan(root, id))
    .filter((plan): plan is ProjectTestPlan => plan !== undefined);
}

/** Один план. Сломанный файл — не план, а пропуск: раздел от этого не краснеет. */
export function readPlan(root: string, id: string): ProjectTestPlan | undefined {
  const { data } = readJson(root, `${PLANS_DIR}/${assertId(id, 'Идентификатор плана')}${SUFFIX}`);
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const title = optional(record.title);
  if (!title) return undefined;
  return {
    id,
    title,
    product: optional(record.product),
    version: optional(record.version),
    description: optional(record.description),
    from: optional(record.from),
    to: optional(record.to),
    tags: stringList(record.tags).length > 0 ? stringList(record.tags) : undefined,
    caseIds: stringList(record.caseIds).length > 0 ? stringList(record.caseIds) : undefined,
    filter: (record.filter ?? undefined) as ProjectTestFilter | undefined,
    environmentIds:
      stringList(record.environmentIds).length > 0 ? stringList(record.environmentIds) : undefined,
    createdAt: optional(record.createdAt),
    updatedAt: optional(record.updatedAt),
    locked: record.locked === true ? true : undefined,
    archived: record.archived === true ? true : undefined,
  };
}

/**
 * Свободный идентификатор плана из названия.
 *
 * Кириллица транслитерируется общим `slugify`, а не отбрасывается: у русского
 * названия от отбрасывания оставались одни цифры, и «Дым за 10 мин» уезжал в
 * файл `10.plan.json` — имя, по которому план уже не узнать.
 */
function nextPlanId(existing: ProjectTestPlan[], title: string): string {
  const base = slugify(title, 30) || 'plan';
  const used = new Set(existing.map((item) => item.id));
  if (!used.has(base)) return base;
  let attempt = 2;
  while (used.has(`${base}-${attempt}`)) attempt += 1;
  return `${base}-${attempt}`;
}

/** Создать или обновить план. Закрытый план правкам не поддаётся. */
export function savePlan(
  root: string,
  input: Partial<ProjectTestPlan> & { title: string },
  now: string,
): ProjectTestPlan {
  const title = input.title?.trim();
  if (!title)
    throw coded(new ProjectTestsError('У плана должно быть название.'), 'plan-title-missing');

  const all = readPlans(root);
  const id = input.id ? assertId(input.id, 'Идентификатор плана') : nextPlanId(all, title);
  const existing = all.find((item) => item.id === id);
  if (existing?.locked && input.locked !== false) {
    throw coded(
      new ProjectTestsError('План закрыт для правок. Снимите замок, чтобы менять состав.'),
      'plan-locked',
    );
  }

  const next: ProjectTestPlan = {
    id,
    title,
    product: optional(input.product),
    version: optional(input.version),
    description: optional(input.description),
    from: optional(input.from),
    to: optional(input.to),
    tags: input.tags?.length ? input.tags : undefined,
    caseIds: input.caseIds?.length ? input.caseIds : undefined,
    filter: input.filter,
    environmentIds: input.environmentIds?.length ? input.environmentIds : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    locked: input.locked === true ? true : undefined,
    archived: input.archived === true ? true : undefined,
  };
  writeJson(root, `${PLANS_DIR}/${id}${SUFFIX}`, next);
  return next;
}

/** Удалить план. История прогонов по нему остаётся. */
export function removePlan(root: string, id: string): void {
  const path = testsPath(root, `${PLANS_DIR}/${assertId(id, 'Идентификатор плана')}${SUFFIX}`);
  if (!existsSync(path))
    throw coded(new ProjectTestsNotFoundError(`Плана «${id}» в проекте нет.`), 'plan-not-found', {
      id,
    });
  rmSync(path, { force: true });
}

/** Кейсы плана: статический список плюс всё, что попало под его фильтр. */
export function planCases(
  groups: ProjectTestGroup[],
  plan: ProjectTestPlan,
): { groupId: string; testCase: ProjectTestCase }[] {
  const picked = new Map<string, { groupId: string; testCase: ProjectTestCase }>();

  if (plan.filter) {
    for (const item of selectCases(groups, plan.filter)) {
      picked.set(`${item.groupId}:${item.testCase.id}`, item);
    }
  }
  if (plan.caseIds?.length) {
    const wanted = new Set(plan.caseIds);
    for (const group of groups) {
      if (group.error) continue;
      for (const testCase of group.cases) {
        if (wanted.has(testCase.id) || wanted.has(`${group.id}:${testCase.id}`)) {
          picked.set(`${group.id}:${testCase.id}`, { groupId: group.id, testCase });
        }
      }
    }
  }
  return [...picked.values()];
}

/** Окружения, на которых гоняют этот набор. Пусто — одно «по умолчанию». */
function planEnvironments(
  environments: ProjectTestEnvironment[],
  plan?: ProjectTestPlan,
  environmentId?: string,
): (ProjectTestEnvironment | undefined)[] {
  if (environmentId) {
    const found = environments.find((item) => item.id === environmentId);
    return [found];
  }
  if (plan?.environmentIds?.length) {
    const chosen = plan.environmentIds
      .map((id) => environments.find((item) => item.id === id))
      .filter((item): item is ProjectTestEnvironment => item !== undefined);
    if (chosen.length > 0) return chosen;
  }
  return [defaultEnvironment(environments)];
}

/**
 * Развернуть кейсы в тест-поинты.
 *
 * Каждый кейс даёт столько поинтов, сколько окружений × сколько комбинаций
 * параметров. Кейс без параметров даёт ровно один поинт на окружение — иначе
 * обычная библиотека без параметров превратилась бы в пустой список.
 */
export function buildPoints(
  cases: { groupId: string; testCase: ProjectTestCase }[],
  environments: ProjectTestEnvironment[],
  options: { plan?: ProjectTestPlan; environmentId?: string; combine?: 'full' | 'pairwise' } = {},
): ProjectTestPoint[] {
  const envs = planEnvironments(environments, options.plan, options.environmentId);
  const points: ProjectTestPoint[] = [];

  for (const { groupId, testCase } of cases) {
    const combos = testCase.parameters?.length
      ? combineParams(testCase.parameters, options.combine ?? 'pairwise')
      : [{}];
    for (const environment of envs) {
      for (const params of combos) {
        const hasParams = Object.keys(params).length > 0;
        points.push({
          id: pointId(groupId, testCase.id, environment?.id, hasParams ? params : undefined),
          groupId,
          caseId: testCase.id,
          title: testCase.title,
          environmentId: environment?.id,
          params: hasParams ? params : undefined,
          priority: testCase.priority,
          duration: testCase.duration,
          automation: testCase.automation,
          status: testCase.status,
        });
      }
    }
  }
  return points;
}

/** Фильтр сохранённого вида по его идентификатору — для динамических наборов. */
export function filterOfView(views: ProjectTestView[], id?: string): ProjectTestFilter | undefined {
  if (!id) return undefined;
  return views.find((item) => item.id === id)?.filter;
}
