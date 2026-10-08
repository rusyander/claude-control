import { z } from 'zod';
import type {
  ProjectTestPlan,
  ProjectTestPlanPreview,
  ProjectTestPlanRecipe,
} from '@agentdeck/contracts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, encode, stateCard, textOf } from './action-kit/action-kit.ts';
import { dataField, textField } from './texts/texts.ts';
import { testsPage, testsQuery as query } from './tests-page.ts';
import { caseFilter, idOf, named, projectPath, viewOf } from './tests-block-kit.ts';

/**
 * Тест-планы руками агента: завести и поправить план, удалить, собрать правилом
 * («дым за N минут», «регрессия по диффу», «план вехи», «нестабильные»). Всё —
 * маршрутами вкладки «Планы». Маршрут записи плана заменяет файл ЦЕЛИКОМ,
 * поэтому правка сливается здесь с планом с диска: поля, которых модель не
 * назвала, остаются как были, а не стираются.
 */

const PLAN_FILE = (id: string) => `.agent/tests/plans/${id}.plan.json`;

async function planOf(inject: InjectRoute, path: string, id: string): Promise<ProjectTestPlan> {
  const plan = (await viewOf(inject, path)).plans.find((item) => item.id === id);
  if (!plan) throw new Error(`Test plan «${id}» not found. Call read_tests_report kind=plans.`);
  return plan;
}

const planInput = z.object({
  projectPath,
  planId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Existing plan id to EDIT; omit to create (the panel assigns the id)'),
  title: z.string().trim().min(1).max(200).optional().describe('Required for a new plan'),
  description: z.string().trim().max(4000).optional(),
  product: z.string().trim().max(200).optional(),
  version: z.string().trim().max(100).optional(),
  from: z.string().trim().max(40).optional().describe('ISO date'),
  to: z.string().trim().max(40).optional().describe('ISO date'),
  tags: z.array(z.string().trim().min(1)).max(30).optional(),
  caseIds: z
    .array(z.string().trim().min(1))
    .max(2000)
    .optional()
    .describe('Static case list (replaces the list on disk)'),
  filter: caseFilter.optional().describe('Dynamic set: cases matching it at run time'),
  environmentIds: z.array(z.string().trim().min(1)).max(50).optional(),
  locked: z.boolean().optional().describe('true = closed for edits; false = unlock'),
  archived: z.boolean().optional(),
});
type PlanInput = z.infer<typeof planInput>;

async function planTarget(inject: InjectRoute, input: PlanInput) {
  const plans = (await viewOf(inject, input.projectPath)).plans;
  const existing = input.planId ? plans.find((item) => item.id === input.planId) : undefined;
  if (input.planId && !existing) {
    throw new Error(
      `Test plan «${input.planId}» not found. Omit planId to create one, or call read_tests_report kind=plans.`,
    );
  }
  if (!existing && !input.title) throw new Error('A new plan needs a title.');
  const { projectPath: _path, planId, ...rest } = input;
  const plan: Partial<ProjectTestPlan> = {
    ...(existing ?? {}),
    ...(planId ? { id: planId } : {}),
    ...named(rest),
  };
  return { plans, existing, plan };
}

/** План для глаз человека: без служебных дат, которые пишет сама панель. */
const shown = (plan: Partial<ProjectTestPlan>) => {
  const { createdAt: _c, updatedAt: _u, ...rest } = plan;
  return rest;
};

const saveTestPlan = definePanelAction({
  name: 'save_test_plan',
  section: 'tests',
  risk: 'change',
  title: 'journal-save-test-plan',
  description:
    'Create a test plan or edit one (planId). A plan is a SET for a run: a static caseIds list and/or ' +
    'a filter, plus environments (case × environment = test points). Only the fields you pass change. ' +
    'A locked plan refuses edits until you pass locked=false. Needs the human’s confirmation.',
  input: planInput,
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-tests/plan',
    body: { path: input.projectPath, plan: (await planTarget(inject, input)).plan },
  }),
  fingerprint: async (input, inject) => {
    const { plans, existing } = await planTarget(inject, input);
    return fingerprintOf(existing ?? plans.map((item) => item.id));
  },
  preview: async (input, inject) => {
    const { existing, plan } = await planTarget(inject, input);
    if (existing?.locked && input.locked !== false) {
      throw new Error(
        `Plan «${existing.title}» is locked for edits. Ask the human; pass locked=false only if they want it unlocked.`,
      );
    }
    return stateCard(
      existing ? PLAN_FILE(existing.id) : '.agent/tests/plans/(new).plan.json',
      existing ? shown(existing) : {},
      shown(plan),
      card(existing ? 'summary-save-test-plan-update' : 'summary-save-test-plan-create', {
        title: String(plan.title),
      }),
      [dataField('label-project', input.projectPath)],
    );
  },
  // Id нового плана выдаёт панель: модель узнаёт его из ответа.
  shape: (_input, body) => {
    const plan = (body as { plan?: ProjectTestPlan }).plan;
    return { planId: plan?.id ?? null, title: plan?.title ?? null };
  },
  page: (input) => testsPage(input.projectPath, 'plans'),
});

const deleteTestPlan = definePanelAction({
  name: 'delete_test_plan',
  section: 'tests',
  risk: 'danger',
  title: 'journal-delete-test-plan',
  description:
    'Delete a test plan file. Runs made by it stay in the history. Cannot be undone from the panel. ' +
    'Needs the human’s confirmation.',
  input: z.object({ projectPath, planId: idOf('Plan id from read_tests_report kind=plans') }),
  route: (input) => ({
    method: 'DELETE',
    url: `/api/project-tests/plan?${query(input.projectPath)}&id=${encode(input.planId)}`,
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(await planOf(inject, input.projectPath, input.planId)),
  preview: async (input, inject) => {
    const plan = await planOf(inject, input.projectPath, input.planId);
    return stateCard(
      PLAN_FILE(plan.id),
      shown(plan),
      {},
      card('summary-delete-test-plan', { title: plan.title }),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: () => ({ deleted: true }),
  page: (input) => testsPage(input.projectPath, 'plans'),
});

const buildInput = z.object({
  projectPath,
  recipe: z
    .enum(['smoke', 'diff', 'release', 'flaky'])
    .describe(
      'smoke = by priority and risk within `budget` minutes (default 30); diff = cases touched by ' +
        'working-copy changes; release = requirement cases of `release` plus last milestone reds; ' +
        'flaky = stability below `threshold`',
    ),
  budget: z.number().positive().max(10_000).optional().describe('Minutes for smoke; default 30'),
  release: z.string().trim().min(1).optional().describe('Milestone name; for release'),
  threshold: z.number().min(0).max(1).optional().describe('Stability 0–1; for flaky'),
  environmentId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(200).optional().describe('Plan title; default by the rule'),
});
type BuildInput = z.infer<typeof buildInput>;

/** Тело сохранения — путь кнопки «Сохранить» сборки, после клика человека. */
const buildBody = (input: BuildInput) => ({
  path: input.projectPath,
  recipe: input.recipe,
  ...named({
    budget: input.budget,
    release: input.release,
    threshold: input.threshold,
    environmentId: input.environmentId,
    title: input.title,
  }),
  save: true,
});

/**
 * Отбор правилом «сейчас» — GET предпросмотра, тот же отбор, что у кнопки
 * «Показать». Сборка карточки не пишет ничего: у этого маршрута нет пути к
 * записи, а POST `plan/build` зовётся только исполнением после клика.
 */
async function buildPreview(inject: InjectRoute, input: BuildInput) {
  const query = new URLSearchParams({ path: input.projectPath, recipe: input.recipe });
  for (const [key, value] of Object.entries({
    budget: input.budget,
    release: input.release,
    threshold: input.threshold,
    environmentId: input.environmentId,
    title: input.title,
  })) {
    if (value !== undefined) query.set(key, String(value));
  }
  const answer = await inject({
    method: 'GET',
    url: `/api/project-tests/plan/preview?${query.toString()}`,
  });
  if (answer.status >= 400) {
    throw new Error(`The plan rule refused: ${textOf(answer.body) || `HTTP ${answer.status}`}`);
  }
  return (answer.body as { preview: ProjectTestPlanPreview }).preview;
}

const pickLine = (pick: ProjectTestPlanPreview['picked'][number]) =>
  `${pick.groupId}/${pick.caseId} ${pick.title}`;

const buildTestPlan = definePanelAction({
  name: 'build_test_plan',
  section: 'tests',
  risk: 'change',
  title: 'journal-build-test-plan',
  description:
    'Build and SAVE a test plan by a rule (smoke / diff / release / flaky). The card shows the picked ' +
    'cases and what was left out; the plan is saved as a static list the human can edit later. For ' +
    'a look without saving, answer from the card or read_tests_report kind=risk. Needs confirmation.',
  input: buildInput,
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/plan/build',
    body: buildBody(input),
  }),
  // Отбор считается по библиотеке «сейчас»: другой отбор к клику — другая карточка.
  fingerprint: async (input, inject) =>
    fingerprintOf((await buildPreview(inject, input)).picked.map(pickLine)),
  preview: async (input, inject) => {
    const preview = await buildPreview(inject, input);
    if (preview.picked.length === 0) {
      throw new Error(
        'The rule picked no cases, so there is no plan to save. Tell the human what the rule needs ' +
          '(priorities and durations for smoke, a git diff for diff, runs for flaky).',
      );
    }
    return stateCard(
      '.agent/tests/plans/(new).plan.json',
      {},
      {
        title: preview.title,
        minutes: preview.minutes,
        picked: preview.picked.map((pick) => `${pickLine(pick)} — ${pick.reason}`),
        left: preview.left.map((pick) => `${pickLine(pick)} — ${pick.reason}`),
      },
      card('summary-build-test-plan', { title: preview.title, count: preview.picked.length }),
      [
        dataField('label-project', input.projectPath),
        textField('label-plan-recipe', recipeValue(input.recipe)),
      ],
    );
  },
  shape: (_input, body) => {
    const answer = body as { plan?: ProjectTestPlan; preview?: ProjectTestPlanPreview };
    return {
      planId: answer.plan?.id ?? null,
      title: answer.plan?.title ?? null,
      picked: answer.preview?.picked.length ?? 0,
      left: answer.preview?.left.length ?? 0,
      minutes: answer.preview?.minutes ?? 0,
    };
  },
  page: (input) => testsPage(input.projectPath, 'plans'),
});

function recipeValue(recipe: ProjectTestPlanRecipe) {
  return (
    {
      smoke: 'value-plan-recipe-smoke',
      diff: 'value-plan-recipe-diff',
      release: 'value-plan-recipe-release',
      flaky: 'value-plan-recipe-flaky',
    } as const
  )[recipe];
}

export const TESTS_PLAN_ACTIONS: readonly AnyPanelAction[] = [
  saveTestPlan,
  deleteTestPlan,
  buildTestPlan,
];
