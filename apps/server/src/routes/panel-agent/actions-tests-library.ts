import { z } from 'zod';
import type { ProjectTestCase, ProjectTestDraft, ProjectTestsView } from '@agentdeck/contracts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, encode, readRoute, stateCard } from './action-kit.ts';
import { dataField } from './texts.ts';
import { testsPage, testsQuery } from './tests-page.ts';
import { registeredOnly } from './tests-block-kit.ts';

/**
 * Правка библиотеки тестов руками агента панели: кейс, группа, отказ от
 * черновика. Раньше агент умел только читать, запускать генерацию и удалять
 * кейс — на «добавь кейс про пустое сообщение» или «переименуй группу» ему
 * оставалось запускать генерацию на полчаса ради одной строки. Всё идёт теми же
 * маршрутами, что и кнопки раздела: слияние с диском по `id`, отказ при идущем
 * прогоне, запрет на правку чужой группы — у маршрута, а не здесь.
 */

const projectPath = z.string().trim().min(1).describe('Absolute project directory');
const groupId = z.string().trim().min(1).describe('Group id from list_test_groups');
const text = (limit: number) => z.string().trim().max(limit).optional();

const step = z.union([
  z.string().trim().min(1),
  z.object({
    action: z.string().trim().min(1).describe('What to do'),
    data: z.string().optional().describe('Test data to type'),
    expected: z.string().optional().describe('What must be seen after THIS step'),
  }),
]);

const viewOf = (inject: InjectRoute, path: string) =>
  readRoute<ProjectTestsView>(inject, `/api/project-tests?${testsQuery(path)}`);

async function groupOf(inject: InjectRoute, path: string, id: string) {
  const group = (await viewOf(inject, path)).groups.find((item) => item.id === id);
  if (!group) throw new Error(`Test group «${id}» not found. Call list_test_groups.`);
  return group;
}

const caseInput = z.object({
  projectPath,
  groupId,
  caseId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Existing case id to EDIT; omit to create a new case (the panel assigns the id)'),
  title: text(300).describe('What is checked; required for a new case'),
  purpose: text(2000),
  area: text(200).describe('App zone: chat, settings, tests…'),
  section: text(300).describe('Tree path, e.g. "Chat/Composer"'),
  precondition: text(4000),
  steps: z
    .array(step)
    .max(100)
    .optional()
    .describe('Replaces ALL steps when given; omit to keep the steps on disk'),
  expected: text(4000).describe('Final expected result'),
  oracle: text(2000).describe('What proves the result: text on screen, file, network answer'),
  priority: z.enum(['blocker', 'high', 'medium', 'low']).optional(),
  readiness: z.enum(['draft', 'ready', 'obsolete']).optional(),
  type: z.enum(['case', 'checklist']).optional(),
  tags: z.array(z.string().trim().min(1)).max(30).optional(),
  codePaths: z.array(z.string().trim().min(1)).max(50).optional(),
});
type CaseInput = z.infer<typeof caseInput>;

/** Поля кейса из входа модели: только названные — остальное маршрут берёт с диска. */
function caseBody(input: CaseInput, existing?: ProjectTestCase): Record<string, unknown> {
  const { projectPath: _path, groupId: _group, caseId, title, steps, ...rest } = input;
  const named = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  return {
    ...(caseId ? { id: caseId } : {}),
    // Маршрут требует название и у правки: без него берём то, что на диске.
    title: title ?? existing?.title ?? '',
    ...(steps ? { steps } : {}),
    ...named,
  };
}

async function caseTarget(inject: InjectRoute, input: CaseInput) {
  const group = await groupOf(inject, input.projectPath, input.groupId);
  const existing = input.caseId ? group.cases.find((item) => item.id === input.caseId) : undefined;
  if (input.caseId && !existing) {
    throw new Error(
      `Case «${input.caseId}» is not in group «${input.groupId}». ` +
        'Omit caseId to create a new case, or call list_cases.',
    );
  }
  if (!existing && !input.title) throw new Error('A new case needs a title.');
  return { group, existing };
}

const saveTestCase = definePanelAction({
  name: 'save_test_case',
  section: 'tests',
  risk: 'change',
  title: 'journal-save-test-case',
  description:
    'Create one test case in a group, or edit an existing one (caseId). Only the fields you pass ' +
    'change; steps, when passed, replace all steps. Write concrete steps with an expected result ' +
    'per step and an oracle. Needs the human’s confirmation.',
  input: caseInput,
  route: async (input, inject) => {
    const { existing } = await caseTarget(inject, input);
    return {
      method: 'POST',
      url: '/api/project-tests/case',
      body: {
        path: input.projectPath,
        groupId: input.groupId,
        testCase: caseBody(input, existing),
      },
    };
  },
  // Отпечаток — кейс, который правка перепишет (или список id группы для
  // нового): поправленный человеком после карточки кейс не затирается молча.
  fingerprint: async (input, inject) => {
    const { group, existing } = await caseTarget(inject, input);
    return fingerprintOf(existing ?? group.cases.map((item) => item.id));
  },
  preview: async (input, inject) => {
    const { group, existing } = await caseTarget(inject, input);
    const body = caseBody(input, existing);
    const after = existing ? { ...existing, ...body } : body;
    return stateCard(
      `${group.file}#${existing?.id ?? 'new'}`,
      existing ?? {},
      after,
      card(existing ? 'summary-save-test-case-update' : 'summary-save-test-case-create', {
        title: String(after.title),
      }),
      [dataField('label-project', input.projectPath), dataField('label-file', group.file)],
    );
  },
  // Id нового кейса выдаёт панель: модель узнаёт его из ответа, иначе следующая
  // правка «этого же кейса» создала бы второй.
  shape: (input, body) => {
    const group = (body as ProjectTestsView).groups.find((item) => item.id === input.groupId);
    const saved = input.caseId
      ? group?.cases.find((item) => item.id === input.caseId)
      : group?.cases.filter((item) => item.title === input.title).at(-1);
    return { groupId: input.groupId, caseId: saved?.id ?? input.caseId ?? null };
  },
  page: (input) => testsPage(input.projectPath, 'library'),
});

const groupInput = z.object({
  projectPath,
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .describe('Group id = file name: latin lowercase, digits, dashes. Existing id → edit title'),
  title: text(200),
  description: text(2000),
});

const saveTestGroup = definePanelAction({
  name: 'save_test_group',
  section: 'tests',
  risk: 'change',
  title: 'journal-save-test-group',
  description:
    'Create a test group (one file of cases) or change the title/description of an existing one. ' +
    'The id never changes. Needs the human’s confirmation.',
  input: groupInput,
  route: async (input, inject) => {
    const exists = (await viewOf(inject, input.projectPath)).groups.some(
      (item) => item.id === input.id,
    );
    return {
      method: 'POST',
      url: exists ? '/api/project-tests/group/update' : '/api/project-tests/group',
      body: {
        path: input.projectPath,
        id: input.id,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    };
  },
  fingerprint: async (input, inject) => {
    const group = (await viewOf(inject, input.projectPath)).groups.find(
      (item) => item.id === input.id,
    );
    return fingerprintOf(group ? { title: group.title, description: group.description } : null);
  },
  preview: async (input, inject) => {
    const group = (await viewOf(inject, input.projectPath)).groups.find(
      (item) => item.id === input.id,
    );
    const before = group ? { title: group.title, description: group.description ?? '' } : {};
    const after = {
      title: input.title ?? group?.title ?? input.id,
      description: input.description ?? group?.description ?? '',
    };
    return stateCard(
      group?.file ?? `.agent/tests/${input.id}.tests.json`,
      before,
      after,
      card(group ? 'summary-save-test-group-update' : 'summary-save-test-group-create', {
        title: after.title,
      }),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: (input) => ({ groupId: input.id }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

const deleteTestGroup = definePanelAction({
  name: 'delete_test_group',
  section: 'tests',
  risk: 'danger',
  title: 'journal-delete-test-group',
  description:
    'Delete a whole test group: its file with every case (run history keeps past results). ' +
    'Cannot be undone from the panel. Needs the human’s confirmation.',
  input: z.object({ projectPath, id: groupId }),
  route: (input) => ({
    method: 'DELETE',
    url: `/api/project-tests/group?${testsQuery(input.projectPath)}&id=${encode(input.id)}`,
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await groupOf(inject, input.projectPath, input.id)).cases),
  preview: async (input, inject) => {
    const group = await groupOf(inject, input.projectPath, input.id);
    return stateCard(
      group.file,
      { title: group.title, cases: group.cases.map((item) => `${item.id} ${item.title}`) },
      {},
      card('summary-delete-test-group', { title: group.title, count: group.cases.length }),
      [dataField('label-project', input.projectPath), dataField('label-file', group.file)],
    );
  },
  shape: () => ({ deleted: true }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

async function pendingDraft(inject: InjectRoute, path: string, runId: string) {
  const { drafts } = await readRoute<{ drafts: ProjectTestDraft[] }>(
    inject,
    `/api/project-tests/drafts?${testsQuery(path)}&runId=${encode(runId)}`,
  );
  const draft = drafts[0];
  if (!draft) throw new Error(`Draft «${runId}» not found. Call list_test_groups.`);
  const items = draft.items.filter((item) => (item.state ?? 'pending') === 'pending');
  if (items.length === 0) throw new Error(`Draft «${runId}» has nothing pending.`);
  return { draft, items };
}

const rejectDraft = definePanelAction({
  name: 'reject_draft',
  section: 'tests',
  risk: 'change',
  title: 'journal-reject-draft',
  description:
    'Reject the pending cases of a generation draft (runId from list_test_groups drafts): none of ' +
    'them reaches the library. Already accepted cases stay. Needs the human’s confirmation.',
  input: z.object({ projectPath, runId: z.string().trim().min(1).describe('Draft runId') }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/draft/reject',
    body: { path: input.projectPath, runId: input.runId },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await pendingDraft(inject, input.projectPath, input.runId)).items),
  preview: async (input, inject) => {
    const { draft, items } = await pendingDraft(inject, input.projectPath, input.runId);
    return stateCard(
      draft.file,
      { pending: items.map((item) => `${item.groupId}/${item.caseId} ${item.testCase.title}`) },
      { pending: [] },
      card('summary-reject-draft', { count: items.length }),
      [dataField('label-project', input.projectPath), dataField('label-draft', draft.file)],
    );
  },
  shape: () => ({ rejected: true }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

/** Правка библиотеки — в конце списка действий раздела, после чтения и запуска. */
export const TEST_LIBRARY_ACTIONS: readonly AnyPanelAction[] = [
  saveTestCase,
  saveTestGroup,
  deleteTestGroup,
  rejectDraft,
].map((action) => registeredOnly(action));
