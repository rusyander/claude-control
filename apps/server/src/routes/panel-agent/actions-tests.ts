import { z } from 'zod';
import type { PanelActionPreview } from '@agentdeck/contracts/panel-agent';
import type {
  PlatformRunPlan,
  ProvidersResponse,
  ProjectTestDraft,
  ProjectTestRunRecord,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { dataField, summaryText, textField } from './texts.ts';
import { DRAFT_ADD_RESET_FIELDS, RUN_OWNED_FIELDS } from '../../domains/project-tests/drafts.ts';

/**
 * Тело кейса глазами приёмки: поля прогона, которые `applyDraft` не возьмёт из
 * предложения (`update` — все, `add` — результат), в карточку не идут —
 * иначе человек одобрил бы заметку агента, которой в файле не будет.
 */
function caseAsApplied(op: string, testCase: object): Record<string, unknown> {
  const dropped: readonly string[] = op === 'update' ? RUN_OWNED_FIELDS : DRAFT_ADD_RESET_FIELDS;
  return Object.fromEntries(Object.entries(testCase).filter(([key]) => !dropped.includes(key)));
}

/**
 * Действия раздела «Тестирование» (А5). Каждое идёт маршрутом раздела тестов;
 * отбор кейсов, запись черновика и запуск агента считает домен за маршрутом,
 * а здесь — только проекция ответа и карточка из того, что маршруты чтения
 * отдают окну.
 */

/**
 * Сколько символов тел кейсов помещается в карточку. `update` переписывает кейс
 * целиком, поэтому карточка показывает тело, а не заголовок; сверх предела —
 * `truncated`, и одобрить такую карточку нельзя (маршрут решения отвечает 409).
 */
const DRAFT_PREVIEW_MAX_CHARS = 200_000;

const projectPath = z.string().trim().min(1).describe('Absolute project directory');

const query = (path: string): string => `path=${encodeURIComponent(path)}`;

async function readRoute<T>(inject: InjectRoute, url: string): Promise<T> {
  const answer = await inject({ method: 'GET', url });
  if (answer.status >= 400) {
    const message = (answer.body as { message?: string } | undefined)?.message;
    throw new Error(message ?? `${url} answered ${answer.status}`);
  }
  return answer.body as T;
}

const listTestGroups = definePanelAction({
  name: 'list_test_groups',
  section: 'tests',
  risk: 'read',
  description:
    'Test groups of a project (id, title, case count, broken file reason), plans, environments, ' +
    'generation drafts waiting for review (runId, pending count) and the current agent run.',
  input: z.object({ projectPath }),
  route: (input) => ({ method: 'GET', url: `/api/project-tests?${query(input.projectPath)}` }),
  shape: (_input, body) => {
    const view = body as ProjectTestsView;
    return {
      groups: view.groups.map((group) => ({
        id: group.id,
        title: group.title,
        cases: group.cases.length,
        file: group.file,
        ...(group.error ? { error: group.error } : {}),
      })),
      plans: view.plans.map((plan) => ({ id: plan.id, title: plan.title })),
      environments: view.environments.map((env) => ({ id: env.id, title: env.title })),
      drafts: (view.drafts ?? []).map((draft) => ({
        runId: draft.runId,
        status: draft.status,
        total: draft.total,
        pending: draft.pending,
        ...(draft.error ? { error: draft.error } : {}),
      })),
      ...(view.run
        ? { run: { id: view.run.id, mode: view.run.mode, status: view.run.status } }
        : {}),
    };
  },
  summary: 'journal-list-test-groups',
});

const listCases = definePanelAction({
  name: 'list_cases',
  section: 'tests',
  risk: 'read',
  description:
    'Test cases of a project (optionally one group): id, title, status, priority, tags, muted.',
  input: z.object({
    projectPath,
    groupId: z.string().trim().min(1).optional().describe('Group id from list_test_groups'),
  }),
  route: (input) => ({ method: 'GET', url: `/api/project-tests?${query(input.projectPath)}` }),
  shape: (input, body) => {
    const view = body as ProjectTestsView;
    return {
      groups: view.groups
        .filter((group) => !input.groupId || group.id === input.groupId)
        .map((group) => ({
          id: group.id,
          title: group.title,
          ...(group.error ? { error: group.error } : {}),
          cases: group.cases.map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
            ...(item.priority ? { priority: item.priority } : {}),
            ...(item.tags?.length ? { tags: item.tags } : {}),
            ...(item.muted ? { muted: true } : {}),
            ...(item.archived ? { archived: true } : {}),
          })),
        })),
    };
  },
  summary: 'journal-list-cases',
});

const coverage = definePanelAction({
  name: 'coverage',
  section: 'tests',
  risk: 'read',
  description:
    'Requirement coverage matrix: requirement → cases → last result, uncovered requirements, ' +
    'orphan cases. Uses case links, plus Jira when the integration is on.',
  input: z.object({
    projectPath,
    linksOnly: z.boolean().optional().describe('Ignore Jira, use case links only'),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/coverage',
    body: { path: input.projectPath, ...(input.linksOnly ? { linksOnly: true } : {}) },
  }),
  summary: 'journal-coverage',
});

const lastRun = definePanelAction({
  name: 'last_run',
  section: 'tests',
  risk: 'read',
  description:
    'The newest test run of a project: mode, status, summary counts, failed cases, draft outcome.',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'GET',
    url: `/api/project-tests/runs?${query(input.projectPath)}&limit=1`,
  }),
  shape: (_input, body) => {
    const run = (body as { runs?: ProjectTestRunRecord[] }).runs?.[0];
    if (!run) return { run: null };
    const { results, ...record } = run;
    return {
      run: {
        ...record,
        failed: results
          .filter((result) => result.status === 'failed')
          .map((result) => ({ groupId: result.groupId, caseId: result.caseId })),
      },
    };
  },
  summary: 'journal-last-run',
});

const draftCases = definePanelAction({
  name: 'draft_cases',
  section: 'tests',
  risk: 'change',
  title: 'journal-draft-cases',
  description:
    'Write cases from a generation draft (runId from list_test_groups drafts) into the test ' +
    'library, whole draft or chosen caseIds. Needs the human’s confirmation.',
  input: z.object({
    projectPath,
    runId: z.string().trim().min(1).describe('Draft runId'),
    caseIds: z.array(z.string().trim().min(1)).max(500).optional().describe('Only these cases'),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/draft/apply',
    // `auto` не шлётся никогда: «принимать и дальше само» — решение человека в окне.
    body: {
      path: input.projectPath,
      runId: input.runId,
      ...(input.caseIds?.length ? { caseIds: input.caseIds } : {}),
    },
  }),
  // Отпечаток — ждущие правки черновика и файлы групп, в которые они лягут:
  // `update` поверх кейса, который человек поправил после карточки, стёр бы правку.
  fingerprint: async (input, inject) => {
    const { drafts } = await readRoute<{ drafts: ProjectTestDraft[] }>(
      inject,
      `/api/project-tests/drafts?${query(input.projectPath)}&runId=${encodeURIComponent(input.runId)}`,
    );
    const view = await readRoute<ProjectTestsView>(
      inject,
      `/api/project-tests?${query(input.projectPath)}`,
    );
    const items = (drafts[0]?.items ?? []).filter(
      (item) => (item.state ?? 'pending') === 'pending',
    );
    const groupIds = new Set(items.map((item) => item.groupId));
    return fingerprintOf({
      items,
      groups: view.groups.filter((group) => groupIds.has(group.id)),
    });
  },
  // Заголовки — из того же черновика, который откроет окно приёмки, и только
  // ждущие правки: принятое или отклонённое маршрут повторно не пишет.
  preview: async (input, inject) => {
    const { drafts } = await readRoute<{ drafts: ProjectTestDraft[] }>(
      inject,
      `/api/project-tests/drafts?${query(input.projectPath)}&runId=${encodeURIComponent(input.runId)}`,
    );
    const draft = drafts[0];
    if (!draft) throw new Error(`Draft «${input.runId}» not found.`);
    if (draft.error) throw new Error(`Draft «${input.runId}» is broken: ${draft.error}`);
    const chosen = input.caseIds?.length ? new Set(input.caseIds) : undefined;
    const items = draft.items.filter(
      (item) => (item.state ?? 'pending') === 'pending' && (!chosen || chosen.has(item.caseId)),
    );
    if (chosen) {
      const known = new Set(draft.items.map((item) => item.caseId));
      const unknown = [...chosen].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new Error(`Draft «${input.runId}» has no cases ${unknown.join(', ')}.`);
      }
    }
    if (items.length === 0) throw new Error(`Draft «${input.runId}» has nothing pending to write.`);
    // Тело кейса целиком: заголовок в карточке при `update`, переписывающем шаги
    // и ожидания, дал бы одобрить то, чего человек не видел.
    const cases: PanelActionPreview['fields'] = [];
    let used = 0;
    for (const item of items) {
      const value = JSON.stringify(caseAsApplied(item.op, item.testCase), null, 2);
      if (used + value.length > DRAFT_PREVIEW_MAX_CHARS) break;
      used += value.length;
      cases.push(
        dataField(item.op === 'update' ? 'label-case-update' : 'label-case-add', value, {
          target: `${item.groupId}/${item.caseId}`,
        }),
      );
    }
    const hidden = items.length - cases.length;
    return {
      ...summaryText('summary-draft-cases', { count: items.length }),
      ...(hidden > 0 ? { truncated: true } : {}),
      fields: [
        dataField('label-project', input.projectPath),
        dataField('label-draft', draft.file),
        ...cases,
        ...(hidden > 0 ? [textField('label-hidden', 'value-cases-hidden', { count: hidden })] : []),
      ],
    };
  },
  page: () => ({ route: '/tests', focus: 'library' }),
});

const runTests = definePanelAction({
  name: 'run_tests',
  section: 'tests',
  risk: 'danger',
  title: 'journal-run-tests',
  description:
    'Launch the test agent (a CLI run) on a project: mode "run" executes cases (a group, caseIds ' +
    'or the whole library); mode "generate" writes new cases into a draft from `scope`. ' +
    'Needs the human’s confirmation.',
  input: z.object({
    projectPath,
    mode: z.enum(['run', 'generate']).optional().describe('Default run'),
    groupId: z.string().trim().min(1).optional(),
    caseIds: z.array(z.string().trim().min(1)).max(1000).optional(),
    environmentId: z.string().trim().min(1).optional(),
    scope: z.string().trim().max(4000).optional().describe('What to test / what to generate'),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/run',
    body: {
      path: input.projectPath,
      mode: input.mode ?? 'run',
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.caseIds?.length ? { caseIds: input.caseIds } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    },
  }),
  // Отпечаток — то, из чего карточка посчитала отбор и модель: id кейсов
  // выбранных групп и план маршрута контура. Заголовки и итоги кейсов в него не
  // входят: карточка их не показывает, а прогоны меняют итоги сами.
  fingerprint: async (input, inject) => {
    const view = await readRoute<ProjectTestsView>(
      inject,
      `/api/project-tests?${query(input.projectPath)}`,
    );
    const plan = await readRoute<PlatformRunPlan>(inject, '/api/platform-run-plan/tests');
    return fingerprintOf({
      selection: view.groups
        .filter((group) => !input.groupId || group.id === input.groupId)
        .map((group) => [group.id, group.cases.map((item) => item.id)]),
      plan: { routed: plan.routed, refused: plan.refused, title: plan.title, reason: plan.reason },
      model: plan.routed ? chooseRunModel(plan.rules, '').model : '',
    });
  },
  // Отбор в карточке — из вида раздела: те же id, что проверит маршрут. Модель —
  // маршрутом `platform-run-plan/tests`, тем же, по которому реестр прогонов
  // решает, идёт ли агент тестов через контур; своей модели прогон не шлёт.
  preview: async (input, inject) => {
    const view = await readRoute<ProjectTestsView>(
      inject,
      `/api/project-tests?${query(input.projectPath)}`,
    );
    const plan = await readRoute<PlatformRunPlan>(inject, '/api/platform-run-plan/tests');
    const mode = input.mode ?? 'run';
    const groups = view.groups.filter((group) => !input.groupId || group.id === input.groupId);
    if (input.groupId && groups.length === 0)
      throw new Error(`Group «${input.groupId}» not found.`);
    // Id из входа модели сверяются с библиотекой: число «кейсов в отборе» из
    // несуществующих id обещало бы прогон, которого не будет.
    const known = new Set(groups.flatMap((group) => group.cases.map((item) => item.id)));
    const unknown = [...new Set(input.caseIds ?? [])].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `Cases not found${input.groupId ? ` in group «${input.groupId}»` : ''}: ${unknown.join(', ')}.`,
      );
    }
    if (input.environmentId && !view.environments.some((env) => env.id === input.environmentId)) {
      throw new Error(`Environment «${input.environmentId}» not found.`);
    }
    const selected = input.caseIds?.length
      ? new Set(input.caseIds).size
      : groups.reduce((sum, group) => sum + group.cases.length, 0);
    // Прогон тестов исполняет `ChatRun` — всегда CLI Claude Code, какой бы CLI ни
    // был активен; имя берётся из реестра провайдеров, а не строкой.
    const providers = await readRoute<ProvidersResponse>(inject, '/api/providers');
    const providerName = providers.providers.find((item) => item.id === 'claude')?.name ?? 'claude';
    const model = plan.routed ? chooseRunModel(plan.rules, '').model : '';
    const fields = [
      dataField('label-project', input.projectPath),
      textField('label-mode', mode === 'generate' ? 'value-mode-generate' : 'value-mode-run'),
      ...(mode === 'run' ? [dataField('label-selected-cases', String(selected))] : []),
      input.groupId
        ? dataField('label-group', input.groupId)
        : textField('label-group', 'value-group-all'),
      ...(input.environmentId ? [dataField('label-environment', input.environmentId)] : []),
      ...(input.scope ? [dataField('label-scope', input.scope)] : []),
      providers.active === 'claude'
        ? dataField('label-provider', providerName)
        : textField('label-provider', 'value-provider-other', {
            provider: providerName,
            active: providers.active,
          }),
      model ? dataField('label-model', model) : textField('label-model', 'value-model-default'),
      ...(plan.routed ? [dataField('label-contour', plan.title)] : []),
      ...(!plan.routed && plan.refused
        ? [
            textField('label-contour', 'value-contour-refuses', {
              reason: plan.reason ?? plan.title,
            }),
          ]
        : []),
      ...(view.run?.status === 'running'
        ? [textField('label-warning', 'value-run-already', { id: view.run.id })]
        : []),
    ];
    return {
      ...(mode === 'generate'
        ? summaryText('summary-run-tests-generate')
        : summaryText('summary-run-tests-run', { count: selected })),
      fields,
    };
  },
  shape: (_input, body) => {
    const run = (body as ProjectTestsView).run;
    return run ? { run: { id: run.id, mode: run.mode, status: run.status } } : { run: null };
  },
  page: () => ({ route: '/tests', focus: 'runs' }),
});

/** Действия раздела «Тестирование» в порядке показа. */
export const TEST_ACTIONS: readonly AnyPanelAction[] = [
  listTestGroups,
  listCases,
  coverage,
  lastRun,
  draftCases,
  runTests,
];
