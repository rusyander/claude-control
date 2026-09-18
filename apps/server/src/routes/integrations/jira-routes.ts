import type { FastifyInstance } from 'fastify';
import {
  applyTransition,
  commentIssue,
  createIssue,
  listProjects,
  listTransitions,
  readIssue,
  searchIssues,
} from '../../domains/integrations/atlassian/jira.ts';
import {
  atlassianAccess,
  guard,
  limitOf,
  optionalString,
  requireString,
  type IntegrationsDeps,
} from './shared.ts';

/**
 * Jira глазами панели: найти задачу, прочитать её, завести дефект, дописать
 * комментарий, перевести статус.
 *
 * Читающие ручки ничего не спрашивают — человек ищет задачу, чтобы привязать
 * её, и подтверждение на каждый поиск сделало бы привязку невыносимой. Пишущих
 * ровно три, и удаления среди них нет: панель не сносит чужие задачи.
 */
export function registerIntegrationJiraRoutes(app: FastifyInstance, deps: IntegrationsDeps): void {
  app.get('/api/integrations/jira/projects', (_request, reply) =>
    guard(reply, () => listProjects(atlassianAccess(deps))),
  );

  app.get<{ Querystring: { q?: string; jql?: string; limit?: string } }>(
    '/api/integrations/jira/search',
    (request, reply) =>
      guard(reply, () =>
        searchIssues(atlassianAccess(deps), {
          q: optionalString(request.query.q),
          jql: optionalString(request.query.jql),
          limit: limitOf(request.query.limit),
        }),
      ),
  );

  app.get<{ Params: { key: string } }>('/api/integrations/jira/issue/:key', (request, reply) =>
    guard(reply, () => readIssue(atlassianAccess(deps), request.params.key)),
  );

  /** Завести задачу. Тип по умолчанию «Bug» — панель заводит именно дефекты. */
  app.post<{ Body: unknown }>('/api/integrations/jira/issue', (request, reply) =>
    guard(reply, () => {
      const body = request.body as {
        projectKey?: unknown;
        summary?: unknown;
        description?: unknown;
        issueType?: unknown;
        labels?: unknown;
      } | null;
      return createIssue(atlassianAccess(deps), {
        projectKey: requireString(
          body?.projectKey,
          'projectKey',
          'не указан проект Jira',
          'request-jira-project-missing',
          { field: 'projectKey' },
        ),
        summary: requireString(
          body?.summary,
          'summary',
          'не указан заголовок задачи',
          'request-issue-title-missing',
          { field: 'summary' },
        ),
        description: typeof body?.description === 'string' ? body.description : '',
        issueType: optionalString(body?.issueType),
        labels: Array.isArray(body?.labels) ? body.labels.map(String).filter(Boolean) : undefined,
      });
    }),
  );

  app.post<{ Params: { key: string }; Body: unknown }>(
    '/api/integrations/jira/issue/:key/comment',
    (request, reply) =>
      guard(reply, async () => {
        const body = (request.body as { body?: unknown } | null)?.body;
        await commentIssue(
          atlassianAccess(deps),
          request.params.key,
          requireString(body, 'body', 'пустой комментарий', 'request-comment-empty', {
            field: 'body',
          }),
        );
        return { ok: true };
      }),
  );

  app.get<{ Params: { key: string } }>(
    '/api/integrations/jira/issue/:key/transitions',
    (request, reply) =>
      guard(reply, () => listTransitions(atlassianAccess(deps), request.params.key)),
  );

  /**
   * Перевод статуса делает ЧЕЛОВЕК кнопкой: агенту он не разрешён — он не знает,
   * что «Готово» означает у этой команды.
   */
  app.post<{ Params: { key: string }; Body: unknown }>(
    '/api/integrations/jira/issue/:key/transition',
    (request, reply) =>
      guard(reply, async () => {
        const id = (request.body as { id?: unknown } | null)?.id;
        await applyTransition(
          atlassianAccess(deps),
          request.params.key,
          requireString(id, 'id', 'не указан переход', 'request-transition-missing', {
            field: 'id',
          }),
        );
        return { ok: true };
      }),
  );
}
