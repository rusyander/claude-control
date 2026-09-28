import type { AppStore } from '../../lib/app-store.ts';
import { atlassianAccessFrom } from '../integrations/atlassian/access.ts';
import { createIssue } from '../integrations/atlassian/jira.ts';
import { linkForCwd } from '../integrations/links.ts';

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
  const access = () => atlassianAccessFrom(store(), appDataDir());
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
