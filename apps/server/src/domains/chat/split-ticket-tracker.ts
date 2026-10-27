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
import type { SimilarQuery } from './split-ticket-batch/duplicates.ts';
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
/** Ключ проекта Jira — латиница, цифры и `_`; иное в JQL не подставляем. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

const toOpen = (issue: { key: string; summary: string; description?: string }) => ({
  key: issue.key,
  summary: issue.summary,
  description: issue.description ?? '',
});

async function searchOpenIssues(
  access: AtlassianAccess,
  projectKey: string,
): Promise<OpenTrackerIssue[]> {
  if (!PROJECT_KEY.test(projectKey)) return [];
  const found = await searchIssues(access, {
    jql: `project = "${projectKey}" AND statusCategory != Done ORDER BY updated DESC`,
    limit: OPEN_ISSUES_LIMIT,
  });
  return found.map(toOpen);
}

/** Сколько похожих задач читает поиск одного дефекта: решает потом сверка по названию. */
const SIMILAR_LIMIT = 20;

/**
 * Похожие открытые задачи по ВСЕМУ проекту (проверка на повторы, 25.10.2026):
 * слова названия в `summary`, отпечаток находки в тексте старой задачи или ключ
 * задачи, за которой панель помнит отпечаток. Слова — только буквы и цифры
 * (`searchWords`), отпечатки — hex, ключи — PROJ-123: в JQL ничего чужого не попадёт.
 * Порядка нет нарочно — полнотекстовый поиск Jira ставит ближе более похожие.
 */
async function searchSimilarIssues(
  access: AtlassianAccess,
  projectKey: string,
  query: SimilarQuery,
): Promise<OpenTrackerIssue[]> {
  if (!PROJECT_KEY.test(projectKey)) return [];
  const words = query.words.filter((word) => /^[\p{L}\p{N}]+$/u.test(word));
  const prints = query.prints.filter((print) => /^[0-9a-f]{6,40}$/.test(print));
  // Ключи задач из памяти панели — только вида PROJ-123 и только этого проекта.
  const keys = query.keys
    .filter((key) => /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) && key.startsWith(`${projectKey}-`))
    .slice(0, 50);
  const clauses = [
    ...(words.length > 0 ? [`summary ~ "${words.join(' ')}"`] : []),
    // Чтение старых задач, где отпечаток ещё стоит в тексте; новые его не несут.
    ...prints.map((print) => `text ~ "${print}"`),
    ...(keys.length > 0 ? [`key in (${keys.join(', ')})`] : []),
  ];
  if (clauses.length === 0) return [];
  const found = await searchIssues(access, {
    jql: `project = "${projectKey}" AND statusCategory != Done AND (${clauses.join(' OR ')})`,
    limit: SIMILAR_LIMIT,
  });
  return found.map(toOpen);
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
    priorities: () => listPriorities(access()),
    // Исполнителя нет в теле никогда (владелец 25.10.2026) — `createIssue` его и не умеет.
    create: async (issue) =>
      (
        await createIssue(access(), {
          projectKey: issue.projectKey,
          summary: issue.summary,
          description: issue.description,
          labels: issue.labels,
          ...(issue.priority ? { priority: issue.priority } : {}),
        })
      ).key,
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
    searchSimilar: (projectKey, query) => searchSimilarIssues(access(), projectKey, query),
    comment: (key, body) => commentIssue(access(), key, body),
    // Исполнителя нет в теле никогда; назначила Jira сама (исполнитель проекта по
    // умолчанию) — его имя уходит в итог, окно предупредит человека.
    create: async (input) => {
      const created = await createIssue(access(), {
        projectKey: input.projectKey,
        summary: input.summary,
        description: input.description,
        issueType: input.issueType,
        labels: input.labels,
        ...(input.priority ? { priority: input.priority } : {}),
      });
      return { key: created.key, ...(created.assignee ? { assignee: created.assignee } : {}) };
    },
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
