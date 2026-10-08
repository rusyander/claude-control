import { z } from 'zod';
import type { ProjectTestsView } from '@agentdeck/contracts';
import { definePanelAction, type ActionRouteRequest, type AnyPanelAction } from './registry.ts';
import { encode } from './action-kit/action-kit.ts';
import { testsQuery as query } from './tests-page.ts';
import { assertRegistered, fitForModel, projectPath, schemaShown } from './tests-block-kit.ts';

/**
 * Чтения блока «Тестирование» одним действием с видом отчёта: отчёт, дифф
 * прогонов, задетое правками, история группы и кейса, нестабильные, карантин,
 * риск, раскладка по секциям, пирамида, веха, планы и их тест-поинты, ручной
 * прогон, эталоны, папка e2e и её прогон, обвязка библиотеки. Каждое — тем же
 * маршрутом, что вкладка окна; девятнадцать почти одинаковых инструментов
 * модель читала бы каждый ход, а вид — это одно поле.
 */

export const TESTS_REPORT_KINDS = [
  'report',
  'run-diff',
  'impact',
  'group-history',
  'case-history',
  'flaky',
  'quarantine',
  'risk',
  'taxonomy',
  'pyramid',
  'release',
  'plans',
  'plan-points',
  'manual',
  'baselines',
  'e2e',
  'e2e-run',
  'library-setup',
] as const;
type Kind = (typeof TESTS_REPORT_KINDS)[number];

const input = z.object({
  projectPath,
  kind: z
    .enum(TESTS_REPORT_KINDS)
    .describe(
      'report = coverage by area, automation, flaky, spend; run-diff = what changed between two runs ' +
        '(runId, optional baseRunId); impact = cases touched by working-copy changes; group-history = ' +
        'git history of a group file (groupId); case-history = one case across runs (groupId, caseId); ' +
        'flaky = cases marked flaky; quarantine = quarantine proposals; risk = what to run first ' +
        '(optional groupId, budget minutes); taxonomy = proposed sections (optional minCases); pyramid = ' +
        'unit/integration/e2e counts; release = milestone readiness (release; without it the milestone ' +
        'list); plans = test plans in full; plan-points = what a plan will pass (planId, optional ' +
        'environmentId); manual = the manual run in progress (runId, points, marks); baselines = visual ' +
        'baselines (optional caseId); e2e = the e2e folder; e2e-run = the last autotest run; ' +
        'library-setup = shared steps, environments, custom fields/statuses, saved filters, drafts auto-accept',
    ),
  groupId: z.string().trim().min(1).optional(),
  caseId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  baseRunId: z.string().trim().min(1).optional(),
  planId: z.string().trim().min(1).optional(),
  environmentId: z.string().trim().min(1).optional(),
  release: z.string().trim().min(1).optional(),
  budget: z.number().positive().max(10_000).optional().describe('Minutes, for kind=risk'),
  minCases: z.number().int().positive().max(1_000).optional().describe('For kind=taxonomy'),
  limit: z.number().int().min(1).max(200).optional().describe('Runs to read, for kind=report'),
});
type Input = z.infer<typeof input>;

function need(value: string | undefined, name: string, kind: Kind): string {
  if (!value) throw new Error(`kind=${kind} needs ${name}.`);
  return value;
}

const get = (url: string): ActionRouteRequest => ({ method: 'GET', url });

/** Вид → маршрут окна. Вид раздела один на несколько видов: срез — в `shape`. */
function testsReportRoute(input: Input): ActionRouteRequest {
  const base = query(input.projectPath);
  const kind = input.kind;
  switch (kind) {
    case 'report':
      return get(`/api/project-tests/report?${base}&limit=${input.limit ?? 50}`);
    case 'run-diff':
      return get(
        `/api/project-tests/run/diff?${base}&id=${encode(need(input.runId, 'runId', kind))}` +
          (input.baseRunId ? `&baseId=${encode(input.baseRunId)}` : ''),
      );
    case 'impact':
      return get(`/api/project-tests/impact?${base}`);
    case 'group-history':
      return get(
        `/api/project-tests/history?${base}&groupId=${encode(need(input.groupId, 'groupId', kind))}`,
      );
    case 'case-history':
      return get(
        `/api/project-tests/case-history?${base}` +
          `&groupId=${encode(need(input.groupId, 'groupId', kind))}` +
          `&caseId=${encode(need(input.caseId, 'caseId', kind))}`,
      );
    case 'flaky':
      return get(`/api/project-tests/flaky?${base}`);
    case 'quarantine':
      return get(`/api/project-tests/quarantine?${base}`);
    case 'risk':
      return get(
        `/api/project-tests/risk?${base}` +
          (input.groupId ? `&groupId=${encode(input.groupId)}` : '') +
          (input.budget ? `&budget=${input.budget}` : ''),
      );
    case 'taxonomy':
      return get(
        `/api/project-tests/taxonomy?${base}` +
          (input.minCases ? `&minCases=${input.minCases}` : ''),
      );
    case 'pyramid':
      return get(`/api/project-tests/pyramid?${base}`);
    case 'release':
      return get(
        `/api/project-tests/release?${base}` +
          (input.release ? `&release=${encode(input.release)}` : ''),
      );
    case 'plans':
      return get(`/api/project-tests/plans?${base}`);
    case 'plan-points':
      return get(
        `/api/project-tests/plan/points?${base}&id=${encode(need(input.planId, 'planId', kind))}` +
          (input.environmentId ? `&environmentId=${encode(input.environmentId)}` : ''),
      );
    case 'manual':
      return get(`/api/project-tests/manual?${base}`);
    case 'baselines':
      return get(
        `/api/project-tests/baselines?${base}` +
          (input.caseId ? `&caseId=${encode(input.caseId)}` : ''),
      );
    case 'e2e':
      return get(`/api/project-tests/e2e?${base}`);
    case 'e2e-run':
    case 'library-setup':
      return get(`/api/project-tests?${base}`);
  }
}

/** Срез вида раздела: только то, что спросили, — вид целиком весит десятки килобайт. */
function sliceOfView(kind: Kind, view: ProjectTestsView): unknown {
  if (kind === 'e2e-run') {
    const run = view.e2eRun;
    return {
      run: run
        ? {
            ...run,
            // Хвост лога — там итог и ошибка; начало лога модели не нужно.
            log: run.log.length > 4_000 ? `…${run.log.slice(-4_000)}` : run.log,
          }
        : null,
      ...(view.automation ? { automation: view.automation } : {}),
      ...(view.e2e ? { folder: view.e2e } : {}),
    };
  }
  return {
    sharedSteps: view.sharedSteps,
    // Доступы стенда — только именами: значения панель модели не отдаёт.
    environments: view.environments,
    schema: schemaShown(view.schema),
    views: view.views,
    hasConvention: view.hasConvention,
    autoAcceptDrafts: view.autoAcceptDrafts,
    ...(view.libraryIssues?.length ? { libraryIssues: view.libraryIssues } : {}),
  };
}

const readTestsReport = definePanelAction({
  name: 'read_tests_report',
  section: 'tests',
  risk: 'read',
  description:
    'Read one report of the Testing section by kind (see the kind list). Use it for questions like ' +
    '"what is flaky", "what should I run first", "is the milestone ready", "what does this plan ' +
    'cover", "where is the manual run", "which baselines differ", "did the autotests pass". Long ' +
    'lists come back shortened with `truncatedLists` = full lengths.',
  input,
  // Карточки у чтения нет — проект проверяется здесь (см. `registeredOnly`).
  route: async (value, inject) => {
    await assertRegistered(inject, value.projectPath);
    return testsReportRoute(value);
  },
  shape: (value, body) =>
    fitForModel(
      value.kind === 'e2e-run' || value.kind === 'library-setup'
        ? sliceOfView(value.kind, body as ProjectTestsView)
        : body,
    ),
  summary: 'journal-read-tests-report',
});

export const TESTS_READ_ACTIONS: readonly AnyPanelAction[] = [readTestsReport];
