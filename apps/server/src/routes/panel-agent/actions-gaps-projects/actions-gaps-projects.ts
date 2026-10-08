import { z } from 'zod';
import type {
  ProjectFileChanges,
  ProjectLocalConfig,
  WorktreeBootstrapState,
} from '@agentdeck/contracts';
import { definePanelAction, type AnyPanelAction } from '../registry.ts';
import { encode, OFFSET_DESCRIPTION, textWindow } from '../action-kit/action-kit.ts';
import { findChat, maskedTitle } from '../actions-chat-kit.ts';
import { maskCode } from '../actions-project-runner/actions-project-runner.ts';
import { assertRegistered } from '../registered-folder/registered-folder.ts';
import { copyRef, projectRef, resolveTarget } from '../project-target.ts';
import { maskResult } from '../result-net/result-net.ts';

/**
 * Чтения проекта, которых агенту не хватало (дорожка A, 28.09): что агент
 * чата поменял в коде за разговор, полный лог установки рабочей копии и
 * собственный `.claude` проекта — то, что Claude Code подхватит из репозитория
 * поверх пользовательского. Всё — маршрутами окна проекта и только у проектов
 * панели и их git-копий: папку вне реестра агент не читает (U4b).
 */

/** Чат для «что поменял агент» — между `route` и `shape` одного вызова. */
const chatOf = new WeakMap<object, { id: string; title: string; path: string }>();

const readProjectChanges = definePanelAction({
  name: 'read_project_changes',
  section: 'projects',
  risk: 'read',
  description:
    'Which files of its project the agent of one chat changed during that conversation, with ' +
    '+/- line counts (the chat’s «changes» view in the code window). Works for chats of panel ' +
    'projects and their git copies; read one file with read_project_file.',
  input: z.object({
    chat: z
      .string()
      .min(1)
      .describe('Chat id (from list_chats / search_chats / read_chat) or its exact title'),
  }),
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    if (chat.isSandbox || !chat.projectPath) {
      throw new Error(
        `Chat «${maskedTitle(chat)}» lives in the panel itself, without a project: it changed no project files.`,
      );
    }
    // Сырой путь из записи чата: только проект панели или его git-копия.
    await assertRegistered(inject, chat.projectPath, { copies: true });
    chatOf.set(input, { id: chat.id, title: maskedTitle(chat), path: chat.projectPath });
    return {
      method: 'GET',
      url: `/api/project-files/changes?path=${encode(chat.projectPath)}&chatId=${encode(chat.id)}`,
    };
  },
  shape: (input, body) => {
    const changes = body as ProjectFileChanges;
    const chat = chatOf.get(input);
    return maskResult({
      ...(chat ? { chat: chat.id, title: chat.title, folder: chat.path } : {}),
      files: changes.files.map((file) => ({
        path: file.path,
        added: file.added,
        removed: file.removed,
        ...(file.missing ? { missing: true } : {}),
      })),
      ...(changes.skipped ? { skipped: changes.skipped } : {}),
    });
  },
  summary: 'journal-read-project-changes',
});

/** Сколько знаков хвоста лога отдавать, если модель не назвала смещение. */
const LOG_TAIL = 12_000;

const readWorktreeBootstrapLog = definePanelAction({
  name: 'read_worktree_bootstrap_log',
  section: 'projects',
  risk: 'read',
  description:
    'Full log of the last dependency install (bootstrap) of one working copy of a project, with ' +
    'its state (running / ok / failed, exit code). Without offset you get the tail; pass ' +
    'offset (nextOffset) to read from a position. Secrets in the log are masked.',
  input: z.object({
    project: projectRef,
    copy: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Absolute path of the working copy (list_worktrees); the main copy has no install log',
      ),
    offset: z.number().int().nonnegative().optional().describe(OFFSET_DESCRIPTION),
  }),
  route: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    if (!target.copy) {
      throw new Error(
        'This is the project itself, not one of its working copies: only copies have an install log. ' +
          'Call list_worktrees for the copies.',
      );
    }
    return {
      method: 'GET',
      url: `/api/project-git/worktrees/bootstrap-log?path=${encode(target.project.path)}&worktreePath=${encode(target.copy)}`,
    };
  },
  shape: (input, body) => {
    const answer = body as { log: string; state: WorktreeBootstrapState | null };
    const log = maskCode(answer.log);
    const state = answer.state;
    return {
      state: state
        ? {
            command: maskCode(state.command),
            status: state.status,
            startedAt: state.startedAt,
            ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
            ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
            ...(state.timedOut ? { timedOut: true } : {}),
            ...(state.reverted?.length ? { reverted: state.reverted } : {}),
          }
        : null,
      ...(log
        ? { log: textWindow(log, input.offset ?? Math.max(0, log.length - LOG_TAIL)) }
        : { log: null, note: 'No install has run in this copy yet.' }),
    };
  },
  summary: 'journal-read-worktree-bootstrap-log',
});

const BODY_PREVIEW = 300;

const readProjectLocalConfig = definePanelAction({
  name: 'read_project_local_config',
  section: 'projects',
  risk: 'read',
  description:
    'What Claude Code picks up from the project’s own .claude folder on top of the user’s ' +
    'configuration: project skills, hooks (.claude/settings.json and settings.local.json) and ' +
    'rules (.claude/rules/**.md, with their path masks). Read-only — this folder belongs to the ' +
    'project’s git; read a whole rule with read_project_file.',
  input: z.object({ project: projectRef, copy: copyRef }),
  route: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    // Сам проект — по id реестра (как вкладка проекта); копия — по её пути
    // (как группа, привязанная к папке): у копии записи в реестре нет.
    if (!target.copy) {
      return { method: 'GET', url: `/api/projects/${encode(target.project.id)}/local` };
    }
    return { method: 'GET', url: `/api/projects/local?path=${encode(target.dir)}` };
  },
  shape: (_input, body) => {
    const local = body as ProjectLocalConfig;
    return maskResult({
      root: local.root,
      exists: local.exists,
      skills: local.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        ...(skill.isEnabled ? {} : { disabled: true }),
      })),
      hooks: local.hooks.map((hook) => ({
        event: hook.event,
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        command: maskCode(hook.command),
      })),
      rules: local.rules.map((rule) => ({
        path: rule.path,
        title: rule.title,
        ...(rule.paths.length ? { paths: rule.paths } : {}),
        sizeBytes: rule.sizeBytes,
        // Маска до обрезки: ключ на границе иначе уходил бы половиной (ревью сит).
        start: maskCode(rule.body).slice(0, BODY_PREVIEW),
      })),
    });
  },
  summary: 'journal-read-project-local-config',
});

/** Чтения проекта дорожки A в порядке показа. */
export const GAPS_PROJECT_ACTIONS: readonly AnyPanelAction[] = [
  readProjectChanges,
  readWorktreeBootstrapLog,
  readProjectLocalConfig,
];
