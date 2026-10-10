import type { AppStore } from '../../lib/app-store/app-store.ts';
import { jiraAccessFrom } from '../integrations/atlassian/access.ts';
import {
  applyTransition,
  createIssue,
  listTransitions,
  readIssue,
} from '../integrations/atlassian/jira.ts';
import { linkForCwd } from '../integrations/links.ts';
import type { SplitTaskTracker } from './split-tasks/split-tasks.ts';

/**
 * Трекер для тикетов, предложенных группами разделения (L277): куда их можно
 * завести и чем. Проект трекера — привязка проекта («проект Jira для новых
 * дефектов»), интеграция должна быть подключена; иначе заводить некуда, и хаб
 * оставляет только «Копировать».
 */
export interface SplitTicketTracker {
  projectOf: (projectPath: string) => string | undefined;
  create: (projectKey: string, summary: string, description: string) => Promise<string>;
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
    create: async (projectKey, summary, description) =>
      (await createIssue(access(), { projectKey, summary, description })).key,
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
