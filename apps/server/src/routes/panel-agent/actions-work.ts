import { z } from 'zod';
import type {
  ProjectGitInfo,
  ProjectTestRunRecord,
  ProjectTestsView,
  ProjectWorktreesInfo,
} from '@agentdeck/contracts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, encode, readRoute, stateCard } from './action-kit.ts';
import { findProject } from './actions-projects.ts';
import { dataField } from './texts.ts';

/**
 * Дополнения волны A к проектам и тестам: снятие проекта с учёта, чтение git
 * (только чтение — коммит, ветки и слияние остаются у человека), история
 * прогонов, замечания библиотеки, остановка прогона и удаление кейса.
 */

const projectRef = z
  .string()
  .trim()
  .min(1)
  .describe('Project id or absolute path from list_projects');
const projectPath = z.string().trim().min(1).describe('Absolute project directory');
const query = (path: string): string => `path=${encode(path)}`;

const deleteProject = definePanelAction({
  name: 'delete_project',
  section: 'projects',
  risk: 'danger',
  title: 'journal-delete-project',
  description:
    'Remove a project from the panel registry. Nothing on disk is deleted (files, chats, tests stay). Needs confirmation.',
  input: z.object({ project: projectRef }),
  route: async (input, inject) => ({
    method: 'DELETE',
    url: `/api/projects/${encode((await findProject(inject, input.project)).id)}`,
  }),
  fingerprint: async (input, inject) => fingerprintOf(await findProject(inject, input.project)),
  preview: async (input, inject) => {
    const project = await findProject(inject, input.project);
    return stateCard(
      `state.json: projects/${project.id}`,
      { name: project.name, path: project.path },
      {},
      card('summary-delete-project', { name: project.name }),
      [dataField('label-directory', project.path)],
    );
  },
  page: () => ({ route: '/projects' }),
});

const projectGitStatus = definePanelAction({
  name: 'project_git_status',
  section: 'projects',
  risk: 'read',
  description:
    'Git state of a project directory: branch, local branches, changed files. Read-only.',
  input: z.object({ projectPath }),
  route: (input) => ({ method: 'GET', url: `/api/project-git?${query(input.projectPath)}` }),
  shape: (_input, body) => body as ProjectGitInfo,
  summary: 'journal-project-git-status',
});

const listWorktrees = definePanelAction({
  name: 'list_worktrees',
  section: 'projects',
  risk: 'read',
  description:
    'Parallel working copies of a project repository (path, branch, head, main/locked/prunable).',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'GET',
    url: `/api/project-git/worktrees?${query(input.projectPath)}`,
  }),
  shape: (_input, body) => {
    const info = body as ProjectWorktreesInfo;
    return {
      isRepo: info.isRepo,
      ...(info.error ? { error: info.error } : {}),
      worktrees: info.worktrees.map(
        ({ path, branch, head, isMain, detached, locked, prunable }) => ({
          path,
          branch,
          head,
          isMain,
          detached,
          locked,
          prunable,
        }),
      ),
    };
  },
  summary: 'journal-list-worktrees',
});

const listTestRuns = definePanelAction({
  name: 'list_test_runs',
  section: 'tests',
  risk: 'read',
  description: 'Test run history of a project, newest first: id, mode, status, summary counts.',
  input: z.object({ projectPath, limit: z.number().int().min(1).max(200).default(20) }),
  route: (input) => ({
    method: 'GET',
    url: `/api/project-tests/runs?${query(input.projectPath)}&limit=${input.limit}`,
  }),
  shape: (_input, body) => ({
    runs: ((body as { runs?: ProjectTestRunRecord[] }).runs ?? []).map(
      ({ results, ...record }) => ({
        ...record,
        results: results.length,
      }),
    ),
  }),
  summary: 'journal-list-test-runs',
});

const readTestRun = definePanelAction({
  name: 'read_test_run',
  section: 'tests',
  risk: 'read',
  description: 'One test run with its per-case results (status, comment) by run id.',
  input: z.object({ projectPath, runId: z.string().min(1) }),
  route: (input) => ({
    method: 'GET',
    url: `/api/project-tests/run?${query(input.projectPath)}&id=${encode(input.runId)}`,
  }),
  summary: 'journal-read-test-run',
});

const lintTests = definePanelAction({
  name: 'lint_tests',
  section: 'tests',
  risk: 'read',
  description:
    'Library lint of a project’s test cases: issues (missing steps, stale) and duplicates.',
  input: z.object({ projectPath }),
  route: (input) => ({ method: 'GET', url: `/api/project-tests/lint?${query(input.projectPath)}` }),
  summary: 'journal-lint-tests',
});

const viewOf = (inject: InjectRoute, path: string) =>
  readRoute<ProjectTestsView>(inject, `/api/project-tests?${query(path)}`);

const stopTests = definePanelAction({
  name: 'stop_tests',
  section: 'tests',
  risk: 'change',
  title: 'journal-stop-tests',
  description:
    'Stop the running test agent of a project. Statuses already written stay. Needs confirmation.',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/stop',
    body: { path: input.projectPath },
  }),
  fingerprint: async (input, inject) => {
    const run = (await viewOf(inject, input.projectPath)).run;
    return fingerprintOf(run ? { id: run.id, status: run.status } : null);
  },
  preview: async (input, inject) => {
    const run = (await viewOf(inject, input.projectPath)).run;
    if (!run || run.status !== 'running') throw new Error('No test run is going in this project.');
    return stateCard(
      `tests/run/${run.id}`,
      { status: run.status },
      { status: 'stopped' },
      card('summary-stop-tests', { mode: run.mode }),
      [dataField('label-directory', input.projectPath)],
    );
  },
  shape: (_input, body) => {
    const run = (body as ProjectTestsView).run;
    return { run: run ? { id: run.id, status: run.status } : null };
  },
  page: () => ({ route: '/tests' }),
});

async function findCase(inject: InjectRoute, path: string, groupId: string, caseId: string) {
  const group = (await viewOf(inject, path)).groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Test group «${groupId}» not found. Call list_test_groups.`);
  const found = group.cases.find((item) => item.id === caseId);
  if (!found) throw new Error(`Case «${caseId}» is not in group «${groupId}». Call list_cases.`);
  return { group, found };
}

const deleteTestCase = definePanelAction({
  name: 'delete_test_case',
  section: 'tests',
  risk: 'danger',
  title: 'journal-delete-test-case',
  description:
    'Delete one test case from its group file (run history keeps its past results). Prefer archiving via the human. Needs confirmation.',
  input: z.object({ projectPath, groupId: z.string().min(1), caseId: z.string().min(1) }),
  route: (input) => ({
    method: 'DELETE',
    url:
      `/api/project-tests/case?${query(input.projectPath)}` +
      `&groupId=${encode(input.groupId)}&caseId=${encode(input.caseId)}`,
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await findCase(inject, input.projectPath, input.groupId, input.caseId)).found),
  preview: async (input, inject) => {
    const { group, found } = await findCase(inject, input.projectPath, input.groupId, input.caseId);
    return stateCard(
      `${group.file}#${found.id}`,
      found,
      {},
      card('summary-delete-test-case', { title: found.title }),
      [dataField('label-file', group.file)],
    );
  },
  shape: () => ({ deleted: true }),
  page: (input) => ({ route: '/tests', focus: input.groupId }),
});

export const WORK_ACTIONS: readonly AnyPanelAction[] = [
  deleteProject,
  projectGitStatus,
  listWorktrees,
  listTestRuns,
  readTestRun,
  lintTests,
  stopTests,
  deleteTestCase,
];
