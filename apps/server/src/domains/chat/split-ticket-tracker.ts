import type { ServerContext } from '../../context.ts';
import { createIssue } from '../integrations/atlassian/jira.ts';
import { linkForCwd } from '../integrations/links.ts';
import { atlassianAccessOf } from '../../routes/integrations/shared.ts';

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

export function atlassianTicketTracker(ctx: ServerContext): SplitTicketTracker {
  return {
    projectOf: (projectPath) => {
      const key = linkForCwd(ctx.store, projectPath)?.link.jiraProjectKey?.trim();
      if (!key) return undefined;
      try {
        atlassianAccessOf(ctx);
        return key;
      } catch {
        return undefined;
      }
    },
    create: async (projectKey, summary, description) =>
      (await createIssue(atlassianAccessOf(ctx), { projectKey, summary, description })).key,
  };
}
