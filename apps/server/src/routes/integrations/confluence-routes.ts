import type { FastifyInstance } from 'fastify';
import {
  createPage,
  listSpaces,
  readPage,
  searchPages,
  textToStorage,
  updatePage,
} from '../../domains/integrations/atlassian/confluence.ts';
import {
  atlassianAccess,
  guard,
  limitOf,
  optionalString,
  requireString,
  type IntegrationsDeps,
} from './shared.ts';

/**
 * Confluence: пространства, поиск, чтение и запись страницы.
 *
 * Тело страницы ходит через панель ТЕКСТОМ в обе стороны: наружу его читает
 * человек в карточке и агент в задании, внутрь его пишет человек в поле формы.
 * Storage-формат (XHTML Confluence) собирается здесь — заставлять браузер
 * присылать разметку чужой системы значило бы вынести её правила наружу.
 *
 * Создание и обновление — действие человека кнопкой. Удаления нет вовсе.
 */
export function registerIntegrationConfluenceRoutes(
  app: FastifyInstance,
  deps: IntegrationsDeps,
): void {
  app.get('/api/integrations/confluence/spaces', (_request, reply) =>
    guard(reply, () => listSpaces(atlassianAccess(deps))),
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/integrations/confluence/search',
    (request, reply) =>
      guard(reply, () =>
        searchPages(
          atlassianAccess(deps),
          requireString(request.query.q, 'q', 'нужен текст поиска'),
          limitOf(request.query.limit),
        ),
      ),
  );

  app.get<{ Params: { id: string } }>('/api/integrations/confluence/page/:id', (request, reply) =>
    guard(reply, () => readPage(atlassianAccess(deps), request.params.id)),
  );

  app.post<{ Body: unknown }>('/api/integrations/confluence/page', (request, reply) =>
    guard(reply, () => {
      const body = request.body as {
        spaceKey?: unknown;
        title?: unknown;
        body?: unknown;
        parentId?: unknown;
      } | null;
      return createPage(atlassianAccess(deps), {
        spaceKey: requireString(body?.spaceKey, 'spaceKey', 'не указано пространство'),
        title: requireString(body?.title, 'title', 'не указан заголовок страницы'),
        body: textToStorage(typeof body?.body === 'string' ? body.body : ''),
        parentId: optionalString(body?.parentId),
      });
    }),
  );

  /**
   * Обновление не спрашивает номер версии: его читает сам домен. Присланный из
   * браузера номер устарел бы ровно в тот момент, когда страницу успел поправить
   * кто-то ещё, — и правка была бы затёрта.
   */
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/integrations/confluence/page/:id',
    (request, reply) =>
      guard(reply, () => {
        const body = request.body as { title?: unknown; body?: unknown } | null;
        return updatePage(atlassianAccess(deps), request.params.id, {
          title: optionalString(body?.title),
          body: textToStorage(
            requireString(body?.body, 'body', 'пустое тело страницы — так её не перезаписывают'),
          ),
        });
      }),
  );
}
