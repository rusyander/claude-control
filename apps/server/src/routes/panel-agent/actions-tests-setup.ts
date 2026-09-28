import { z } from 'zod';
import type {
  ProjectTestCase,
  ProjectTestDraft,
  ProjectTestEnvironment,
  ProjectTestsView,
} from '@agentdeck/contracts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import {
  card,
  encode,
  literalSecrets,
  readRoute,
  SECRET_REFUSAL,
  stateCard,
} from './action-kit.ts';
import { dataField, textField } from './texts.ts';
import { testsPage, testsQuery as query } from './tests-page.ts';
import { caseFilter, idOf, named, projectPath, schemaShown, viewOf } from './tests-block-kit.ts';

/**
 * Обвязка библиотеки тестов руками агента: общие шаги, окружения, свои поля и
 * статусы, сохранённые фильтры, соглашение о кейсах в инструкциях проекта,
 * пакетная правка кейсов, приёмка черновиков. Маршруты записи обвязки
 * заменяют запись ЦЕЛИКОМ, поэтому правка сливается здесь с записью с диска:
 * не названное моделью остаётся как было.
 *
 * Доступы окружения (значения паролей стенда) агенту не даны вовсе — ни
 * прочесть, ни записать: их вводит человек в панели. Имена доступов у
 * окружения агент тоже не трогает — они переносятся с диска как есть.
 */

const LIBRARY_FILES = {
  shared: '.agent/tests/_shared.steps.json',
  environments: '.agent/tests/environments.json',
  schema: '.agent/tests/schema.json',
  views: '.agent/tests/views.json',
};

function findIn<T extends { id: string }>(list: T[], id: string, what: string, read: string): T {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`${what} «${id}» not found. Call read_tests_report kind=${read}.`);
  return found;
}

const step = z.object({
  action: z.string().trim().min(1).describe('What to do'),
  data: z.string().optional().describe('Test data to type'),
  expected: z.string().optional().describe('What must be seen after THIS step'),
});

// ─── Общие шаги ────────────────────────────────────────────────────────────

const stepInput = z.object({
  projectPath,
  stepId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Existing shared step id to EDIT; omit to create'),
  title: z.string().trim().min(1).max(200).optional().describe('Required for a new shared step'),
  description: z.string().trim().max(2000).optional(),
  steps: z.array(step).min(1).max(100).optional().describe('Replaces all steps; required when new'),
});
type StepInput = z.infer<typeof stepInput>;

async function stepTarget(inject: InjectRoute, input: StepInput) {
  const all = (await viewOf(inject, input.projectPath)).sharedSteps;
  const existing = input.stepId
    ? findIn(all, input.stepId, 'Shared step', 'library-setup')
    : undefined;
  if (!existing && (!input.title || !input.steps)) {
    throw new Error('A new shared step needs a title and steps.');
  }
  const { updatedAt: _u, ...kept } = existing ?? { steps: [] };
  const next = {
    ...kept,
    ...(input.stepId ? { id: input.stepId } : {}),
    ...named({ title: input.title, description: input.description, steps: input.steps }),
  };
  return { all, existing, next };
}

const saveSharedStep = definePanelAction({
  name: 'save_shared_step',
  section: 'tests',
  risk: 'change',
  title: 'journal-save-shared-step',
  description:
    'Create or edit a shared step (a reusable block of steps cases refer to, e.g. "log in"). Only the ' +
    'fields you pass change; steps replace all steps. Needs the human’s confirmation.',
  input: stepInput,
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-tests/shared-step',
    body: { path: input.projectPath, step: (await stepTarget(inject, input)).next },
  }),
  fingerprint: async (input, inject) => {
    const { all, existing } = await stepTarget(inject, input);
    return fingerprintOf(existing ?? all.map((item) => item.id));
  },
  preview: async (input, inject) => {
    const { existing, next } = await stepTarget(inject, input);
    const { updatedAt: _u, ...before } = existing ?? { steps: [] };
    return stateCard(
      `${LIBRARY_FILES.shared}#${existing?.id ?? 'new'}`,
      existing ? before : {},
      next,
      card(existing ? 'summary-save-shared-step-update' : 'summary-save-shared-step-create', {
        title: String(next.title),
      }),
      [dataField('label-project', input.projectPath)],
    );
  },
  // Id нового шага выдаёт панель по названию: модель узнаёт его из вида.
  shape: (input, body) => {
    const steps = (body as ProjectTestsView).sharedSteps;
    const saved = input.stepId
      ? steps.find((item) => item.id === input.stepId)
      : steps.filter((item) => item.title === input.title).at(-1);
    return { stepId: saved?.id ?? null };
  },
  page: (input) => testsPage(input.projectPath, 'library'),
});

const deleteSharedStep = definePanelAction({
  name: 'delete_shared_step',
  section: 'tests',
  risk: 'danger',
  title: 'journal-delete-shared-step',
  description:
    'Delete a shared step. Cases that referred to it keep its title as plain text. Needs confirmation.',
  input: z.object({ projectPath, stepId: idOf('Shared step id') }),
  route: (input) => ({
    method: 'DELETE',
    url: `/api/project-tests/shared-step?${query(input.projectPath)}&id=${encode(input.stepId)}`,
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(
      findIn(
        (await viewOf(inject, input.projectPath)).sharedSteps,
        input.stepId,
        'Shared step',
        'library-setup',
      ),
    ),
  preview: async (input, inject) => {
    const found = findIn(
      (await viewOf(inject, input.projectPath)).sharedSteps,
      input.stepId,
      'Shared step',
      'library-setup',
    );
    const { updatedAt: _u, ...before } = found;
    return stateCard(
      `${LIBRARY_FILES.shared}#${found.id}`,
      before,
      {},
      card('summary-delete-shared-step', { title: found.title }),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: () => ({ deleted: true }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

// ─── Окружения ─────────────────────────────────────────────────────────────

const environmentInput = z.object({
  projectPath,
  environmentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Existing environment id to EDIT; omit to create'),
  title: z.string().trim().min(1).max(200).optional().describe('Required for a new environment'),
  baseUrl: z.string().trim().max(2000).optional().describe('App address, no credentials in it'),
  browser: z.string().trim().max(100).optional(),
  os: z.string().trim().max(100).optional(),
  start: z.string().trim().max(2000).optional().describe('Command that brings the stand up'),
  notes: z.string().trim().max(4000).optional(),
  isDefault: z.boolean().optional(),
  archived: z.boolean().optional(),
});
type EnvironmentInput = z.infer<typeof environmentInput>;

async function environmentTarget(inject: InjectRoute, input: EnvironmentInput) {
  const all = (await viewOf(inject, input.projectPath)).environments;
  const existing = input.environmentId
    ? findIn(all, input.environmentId, 'Environment', 'library-setup')
    : undefined;
  if (!existing && !input.title) throw new Error('A new environment needs a title.');
  const { projectPath: _path, environmentId, ...rest } = input;
  // Имена доступов — с диска как есть: маршрут заменяет окружение целиком, и
  // без них стенд молча терял бы свои пароли.
  const next: Partial<ProjectTestEnvironment> = {
    ...(existing ?? {}),
    ...(environmentId ? { id: environmentId } : {}),
    ...named(rest),
  };
  return { all, existing, next };
}

const saveTestEnvironment = definePanelAction({
  name: 'save_test_environment',
  section: 'tests',
  risk: 'change',
  title: 'journal-save-test-environment',
  description:
    'Create or edit a test environment (stand address, browser, OS, start command, notes). Only the ' +
    'fields you pass change. Stand credentials are never set here: the human enters them in the ' +
    'panel. Needs the human’s confirmation.',
  input: environmentInput,
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-tests/environment',
    body: { path: input.projectPath, environment: (await environmentTarget(inject, input)).next },
  }),
  fingerprint: async (input, inject) => {
    const { all, existing } = await environmentTarget(inject, input);
    return fingerprintOf(existing ?? all.map((item) => item.id));
  },
  preview: async (input, inject) => {
    if (
      literalSecrets({ baseUrl: input.baseUrl, start: input.start, notes: input.notes }).length > 0
    ) {
      throw new Error(SECRET_REFUSAL);
    }
    const { existing, next } = await environmentTarget(inject, input);
    return stateCard(
      `${LIBRARY_FILES.environments}#${existing?.id ?? 'new'}`,
      existing ?? {},
      next,
      card(
        existing ? 'summary-save-test-environment-update' : 'summary-save-test-environment-create',
        { title: String(next.title) },
      ),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: (input, body) => {
    const all = (body as ProjectTestsView).environments;
    const saved = input.environmentId
      ? all.find((item) => item.id === input.environmentId)
      : all.filter((item) => item.title === input.title).at(-1);
    return { environmentId: saved?.id ?? null };
  },
  page: (input) => testsPage(input.projectPath, 'library'),
});

async function environmentUse(inject: InjectRoute, path: string, id: string) {
  const view = await viewOf(inject, path);
  const found = findIn(view.environments, id, 'Environment', 'library-setup');
  const plans = view.plans.filter((plan) => plan.environmentIds?.includes(id));
  return { found, plans };
}

const deleteTestEnvironment = definePanelAction({
  name: 'delete_test_environment',
  section: 'tests',
  risk: 'danger',
  title: 'journal-delete-test-environment',
  description:
    'Delete a test environment together with the stand credentials saved for it in the panel. ' +
    'If plans refer to it, it is refused unless force=true (the human agreed the plans lose it). ' +
    'Needs the human’s confirmation.',
  input: z.object({
    projectPath,
    environmentId: idOf('Environment id'),
    force: z.boolean().optional().describe('Delete even though plans refer to it'),
  }),
  route: (input) => ({
    method: 'DELETE',
    url:
      `/api/project-tests/environment?${query(input.projectPath)}&id=${encode(input.environmentId)}` +
      (input.force ? '&force=1' : ''),
  }),
  fingerprint: async (input, inject) => {
    const { found, plans } = await environmentUse(inject, input.projectPath, input.environmentId);
    return fingerprintOf({ found, plans: plans.map((plan) => plan.id) });
  },
  preview: async (input, inject) => {
    const { found, plans } = await environmentUse(inject, input.projectPath, input.environmentId);
    if (plans.length > 0 && !input.force) {
      throw new Error(
        `Plans refer to this environment: ${plans.map((plan) => plan.title).join(', ')}. Ask the human; ` +
          'call again with force=true only if they agree the plans lose it.',
      );
    }
    return stateCard(
      `${LIBRARY_FILES.environments}#${found.id}`,
      found,
      {},
      card('summary-delete-test-environment', { title: found.title }),
      [
        dataField('label-project', input.projectPath),
        ...(plans.length > 0
          ? [dataField('label-used-by-plans', plans.map((plan) => plan.title).join(', '))]
          : []),
        ...(found.secrets?.length
          ? [textField('label-warning', 'value-environment-secrets-go')]
          : []),
      ],
    );
  },
  shape: () => ({ deleted: true }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

// ─── Свои поля и статусы ───────────────────────────────────────────────────

const saveTestSchema = definePanelAction({
  name: 'save_test_schema',
  section: 'tests',
  risk: 'change',
  title: 'journal-save-test-schema',
  description:
    'Replace the project’s custom case fields and custom statuses AS A WHOLE (read the current ' +
    'ones with read_tests_report kind=library-setup, change, send back all). A select field needs ' +
    'options; a custom status maps to one of the canonical statuses. Needs confirmation.',
  input: z.object({
    projectPath,
    attributes: z
      .array(
        z.object({
          id: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .describe('Latin field id, e.g. component (read shows it as id)'),
          title: z.string().trim().min(1).max(100),
          type: z.enum(['text', 'select', 'number']),
          options: z.array(z.string().trim().min(1)).max(100).optional(),
          required: z.boolean().optional(),
        }),
      )
      .max(50),
    statuses: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(40),
          title: z.string().trim().min(1).max(100),
          group: z.enum(['unknown', 'passed', 'failed', 'skipped', 'blocked']),
        }),
      )
      .max(50),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/schema',
    body: {
      path: input.projectPath,
      schema: {
        attributes: input.attributes.map(({ id, ...rest }) => ({ key: id, ...rest })),
        statuses: input.statuses,
      },
    },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await viewOf(inject, input.projectPath)).schema),
  preview: async (input, inject) =>
    stateCard(
      LIBRARY_FILES.schema,
      schemaShown((await viewOf(inject, input.projectPath)).schema),
      { attributes: input.attributes, statuses: input.statuses },
      card('summary-save-test-schema'),
      [dataField('label-project', input.projectPath)],
    ),
  shape: (_input, body) => schemaShown((body as ProjectTestsView).schema),
  page: (input) => testsPage(input.projectPath, 'library'),
});

// ─── Сохранённые фильтры ───────────────────────────────────────────────────

const viewInput = z.object({
  projectPath,
  viewId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Existing saved filter id to EDIT; omit to create'),
  title: z.string().trim().min(1).max(200).optional().describe('Required for a new filter'),
  filter: caseFilter.optional().describe('Replaces the filter; required for a new one'),
});
type ViewInput = z.infer<typeof viewInput>;

async function viewTarget(inject: InjectRoute, input: ViewInput) {
  const all = (await viewOf(inject, input.projectPath)).views;
  const existing = input.viewId
    ? findIn(all, input.viewId, 'Saved filter', 'library-setup')
    : undefined;
  if (!existing && (!input.title || !input.filter)) {
    throw new Error('A new saved filter needs a title and a filter.');
  }
  const { createdAt: _c, ...kept } = existing ?? { filter: {} };
  const next = {
    ...kept,
    ...(input.viewId ? { id: input.viewId } : {}),
    ...named({ title: input.title, filter: input.filter }),
  };
  return { all, existing, next };
}

const saveTestView = definePanelAction({
  name: 'save_test_view',
  section: 'tests',
  risk: 'change',
  title: 'journal-save-test-view',
  description:
    'Create or edit a saved case filter (also usable as a plan’s dynamic set). Needs confirmation.',
  input: viewInput,
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-tests/view',
    body: { path: input.projectPath, view: (await viewTarget(inject, input)).next },
  }),
  fingerprint: async (input, inject) => {
    const { all, existing } = await viewTarget(inject, input);
    return fingerprintOf(existing ?? all.map((item) => item.id));
  },
  preview: async (input, inject) => {
    const { existing, next } = await viewTarget(inject, input);
    const { createdAt: _c, ...before } = existing ?? { filter: {} };
    return stateCard(
      `${LIBRARY_FILES.views}#${existing?.id ?? 'new'}`,
      existing ? before : {},
      next,
      card(existing ? 'summary-save-test-view-update' : 'summary-save-test-view-create', {
        title: String(next.title),
      }),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: (input, body) => {
    const all = (body as ProjectTestsView).views;
    const saved = input.viewId
      ? all.find((item) => item.id === input.viewId)
      : all.filter((item) => item.title === input.title).at(-1);
    return { viewId: saved?.id ?? null };
  },
  page: (input) => testsPage(input.projectPath, 'library'),
});

const deleteTestView = definePanelAction({
  name: 'delete_test_view',
  section: 'tests',
  risk: 'danger',
  title: 'journal-delete-test-view',
  description: 'Delete a saved case filter. Needs the human’s confirmation.',
  input: z.object({ projectPath, viewId: idOf('Saved filter id') }),
  route: (input) => ({
    method: 'DELETE',
    url: `/api/project-tests/view?${query(input.projectPath)}&id=${encode(input.viewId)}`,
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(
      findIn(
        (await viewOf(inject, input.projectPath)).views,
        input.viewId,
        'Saved filter',
        'library-setup',
      ),
    ),
  preview: async (input, inject) => {
    const found = findIn(
      (await viewOf(inject, input.projectPath)).views,
      input.viewId,
      'Saved filter',
      'library-setup',
    );
    const { createdAt: _c, ...before } = found;
    return stateCard(
      `${LIBRARY_FILES.views}#${found.id}`,
      before,
      {},
      card('summary-delete-test-view', { title: found.title }),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: () => ({ deleted: true }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

// ─── Соглашение о кейсах ───────────────────────────────────────────────────

const installTestConvention = definePanelAction({
  name: 'install_test_convention',
  section: 'tests',
  risk: 'change',
  title: 'journal-install-test-convention',
  description:
    'Add the test-case convention block to the project’s instructions file (CLAUDE.md or AGENTS.md), ' +
    'so ordinary chats in the project keep cases too, not only test-agent runs. A backup of the file ' +
    'is kept. Needs the human’s confirmation.',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/convention',
    body: { path: input.projectPath },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await viewOf(inject, input.projectPath)).hasConvention),
  preview: async (input, inject) => {
    if ((await viewOf(inject, input.projectPath)).hasConvention) {
      throw new Error(
        'Nothing would change: the convention is already in the project instructions.',
      );
    }
    return {
      ...card('summary-install-test-convention'),
      fields: [
        dataField('label-project', input.projectPath),
        textField('label-what-happens', 'value-convention-install'),
      ],
    };
  },
  shape: (_input, body) => ({ hasConvention: (body as ProjectTestsView).hasConvention }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

// ─── Пакетная правка кейсов ────────────────────────────────────────────────

const BULK_EDITS = [
  'tag',
  'untag',
  'priority',
  'readiness',
  'automation',
  'section',
  'move',
  'duplicate',
  'archive',
  'restore',
  'mute',
  'unmute',
] as const;
type BulkEdit = (typeof BULK_EDITS)[number] | 'delete';

const bulkBase = {
  projectPath,
  groupId: idOf('Group id of the cases'),
  caseIds: z.array(z.string().trim().min(1)).min(1).max(1000).describe('Case ids in that group'),
};

async function bulkTarget(inject: InjectRoute, path: string, groupId: string, caseIds: string[]) {
  const group = (await viewOf(inject, path)).groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Test group «${groupId}» not found. Call list_test_groups.`);
  const missing = caseIds.filter((id) => !group.cases.some((item) => item.id === id));
  if (missing.length > 0) {
    throw new Error(`Not in group «${groupId}»: ${missing.join(', ')}. Call list_cases.`);
  }
  const ids = new Set(caseIds);
  return { group, cases: group.cases.filter((item) => ids.has(item.id)) };
}

/** Что правка сделает с одним кейсом — глазами человека, по одному полю. */
function bulkEffect(item: ProjectTestCase, action: BulkEdit, value: string) {
  const key = `${item.id} ${item.title}`;
  switch (action) {
    case 'tag':
      return { [key]: { tags: [...new Set([...(item.tags ?? []), value])] } };
    case 'untag':
      return { [key]: { tags: (item.tags ?? []).filter((tag) => tag !== value) } };
    case 'priority':
    case 'readiness':
    case 'section':
      return { [key]: { [action]: value || null } };
    case 'automation':
      return { [key]: { automation: value } };
    case 'move':
      return { [key]: { group: value } };
    case 'duplicate':
      return { [key]: { copy: `${item.title} (копия)` } };
    case 'archive':
    case 'restore':
      return { [key]: { archived: action === 'archive' } };
    case 'mute':
      return { [key]: { muted: true, muteReason: value || item.muteReason || '' } };
    case 'unmute':
      return { [key]: { muted: false } };
    case 'delete':
      return {};
  }
}

function bulkBefore(item: ProjectTestCase, action: BulkEdit, groupId: string) {
  const key = `${item.id} ${item.title}`;
  switch (action) {
    case 'tag':
    case 'untag':
      return { [key]: { tags: item.tags ?? [] } };
    case 'priority':
    case 'readiness':
    case 'section':
      return { [key]: { [action]: item[action] ?? null } };
    case 'automation':
      return { [key]: { automation: item.automation?.status ?? 'manual' } };
    case 'move':
      return { [key]: { group: groupId } };
    case 'duplicate':
      return { [key]: {} };
    case 'archive':
    case 'restore':
      return { [key]: { archived: item.archived === true } };
    case 'mute':
    case 'unmute':
      return {
        [key]: item.muted ? { muted: true, muteReason: item.muteReason ?? '' } : { muted: false },
      };
    case 'delete':
      return { [key]: { title: item.title, steps: item.steps.length } };
  }
}

/** Значение, без которого правка не имеет смысла, — отказ до карточки, а не 400 после клика. */
const NEEDS_VALUE: readonly BulkEdit[] = [
  'tag',
  'untag',
  'priority',
  'readiness',
  'automation',
  'move',
];

const bulkEditCases = definePanelAction({
  name: 'bulk_edit_cases',
  section: 'tests',
  risk: 'change',
  title: 'journal-bulk-edit-cases',
  description:
    'Change many cases of ONE group at once: tag/untag (value = tag), priority (blocker|high|medium|' +
    'low), readiness (draft|ready|obsolete), automation (manual|toAutomate|automated), section ' +
    '(value = tree path, empty clears), move (value = target group id), duplicate, archive, ' +
    'restore, mute (value = the reason; required unless the case has one), unmute. Needs confirmation.',
  input: z.object({
    ...bulkBase,
    action: z.enum(BULK_EDITS),
    value: z.string().trim().max(300).optional(),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/bulk',
    body: {
      path: input.projectPath,
      groupId: input.groupId,
      caseIds: input.caseIds,
      action: input.action,
      ...(input.value !== undefined ? { value: input.value } : {}),
    },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(
      (await bulkTarget(inject, input.projectPath, input.groupId, input.caseIds)).cases,
    ),
  preview: async (input, inject) => {
    if (NEEDS_VALUE.includes(input.action) && !input.value) {
      throw new Error(`action=${input.action} needs a value.`);
    }
    const { group, cases } = await bulkTarget(
      inject,
      input.projectPath,
      input.groupId,
      input.caseIds,
    );
    const value = input.value ?? '';
    return stateCard(
      group.file,
      Object.assign({}, ...cases.map((item) => bulkBefore(item, input.action, group.id))),
      Object.assign({}, ...cases.map((item) => bulkEffect(item, input.action, value))),
      card('summary-bulk-edit-cases', { count: cases.length }),
      [
        dataField('label-project', input.projectPath),
        dataField('label-bulk-action', value ? `${input.action}: ${value}` : input.action),
      ],
    );
  },
  shape: (_input, body) => ({ touched: (body as { touched?: number }).touched ?? 0 }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

const bulkDeleteCases = definePanelAction({
  name: 'bulk_delete_cases',
  section: 'tests',
  risk: 'danger',
  title: 'journal-bulk-delete-cases',
  description:
    'Delete many cases of ONE group from its file (run history keeps their past results). Prefer ' +
    'archive via bulk_edit_cases. Cannot be undone from the panel. Needs confirmation.',
  input: z.object(bulkBase),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/bulk',
    body: {
      path: input.projectPath,
      groupId: input.groupId,
      caseIds: input.caseIds,
      action: 'delete',
    },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(
      (await bulkTarget(inject, input.projectPath, input.groupId, input.caseIds)).cases,
    ),
  preview: async (input, inject) => {
    const { group, cases } = await bulkTarget(
      inject,
      input.projectPath,
      input.groupId,
      input.caseIds,
    );
    return stateCard(
      group.file,
      Object.assign({}, ...cases.map((item) => bulkBefore(item, 'delete', group.id))),
      {},
      card('summary-bulk-delete-cases', { count: cases.length }),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: (_input, body) => ({ deleted: (body as { touched?: number }).touched ?? 0 }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

// ─── Черновики генерации ───────────────────────────────────────────────────

const setDraftAutoAccept = definePanelAction({
  name: 'set_draft_auto_accept',
  section: 'tests',
  risk: 'change',
  title: 'journal-draft-auto-accept',
  description:
    'Turn "accept generation drafts at once" on or off for a project. On = cases written by the ' +
    'test agent reach the library without human review. Needs confirmation.',
  input: z.object({ projectPath, enabled: z.boolean() }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/draft/auto',
    body: { path: input.projectPath, enabled: input.enabled },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await viewOf(inject, input.projectPath)).autoAcceptDrafts),
  preview: async (input, inject) =>
    stateCard(
      'panel: tests auto-accept',
      { autoAccept: (await viewOf(inject, input.projectPath)).autoAcceptDrafts },
      { autoAccept: input.enabled },
      card(input.enabled ? 'summary-draft-auto-accept-on' : 'summary-draft-auto-accept-off'),
      [dataField('label-project', input.projectPath)],
    ),
  shape: (_input, body) => ({ autoAccept: (body as { autoAccept?: boolean }).autoAccept ?? null }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

async function acceptedOf(inject: InjectRoute, path: string, runId: string) {
  const { drafts } = await readRoute<{ drafts: ProjectTestDraft[] }>(
    inject,
    `/api/project-tests/drafts?${query(path)}&runId=${encode(runId)}`,
  );
  const draft = drafts[0];
  if (!draft) throw new Error(`Draft «${runId}» not found. Call list_test_groups.`);
  const items = draft.items.filter((item) => item.state === 'accepted');
  if (items.length === 0) throw new Error(`Draft «${runId}» has no accepted cases to undo.`);
  return { draft, items };
}

const rollbackDraft = definePanelAction({
  name: 'rollback_draft',
  section: 'tests',
  risk: 'danger',
  title: 'journal-rollback-draft',
  description:
    'Undo the acceptance of a generation draft: cases it added are removed, cases it changed get ' +
    'their previous text back. A case edited by someone after the acceptance is kept and named. ' +
    'Needs the human’s confirmation.',
  input: z.object({ projectPath, runId: idOf('Draft runId') }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/draft/rollback',
    body: { path: input.projectPath, runId: input.runId },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await acceptedOf(inject, input.projectPath, input.runId)).items),
  preview: async (input, inject) => {
    const { draft, items } = await acceptedOf(inject, input.projectPath, input.runId);
    return stateCard(
      draft.file,
      {
        accepted: items.map(
          (item) => `${item.op} ${item.groupId}/${item.caseId} ${item.testCase.title}`,
        ),
      },
      { accepted: [] },
      card('summary-rollback-draft', { count: items.length }),
      [dataField('label-project', input.projectPath), dataField('label-draft', draft.file)],
    );
  },
  shape: (_input, body) => {
    const { removed, restored, kept } = body as {
      removed?: number;
      restored?: number;
      kept?: unknown[];
    };
    return { removed: removed ?? 0, restored: restored ?? 0, kept: kept ?? [] };
  },
  page: (input) => testsPage(input.projectPath, 'library'),
});

export const TESTS_SETUP_ACTIONS: readonly AnyPanelAction[] = [
  saveSharedStep,
  deleteSharedStep,
  saveTestEnvironment,
  deleteTestEnvironment,
  saveTestSchema,
  saveTestView,
  deleteTestView,
  installTestConvention,
  bulkEditCases,
  bulkDeleteCases,
  setDraftAutoAccept,
  rollbackDraft,
];
