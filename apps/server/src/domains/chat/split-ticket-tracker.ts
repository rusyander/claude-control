import type { AppStore } from '../../lib/app-store/app-store.ts';
import { jiraAccessFrom } from '../integrations/atlassian/access.ts';
import {
  applyTransition,
  commentIssue,
  createIssue,
  listProjects,
  listTransitions,
  readIssue,
  readIssueBrief,
  searchIssues,
} from '../integrations/atlassian/jira.ts';
import { listIssueTypes, listPriorities } from '../integrations/atlassian/jira-meta.ts';
import { trimUrl, type AtlassianAccess } from '../integrations/atlassian/client.ts';
import type { OpenTrackerIssue } from './split-ticket-batch/existing.ts';
import type { OneTicketTracker } from './split-ticket-batch/file-one.ts';
import { isConnected, readIntegrations } from '../integrations/store/store.ts';
import { linkForCwd } from '../integrations/links.ts';
import type { TicketTargetTracker } from './split-ticket-batch/target.ts';
import type { SplitTaskTracker } from './split-tasks/split-tasks.ts';
import type { TicketSource } from './task-tickets/task-tickets.types.ts';

/**
 * Трекер для тикетов, предложенных группами разделения (L277): куда их можно
 * завести и чем. Проект трекера — привязка проекта («проект Jira для новых
 * дефектов»), интеграция должна быть подключена; иначе заводить некуда, и хаб
 * оставляет только «Копировать».
 */
export interface SplitTicketTracker extends OneTicketTracker {
  projectOf: (projectPath: string) => string | undefined;
}

/**
 * Сколько открытых задач проекта сверяется перед заведением: последние по
 * обновлению, потолок одного запроса поиска Jira. Старше — не сверяются.
 */
const OPEN_ISSUES_LIMIT = 100;

/** Открытые задачи проекта для сверки — одна выборка у «Завести» строки и у публикации разом. */
async function searchOpenIssues(
  access: AtlassianAccess,
  projectKey: string,
): Promise<OpenTrackerIssue[]> {
  // Ключ проекта Jira — латиница, цифры и `_`; иное в JQL не подставляем.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(projectKey)) return [];
  const found = await searchIssues(access, {
    jql: `project = "${projectKey}" AND statusCategory != Done ORDER BY updated DESC`,
    limit: OPEN_ISSUES_LIMIT,
  });
  return found.map((issue) => ({
    key: issue.key,
    summary: issue.summary,
    description: issue.description ?? '',
  }));
}

/**
 * Хранилище и каталог — геттеры: смена каталога конфига подменяет их в
 * контексте (`context.ts`), и захваченные один раз значения заводили бы
 * тикеты по привязкам и доступу прежнего каталога.
 */
export function atlassianTicketTracker(
  store: () => AppStore,
  appDataDir: () => string,
): SplitTicketTracker {
  const access = () => jiraAccessFrom(store(), appDataDir());
  return {
    projectOf: (projectPath) => {
      const key = linkForCwd(store(), projectPath)?.link.jiraProjectKey?.trim();
      if (!key) return undefined;
      try {
        access();
        return key;
      } catch {
        return undefined;
      }
    },
    searchOpen: (projectKey) => searchOpenIssues(access(), projectKey),
    comment: (key, body) => commentIssue(access(), key, body),
    create: async (projectKey, summary, description) =>
      (await createIssue(access(), { projectKey, summary, description })).key,
  };
}

/**
 * Jira для «Разобрать…» хаба: куда заводить (сайт, проекты, типы задач),
 * приоритеты установки, открытые задачи проекта для сверки, заведение с
 * метками, типом и приоритетом и комментарий в уже открытую задачу.
 * Хранилище и каталог — геттеры по той же причине, что у `atlassianTicketTracker`.
 */
export function atlassianBatchTracker(
  store: () => AppStore,
  appDataDir: () => string,
): TicketTargetTracker {
  const access = () => jiraAccessFrom(store(), appDataDir());
  const site = () => trimUrl(readIntegrations(store()).jira.baseUrl ?? '');
  return {
    connected: () => isConnected(store(), appDataDir(), 'jira'),
    site,
    bound: (projectPath) =>
      linkForCwd(store(), projectPath)?.link.jiraProjectKey?.trim() || undefined,
    projects: async () =>
      (await listProjects(access())).map((project) => ({ key: project.key, name: project.name })),
    issueTypes: (projectKey) => listIssueTypes(access(), projectKey),
    priorities: () => listPriorities(access()),
    searchOpen: (projectKey) => searchOpenIssues(access(), projectKey),
    comment: (key, body) => commentIssue(access(), key, body),
    create: async (input) =>
      (
        await createIssue(access(), {
          projectKey: input.projectKey,
          summary: input.summary,
          description: input.description,
          issueType: input.issueType,
          labels: input.labels,
          ...(input.priority ? { priority: input.priority } : {}),
        })
      ).key,
    issueUrl: (key) => `${site()}/browse/${encodeURIComponent(key)}`,
  };
}

/**
 * Задачи групп в Jira (G4): статус, переходы, перевод. Подключённость —
 * `connected`: доступ собирается без запроса наружу, отказ — интеграции нет.
 */
export function atlassianTaskTracker(
  store: () => AppStore,
  appDataDir: () => string,
): SplitTaskTracker {
  const access = () => jiraAccessFrom(store(), appDataDir());
  return {
    connected: () => {
      try {
        access();
        return true;
      } catch {
        return false;
      }
    },
    status: async (key) => (await readIssue(access(), key)).status,
    transitions: (key) => listTransitions(access(), key),
    apply: (key, id) => applyTransition(access(), key, id),
  };
}

/**
 * Текст задач группы для её копии (9.5): тот же доступ, что у перевода задач,
 * чтение — с комментариями, вложениями и связями.
 */
export function atlassianTicketSource(
  store: () => AppStore,
  appDataDir: () => string,
): TicketSource {
  const access = () => jiraAccessFrom(store(), appDataDir());
  return {
    connected: () => {
      try {
        access();
        return true;
      } catch {
        return false;
      }
    },
    read: (key) => readIssueBrief(access(), key),
  };
}
