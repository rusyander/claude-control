import { z } from 'zod';
import type {
  ProjectTestDefectDraft,
  ProjectTestDraft,
  ProjectTestE2eFolder,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { encode, readRoute, textWindow } from './action-kit.ts';
import { findProject } from './actions-projects.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import { maskResult } from './result-net.ts';
import { dataField, summaryText, textField } from './texts.ts';
import { testsPage, testsQuery } from './tests-page.ts';
import {
  assertRegistered,
  fitForModel,
  idOf,
  projectPath,
  registeredOnly,
  viewOf,
} from './tests-block-kit.ts';

/**
 * Раздел «Тесты» — то, чего агенту не хватало (дорожка A, 28.09): черновик
 * дефекта по кейсу, статусы заведённых дефектов из трекера, черновики тестов,
 * папка e2e (завести заготовку и убрать заведённую панелью) и группы по
 * умолчанию. Только у проектов из списка панели.
 *
 * Человеку остаются: завести задачу в трекере (`human:outward`), снять
 * эталонный скриншот (`human:upload`) и убрать папку e2e ВМЕСТЕ с чужими
 * файлами (`force` не шлётся никогда).
 */

// ── draft_defect ──────────────────────────────────────────────────────────

const draftDefect = definePanelAction({
  name: 'draft_defect',
  section: 'tests',
  risk: 'read',
  description:
    'Draft of a defect for one test case: title and body built from the case, its last result ' +
    'and the run (environment, branch, commit, log tail of a live run), plus the trackers it ' +
    'could be filed to. Nothing is filed: filing is the human’s button.',
  input: z.object({
    projectPath,
    groupId: idOf('Group id'),
    caseId: idOf('Case id'),
    runId: idOf('Run id whose result to describe (read_tests_report kind=history)').optional(),
    offset: z.number().int().min(0).default(0).describe('Body window: pass nextOffset'),
  }),
  route: async (input, inject) => {
    // Карточки у чтения нет — проект проверяется здесь (см. `registeredOnly`).
    await assertRegistered(inject, input.projectPath);
    return {
      method: 'POST',
      url: '/api/project-tests/defect',
      body: {
        path: input.projectPath,
        groupId: input.groupId,
        caseId: input.caseId,
        ...(input.runId ? { runId: input.runId } : {}),
      },
    };
  },
  shape: (input, body) => {
    const draft = (body as { draft: ProjectTestDefectDraft }).draft;
    return maskResult({
      title: draft.title,
      // Маска до окна: ключ на краю окна иначе уходил бы по кускам (ревью сит, 28.09).
      body: textWindow(maskSecretsInText(draft.body), input.offset),
      targets: draft.targets,
      ...(draft.hint ? { hint: draft.hint } : {}),
      note: 'Filing the defect in a tracker is the human’s: ask them to press «Завести».',
    });
  },
  summary: 'journal-draft-defect',
});

// ── refresh_defect_states ─────────────────────────────────────────────────

/** Дефекты кейсов проекта — из вида раздела, тем же маршрутом, что окно. */
async function defectsOf(inject: InjectRoute, path: string) {
  const view = await viewOf(inject, path);
  return view.groups.flatMap((group) =>
    group.cases.flatMap((item) =>
      (item.defects ?? []).map((defect) => ({
        group: group.id,
        case: item.id,
        url: defect.url,
        state: defect.state ?? null,
        checkedAt: defect.stateCheckedAt ?? null,
      })),
    ),
  );
}

const projectName = async (inject: InjectRoute, path: string): Promise<string> =>
  (await findProject(inject, path)).name;

const refreshDefectStates = definePanelAction({
  name: 'refresh_defect_states',
  section: 'tests',
  risk: 'change',
  title: 'journal-refresh-defect-states',
  description:
    'Ask the trackers (Jira, GitHub/GitLab) for the state of every defect linked to the ' +
    'project’s cases and record it on the cases (the coverage tab’s «Обновить статусы»). ' +
    'Returns failed cases whose defect is closed — worth a recheck. Nothing changes in the ' +
    'trackers. Needs the human’s confirmation.',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/defects/refresh',
    body: { path: input.projectPath },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await defectsOf(inject, input.projectPath)),
  preview: async (input, inject) => {
    const defects = await defectsOf(inject, input.projectPath);
    if (defects.length === 0) {
      throw new Error('No defect is linked to any case of this project: nothing to refresh.');
    }
    return {
      ...summaryText('summary-refresh-defect-states', {
        name: await projectName(inject, input.projectPath),
      }),
      fields: [
        dataField('label-project', input.projectPath),
        dataField('label-defects-tracked', String(defects.length)),
        textField('label-what-happens', 'value-refresh-defects-effect'),
      ],
    };
  },
  shape: (_input, body) => maskResult(body),
  page: (input) => testsPage(input.projectPath, 'coverage'),
});

// ── list_test_drafts ──────────────────────────────────────────────────────

const draftRow = (draft: ProjectTestDraft) => ({
  runId: draft.runId,
  ...(draft.source ? { source: draft.source } : {}),
  createdAt: draft.createdAt,
  status: draft.status,
  file: draft.file,
  items: draft.items.length,
  ...(draft.error ? { error: draft.error } : {}),
});

const listTestDrafts = definePanelAction({
  name: 'list_test_drafts',
  section: 'tests',
  risk: 'read',
  description:
    'Drafts of test cases the section’s agents proposed (pending, applied, rejected, rolled ' +
    'back) and whether drafts are auto-accepted. With runId — that draft’s proposed cases ' +
    '(operation, group, case, title, reason). Accept or reject with the drafts actions.',
  input: z.object({
    projectPath,
    runId: idOf('Draft (run) id from the list').optional(),
  }),
  route: async (input, inject) => {
    await assertRegistered(inject, input.projectPath);
    return {
      method: 'GET',
      url: `/api/project-tests/drafts?${testsQuery(input.projectPath)}${input.runId ? `&runId=${encode(input.runId)}` : ''}`,
    };
  },
  shape: (input, body) => {
    const answer = body as { drafts: ProjectTestDraft[]; autoAccept: boolean };
    if (!input.runId) {
      return maskResult({ autoAccept: answer.autoAccept, drafts: answer.drafts.map(draftRow) });
    }
    const draft = answer.drafts[0];
    return fitForModel({
      autoAccept: answer.autoAccept,
      ...(draft
        ? {
            draft: draftRow(draft),
            proposed: draft.items.map((item) => ({
              op: item.op,
              groupId: item.groupId,
              caseId: item.caseId,
              title: item.testCase.title,
              ...(item.reason ? { reason: item.reason } : {}),
            })),
          }
        : {}),
    });
  },
  summary: 'journal-list-test-drafts',
});

// ── папка e2e ─────────────────────────────────────────────────────────────

const e2eOf = (inject: InjectRoute, path: string): Promise<ProjectTestE2eFolder> =>
  readRoute<ProjectTestE2eFolder>(inject, `/api/project-tests/e2e?${testsQuery(path)}`);

const e2eRow = (folder: ProjectTestE2eFolder | undefined) =>
  folder
    ? {
        state: folder.state,
        ...(folder.dir ? { dir: folder.dir } : {}),
        framework: folder.framework,
        specs: folder.specs,
        hiddenFromGit: folder.excluded,
      }
    : null;

const createE2eFolder = definePanelAction({
  name: 'create_e2e_folder',
  section: 'tests',
  risk: 'change',
  title: 'journal-create-e2e-folder',
  description:
    'Create the Playwright e2e/ scaffold in a project that has no e2e folder yet, hidden from ' +
    'git via .git/info/exclude (the section’s «Завести папку»). A project with its own e2e ' +
    'folder is left as is. Needs the human’s confirmation.',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/e2e',
    body: { path: input.projectPath },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await e2eOf(inject, input.projectPath)),
  preview: async (input, inject) => {
    const folder = await e2eOf(inject, input.projectPath);
    if (folder.state !== 'missing') {
      throw new Error(
        `Nothing would change: the project already has an e2e folder (${folder.dir ?? 'e2e'}, ${folder.state}).`,
      );
    }
    return {
      ...summaryText('summary-create-e2e-folder', {
        name: await projectName(inject, input.projectPath),
      }),
      fields: [
        dataField('label-project', input.projectPath),
        textField('label-what-happens', 'value-create-e2e-effect'),
      ],
    };
  },
  shape: (_input, body) => ({ e2e: e2eRow((body as ProjectTestsView).e2e) }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

const removeE2eFolder = definePanelAction({
  name: 'remove_e2e_folder',
  section: 'tests',
  risk: 'danger',
  title: 'journal-remove-e2e-folder',
  description:
    'Remove the e2e folder the PANEL created in a project (state created). Refused while ' +
    'autotests run or the section agent writes specs, and when the folder holds files the ' +
    'panel did not put there — removing those is the human’s. A project’s own e2e folder is ' +
    'never removed. Needs the human’s confirmation.',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'DELETE',
    url: `/api/project-tests/e2e?${testsQuery(input.projectPath)}`,
  }),
  fingerprint: async (input, inject) => fingerprintOf(await e2eOf(inject, input.projectPath)),
  preview: async (input, inject) => {
    const folder = await e2eOf(inject, input.projectPath);
    if (folder.state !== 'created') {
      throw new Error(
        folder.state === 'missing'
          ? 'Nothing would change: the project has no e2e folder.'
          : `The e2e folder ${folder.dir ?? ''} is the project’s own, not created by the panel: it is never removed from here.`,
      );
    }
    return {
      ...summaryText('summary-remove-e2e-folder', {
        name: await projectName(inject, input.projectPath),
      }),
      fields: [
        dataField('label-project', `${input.projectPath} — ${folder.dir ?? 'e2e'}`),
        textField('label-what-happens', 'value-remove-e2e-effect'),
      ],
    };
  },
  shape: (_input, body) => ({ e2e: e2eRow((body as ProjectTestsView).e2e) }),
  page: (input) => testsPage(input.projectPath, 'library'),
});

// ── list_default_test_groups ──────────────────────────────────────────────

const listDefaultTestGroups = definePanelAction({
  name: 'list_default_test_groups',
  section: 'tests',
  risk: 'read',
  description:
    'The groups a new test library starts with (id, title, what goes there) — the same set ' +
    'the section offers when a project has no cases yet.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/project-tests/defaults' }),
  shape: (_input, body) => body,
  summary: 'journal-list-default-test-groups',
});

/** Раздел «Тесты» дорожки A; правки — только у проекта из списка панели. */
export const GAPS_TESTS_ACTIONS: readonly AnyPanelAction[] = [
  draftDefect,
  refreshDefectStates,
  listTestDrafts,
  createE2eFolder,
  removeE2eFolder,
  listDefaultTestGroups,
].map((action) => (action.risk === 'read' ? action : registeredOnly(action)));
