import { z } from 'zod';
import type {
  ProjectGitInfo,
  ProjectGitResult,
  ProjectWorktreesResult,
  WorktreeMirrorSettings,
  Project,
} from '@agentdeck/contracts';
import type { PanelActionPreviewField } from '@agentdeck/contracts/panel-agent';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';
import { bootstrapPlanFor } from '../../../domains/project-git/bootstrap.ts';
import { commitContentPrint } from '../../../domains/project-git/content-print.ts';
import { worktreeDirFor } from '../../../domains/project-git/worktrees.ts';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import {
  card,
  encode,
  literalSecrets,
  maskDeep,
  readRoute,
  SECRET_REFUSAL,
  stateCard,
} from '../action-kit/action-kit.ts';
import {
  copyRef,
  findCopy,
  pageFor,
  projectOf,
  projectRef,
  resolveTarget,
  targetLabel,
  worktreesOf,
  type ProjectTarget,
} from '../project-target.ts';
import { dataField, textField } from '../texts/texts.ts';

/**
 * Git и рабочие копии проекта (U4a): ветка, коммит, pull, копии под ветку и
 * их настройки. Исполняются маршрутами пульта git вкладки проекта
 * (`/api/project-git/*`) — те же проверки каталога, тот же отказ удалять копию
 * из-под идущего агента. Отправка на сервер (`push`) агенту НЕ дана: это
 * наружу и необратимо — кнопка «Отправить» остаётся у человека, и карточка
 * коммита говорит об этом прямо. Разрешения групп разделения (`permissions`)
 * агент тоже не пишет: это решение человека о том, что группы делают без него.
 */

const gitUrl = (dir: string) => `/api/project-git?path=${encode(dir)}`;

const readGit = (inject: InjectRoute, dir: string) =>
  readRoute<ProjectGitInfo>(inject, gitUrl(dir));

const gitTargetInput = { project: projectRef, copy: copyRef };

/** Каталог цели — репозиторий, иначе отказ до карточки. */
async function gitOf(inject: InjectRoute, target: ProjectTarget): Promise<ProjectGitInfo> {
  const info = await readGit(inject, target.dir);
  if (info.error) throw new Error(`Git is unavailable in «${target.dir}»: ${info.error}`);
  if (!info.isRepo) throw new Error(`«${target.dir}» is not a git repository.`);
  return info;
}

/** Состояние, из которого посчитана карточка git: сверяется перед исполнением. */
const gitPrint = (info: ProjectGitInfo) =>
  fingerprintOf({
    branch: info.branch ?? null,
    branches: info.branches,
    changed: info.changedFiles,
    dirty: info.dirtyCount,
    lines: [info.insertions ?? null, info.deletions ?? null],
    sync: [info.ahead ?? null, info.behind ?? null],
    remote: info.remote ?? null,
  });

/** Итог записи git для модели: ветка, число правок и вывод git — маской. */
const gitResult = (_input: unknown, body: unknown) => {
  const result = body as ProjectGitResult;
  return {
    branch: result.info.branch ?? null,
    dirtyCount: result.info.dirtyCount,
    ...(result.info.ahead !== undefined ? { ahead: result.info.ahead } : {}),
    output: maskSecretsInText(result.output ?? ''),
  };
};

const targetField = (target: ProjectTarget) => dataField('label-project', targetLabel(target));

const branchName = z.string().trim().min(1).max(200);

const gitCheckout = definePanelAction({
  name: 'git_checkout',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-git-checkout',
  description:
    'Switch a project (or one of its working copies) to an EXISTING local branch (project_git_status lists them). ' +
    'Uncommitted changes travel with it or git refuses. Needs confirmation.',
  input: z.object({ ...gitTargetInput, branch: branchName }),
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-git/checkout',
    body: { path: (await resolveTarget(inject, input)).dir, branch: input.branch },
  }),
  fingerprint: async (input, inject) =>
    gitPrint(await gitOf(inject, await resolveTarget(inject, input))),
  preview: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    const info = await gitOf(inject, target);
    if (!info.branches.includes(input.branch)) {
      throw new Error(
        `There is no local branch «${input.branch}». To make a new one use git_create_branch.`,
      );
    }
    if (info.branch === input.branch) {
      throw new Error(`Nothing would change: «${input.branch}» is already checked out.`);
    }
    return stateCard(
      `git: ${target.dir}`,
      { branch: info.branch ?? null, uncommittedFiles: info.dirtyCount },
      { branch: input.branch, uncommittedFiles: info.dirtyCount },
      card('summary-project-git-checkout', { branch: input.branch, project: target.project.name }),
      [targetField(target)],
    );
  },
  shape: gitResult,
  page: (input) => pageFor(input),
});

const gitCreateBranch = definePanelAction({
  name: 'git_create_branch',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-git-branch',
  description:
    'Create a new branch from the current HEAD of a project (or one of its working copies) and switch to it. Needs confirmation.',
  input: z.object({ ...gitTargetInput, name: branchName }),
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-git/branch',
    body: { path: (await resolveTarget(inject, input)).dir, name: input.name },
  }),
  fingerprint: async (input, inject) =>
    gitPrint(await gitOf(inject, await resolveTarget(inject, input))),
  preview: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    const info = await gitOf(inject, target);
    if (info.branches.includes(input.name)) {
      throw new Error(`Branch «${input.name}» already exists; switch to it with git_checkout.`);
    }
    return stateCard(
      `git: ${target.dir}`,
      { branch: info.branch ?? null },
      { branch: input.name, from: info.branch ?? 'HEAD' },
      card('summary-project-git-branch', { branch: input.name, project: target.project.name }),
      [targetField(target)],
    );
  },
  shape: gitResult,
  page: (input) => pageFor(input),
});

/** Сколько путей показать в карточке коммита; остальное — числом. */
const COMMIT_FILES_SHOWN = 60;

const commitFiles = (info: ProjectGitInfo): string => {
  const shown = info.changedFiles
    .slice(0, COMMIT_FILES_SHOWN)
    .map((file) => `${file.status} ${file.path}`);
  const rest = info.dirtyCount - shown.length;
  return [...shown, ...(rest > 0 ? [`… +${rest}`] : [])].join('\n');
};

function commitMessage(message: string): string {
  if (literalSecrets({ message }).length > 0) throw new Error(`message: ${SECRET_REFUSAL}`);
  return message;
}

const gitCommit = definePanelAction({
  name: 'git_commit',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-git-commit',
  description:
    'Commit ALL changes of a project (or one of its working copies) with a message. The commit stays local: ' +
    'pushing is the human’s button, never yours. Needs confirmation; the card lists the files.',
  input: z.object({ ...gitTargetInput, message: z.string().trim().min(1).max(5000) }),
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-git/commit',
    body: { path: (await resolveTarget(inject, input)).dir, message: commitMessage(input.message) },
  }),
  // Кроме статуса — текст каждого файла, который заберёт `add -A`: правка с тем
  // же числом строк статус не меняет, а закоммитилось бы уже не одобренное.
  fingerprint: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    return fingerprintOf({
      git: gitPrint(await gitOf(inject, target)),
      content: await commitContentPrint(target.dir),
    });
  },
  preview: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    const info = await gitOf(inject, target);
    const message = commitMessage(input.message);
    if (info.dirtyCount === 0) throw new Error('Nothing would change: there is nothing to commit.');
    const lines =
      info.insertions !== undefined ? ` (+${info.insertions} −${info.deletions ?? 0})` : '';
    return {
      ...card('summary-project-git-commit', {
        count: info.dirtyCount,
        branch: info.branch ?? 'HEAD',
        project: target.project.name,
      }),
      fields: [
        targetField(target),
        dataField('label-project-git-branch', info.branch ?? 'HEAD'),
        dataField('label-project-git-message', message),
        dataField('label-project-git-files', `${commitFiles(info)}${lines}`),
        textField('label-note', 'value-project-git-push-human'),
      ],
    };
  },
  shape: gitResult,
  page: (input) => pageFor(input),
});

const gitPull = definePanelAction({
  name: 'git_pull',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-git-pull',
  description:
    'Pull commits from the remote into a project (or one of its working copies): current branch, or `branch` ' +
    'from remoteBranches of project_git_status. Needs confirmation.',
  input: z.object({ ...gitTargetInput, branch: branchName.optional() }),
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-git/pull',
    body: {
      path: (await resolveTarget(inject, input)).dir,
      ...(input.branch ? { branch: input.branch } : {}),
    },
  }),
  fingerprint: async (input, inject) =>
    gitPrint(await gitOf(inject, await resolveTarget(inject, input))),
  preview: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    const info = await gitOf(inject, target);
    if (!info.remote) throw new Error('This repository has no remote to pull from.');
    if (input.branch && !info.remoteBranches.includes(input.branch)) {
      throw new Error(
        `The remote «${info.remote}» has no branch «${input.branch}». See remoteBranches of project_git_status.`,
      );
    }
    const fields: PanelActionPreviewField[] = [
      targetField(target),
      dataField('label-project-git-branch', info.branch ?? 'HEAD'),
      dataField('label-project-git-source', `${info.remote}/${input.branch ?? info.branch ?? ''}`),
    ];
    return {
      ...card('summary-project-git-pull', { project: target.project.name }),
      fields,
    };
  },
  shape: gitResult,
  page: (input) => pageFor(input),
});

// --- Рабочие копии ---

const mirrorUrl = (project: Project) =>
  `/api/project-git/mirror-settings?path=${encode(project.path)}`;

const readMirror = (inject: InjectRoute, project: Project) =>
  readRoute<WorktreeMirrorSettings>(inject, mirrorUrl(project));

/** Итог операции над копиями для модели: копии и вывод git — маской. */
const worktreesResult = (_input: unknown, body: unknown) => {
  const result = body as ProjectWorktreesResult;
  return {
    ...(result.createdPath ? { createdPath: result.createdPath } : {}),
    output: maskSecretsInText(result.output ?? ''),
    worktrees: result.info.worktrees.map((item) => ({
      path: item.path,
      branch: item.branch ?? null,
      isMain: item.isMain,
      ...(item.bootstrap ? { bootstrap: item.bootstrap.status } : {}),
      ...(item.copy ? { ready: item.copy.ready } : {}),
    })),
    ...(result.mirror
      ? {
          mirror: maskDeep({
            mirrored: result.mirror.mirrored.length,
            skipped: result.mirror.skipped.length,
            kept: result.mirror.kept,
            gaps: result.mirror.gaps ?? [],
          }),
        }
      : {}),
  };
};

const worktreesPrint = async (inject: InjectRoute, project: Project) =>
  fingerprintOf({
    worktrees: (await worktreesOf(inject, project)).worktrees.map((item) => [
      item.path,
      item.branch ?? null,
      item.head ?? null,
      item.bootstrap?.status ?? null,
    ]),
    mirror: await readMirror(inject, project),
  });

const installField = (command: string | undefined) =>
  command
    ? dataField('label-project-worktree-install', maskSecretsInText(command))
    : textField('label-project-worktree-install', 'value-project-worktree-install-none');

const addWorktree = definePanelAction({
  name: 'add_worktree',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-worktree-add',
  description:
    'Create a working copy of a project for a branch (existing or new): its own folder beside the project, ' +
    'the local layer copied in, then the install command runs in the background. Needs confirmation.',
  input: z.object({ project: projectRef, branch: branchName }),
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/project-git/worktrees/add',
    body: { path: (await projectOf(inject, input)).path, name: input.branch },
  }),
  fingerprint: async (input, inject) => worktreesPrint(inject, await projectOf(inject, input)),
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const info = await worktreesOf(inject, project);
    if (!info.isRepo) throw new Error(`«${project.path}» is not a git repository.`);
    const taken = info.worktrees.find((item) => item.branch === input.branch);
    if (taken) {
      throw new Error(`Branch «${input.branch}» already has a working copy at «${taken.path}».`);
    }
    const dir = worktreeDirFor(project.path, input.branch);
    const mirror = await readMirror(inject, project);
    return stateCard(
      `worktrees: ${project.path}`,
      { copies: info.worktrees.filter((item) => !item.isMain).map((item) => item.path) },
      {
        copies: [...info.worktrees.filter((item) => !item.isMain).map((item) => item.path), dir],
      },
      card('summary-project-worktree-add', { branch: input.branch, project: project.name }),
      [
        dataField('label-project', `${project.name} — ${project.path}`),
        dataField('label-project-worktree-path', dir),
        installField(bootstrapPlanFor(project.path, mirror.bootstrap)?.summary),
      ],
    );
  },
  shape: worktreesResult,
  page: (input) => pageFor(input),
});

const copyInput = z.object({
  project: projectRef,
  copy: z
    .string()
    .trim()
    .min(1)
    .describe('Absolute path of the working copy (list_worktrees), never the project itself'),
});

const removeWorktree = definePanelAction({
  name: 'remove_worktree',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-worktree-remove',
  description:
    'Remove a working copy of a project (its folder; the branch stays). Refused while an agent works there; ' +
    'force = drop its uncommitted changes too. Needs confirmation.',
  input: copyInput.extend({ force: z.boolean().optional() }),
  route: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    return {
      method: 'POST',
      url: '/api/project-git/worktrees/remove',
      body: { path: project.path, worktreePath: copy.path, force: input.force === true },
    };
  },
  fingerprint: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    const git = await readGit(inject, copy.path);
    return fingerprintOf({ copy: [copy.path, copy.branch, copy.head], git: gitPrint(git) });
  },
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    const git = await readGit(inject, copy.path);
    return stateCard(
      `worktrees: ${project.path}`,
      { copy: copy.path, branch: copy.branch ?? null, uncommittedFiles: git.dirtyCount },
      {},
      card('summary-project-worktree-remove', { path: copy.path }),
      [
        dataField('label-project', `${project.name} — ${project.path}`),
        dataField('label-project-git-branch', copy.branch ?? 'HEAD'),
        ...(input.force === true && git.dirtyCount > 0
          ? [textField('label-warning', 'value-project-worktree-force')]
          : []),
      ],
    );
  },
  shape: worktreesResult,
  page: (input) => pageFor(input),
});

const bootstrapWorktree = definePanelAction({
  name: 'bootstrap_worktree',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-worktree-bootstrap',
  description:
    'Run the install command again in a working copy (after a failure or a changed command); it runs in the ' +
    'background, see list_worktrees for its status. Needs confirmation.',
  input: copyInput,
  route: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    return {
      method: 'POST',
      url: '/api/project-git/worktrees/bootstrap',
      body: { path: project.path, worktreePath: copy.path },
    };
  },
  fingerprint: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    const mirror = await readMirror(inject, project);
    return fingerprintOf({
      command: bootstrapPlanFor(copy.path, mirror.bootstrap)?.summary ?? null,
      status: copy.bootstrap?.status ?? null,
    });
  },
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    if (copy.bootstrap?.status === 'running') {
      throw new Error('The install is already running in this copy.');
    }
    const mirror = await readMirror(inject, project);
    const command = bootstrapPlanFor(copy.path, mirror.bootstrap)?.summary;
    if (!command) {
      throw new Error(
        'There is no install command: none set on the project and no lockfile in the copy.',
      );
    }
    return {
      ...card('summary-project-worktree-bootstrap', { path: copy.path }),
      fields: [
        dataField('label-project', `${project.name} — ${project.path}`),
        installField(command),
      ],
    };
  },
  shape: worktreesResult,
  page: (input) => pageFor(input),
});

const mirrorWorktree = definePanelAction({
  name: 'mirror_worktree',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-worktree-mirror',
  description:
    'Bring the project’s local layer (git-ignored config, .mcp.json, templates) into an existing working copy ' +
    'again — only what is older in the copy; its own edits stay. Needs confirmation.',
  input: copyInput,
  route: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    return {
      method: 'POST',
      url: '/api/project-git/worktrees/mirror',
      body: { path: project.path, worktreePath: copy.path },
    };
  },
  fingerprint: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    return fingerprintOf({ copy: copy.path, mirror: await readMirror(inject, project) });
  },
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const copy = await findCopy(inject, project, input.copy);
    const gaps = copy.copy?.gaps ?? [];
    return {
      ...card('summary-project-worktree-mirror', { path: copy.path }),
      fields: [
        dataField('label-project', `${project.name} — ${project.path}`),
        ...(gaps.length > 0
          ? [dataField('label-what-happens', JSON.stringify(maskDeep(gaps)))]
          : []),
      ],
    };
  },
  shape: worktreesResult,
  page: (input) => pageFor(input),
});

// --- Настройки копий и разделения ---

const splitUrl = (project: Project) =>
  `/api/project-git/split-settings?path=${encode(project.path)}`;

const readSplit = (inject: InjectRoute, project: Project) =>
  readRoute<SplitSettingsView>(inject, splitUrl(project));

const readProjectCopySettings = definePanelAction({
  name: 'read_project_copy_settings',
  section: 'projects',
  risk: 'read',
  description:
    'Working-copy and split settings of one project: extra mirror patterns (include/exclude), the install ' +
    'command after a copy is made, delivery of split groups to a merge request and how many groups run at once. ' +
    'groupPermissions are shown for reading only — the human sets them.',
  input: z.object({ project: projectRef }),
  route: async (input, inject) => ({
    method: 'GET',
    url: mirrorUrl(await projectOf(inject, input)),
  }),
  afterRoute: async (input, body, inject) => ({
    mirror: body as WorktreeMirrorSettings,
    split: await readSplit(inject, await projectOf(inject, input)),
  }),
  shape: (_input, body) => {
    const { mirror, split } = body as { mirror: WorktreeMirrorSettings; split: SplitSettingsView };
    return maskDeep({
      mirror,
      split: {
        deliver: split.deliver,
        parallel: split.parallel,
        parallelAuto: split.parallelAuto,
        profile: split.profile,
        groupPermissions: split.permissions,
      },
    });
  },
  summary: 'journal-project-copy-settings',
});

const patterns = z.array(z.string().trim().min(1).max(400)).max(200);

const saveProjectMirrorSettings = definePanelAction({
  name: 'save_project_mirror_settings',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-mirror-settings',
  description:
    'Change the working-copy settings of one project: include/exclude = extra mirror patterns (.gitignore ' +
    'syntax, the whole list), bootstrap = the command run in every NEW copy ("" = detect by lockfile). ' +
    'Omitted fields stay. Needs confirmation.',
  input: z.object({
    project: projectRef,
    include: patterns.optional(),
    exclude: patterns.optional(),
    bootstrap: z.string().max(2000).optional(),
  }),
  route: async (input, inject) => {
    const project = await projectOf(inject, input);
    return {
      method: 'PUT',
      url: '/api/project-git/mirror-settings',
      body: { path: project.path, ...nextMirror(input, await readMirror(inject, project)) },
    };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf(await readMirror(inject, await projectOf(inject, input))),
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const current = await readMirror(inject, project);
    const next = nextMirror(input, current);
    return stateCard(
      `worktree-mirror: ${project.path}`,
      current,
      next,
      card('summary-project-mirror-settings', { project: project.name }),
      [
        dataField('label-project', `${project.name} — ${project.path}`),
        ...(input.bootstrap !== undefined ? [installField(next.bootstrap)] : []),
      ],
    );
  },
  page: (input) => pageFor(input),
});

function nextMirror(
  input: { include?: string[]; exclude?: string[]; bootstrap?: string },
  current: WorktreeMirrorSettings,
): WorktreeMirrorSettings {
  if (input.bootstrap && literalSecrets({ bootstrap: input.bootstrap }).length > 0) {
    throw new Error(`bootstrap: ${SECRET_REFUSAL}`);
  }
  const bootstrap = (input.bootstrap ?? current.bootstrap ?? '').trim();
  return {
    include: input.include ?? current.include,
    exclude: input.exclude ?? current.exclude,
    ...(bootstrap ? { bootstrap } : {}),
  };
}

const saveProjectSplitSettings = definePanelAction({
  name: 'save_project_split_settings',
  section: 'projects',
  risk: 'change',
  title: 'journal-project-split-settings',
  description:
    'Change how task splits run in one project: deliver = take each group to a merge request with the project ' +
    'delivery skill; parallel = how many groups work at once (null = the shared default). Group permissions ' +
    'are the human’s and are not changed here. Needs confirmation.',
  input: z.object({
    project: projectRef,
    deliver: z.boolean().optional(),
    parallel: z.number().int().min(1).max(30).nullable().optional(),
  }),
  route: async (input, inject) => {
    const project = await projectOf(inject, input);
    return {
      method: 'PUT',
      url: '/api/project-git/split-settings',
      // Без поля `permissions`: маршрут тогда строки разрешений не трогает.
      body: { path: project.path, ...nextSplit(input, await readSplit(inject, project)) },
    };
  },
  fingerprint: async (input, inject) => {
    const split = await readSplit(inject, await projectOf(inject, input));
    return fingerprintOf({
      deliver: split.deliver,
      parallel: split.parallel,
      auto: split.parallelAuto,
    });
  },
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const current = await readSplit(inject, project);
    const next = nextSplit(input, current);
    return stateCard(
      `split-settings: ${project.path}`,
      { deliver: current.deliver, parallel: current.parallelAuto ? 'auto' : current.parallel },
      { deliver: next.deliver, parallel: next.parallel ?? 'auto' },
      card('summary-project-split-settings', { project: project.name }),
      [dataField('label-project', `${project.name} — ${project.path}`)],
    );
  },
  shape: (_input, body) => {
    const view = body as SplitSettingsView;
    return { deliver: view.deliver, parallel: view.parallel, parallelAuto: view.parallelAuto };
  },
  page: (input) => pageFor(input),
});

function nextSplit(
  input: { deliver?: boolean; parallel?: number | null },
  current: SplitSettingsView,
): { deliver: boolean; parallel: number | null } {
  return {
    deliver: input.deliver ?? current.deliver,
    parallel:
      input.parallel === undefined
        ? current.parallelAuto
          ? null
          : current.parallel
        : input.parallel,
  };
}

/** Действия git и копий проекта: чтение настроек, затем записи. */
export const PROJECT_GIT_ACTIONS: readonly AnyPanelAction[] = [
  readProjectCopySettings,
  gitCheckout,
  gitCreateBranch,
  gitCommit,
  gitPull,
  addWorktree,
  removeWorktree,
  bootstrapWorktree,
  mirrorWorktree,
  saveProjectMirrorSettings,
  saveProjectSplitSettings,
];
