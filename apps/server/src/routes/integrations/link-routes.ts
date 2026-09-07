import type { FastifyInstance } from 'fastify';
import type { IntegrationLink } from '@agentdeck/contracts';
import { dropLink, readLinks, writeLink } from '../../domains/integrations/links.ts';
import { fail, optionalString, requireString, type IntegrationsDeps } from './shared.ts';

/**
 * Привязка проекта к внешнему миру: задача Jira, страница Confluence,
 * репозиторий форджа.
 *
 * Это единственное, чего агент не может выяснить сам: в репозитории нигде не
 * написано, что работа относится к PRJ-1234, а требования лежат на такой-то
 * странице. Человек говорит это один раз — и строку получают оба, панель и
 * агент через свой MCP.
 *
 * Хранится это в состоянии панели, а не в проекте: привязка — рабочая заметка
 * одного человека, и класть её в чужой репозиторий незачем.
 */
export function registerIntegrationLinkRoutes(app: FastifyInstance, deps: IntegrationsDeps): void {
  app.get<{ Querystring: { path?: string } }>('/api/integrations/links', (request, reply) => {
    try {
      return readLinks(deps.ctx.store, String(request.query.path ?? ''));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Body: unknown }>('/api/integrations/links', (request, reply) => {
    const body = request.body as { path?: unknown; groupId?: unknown; link?: unknown } | null;
    try {
      const path = requireString(body?.path, 'path', 'не указан каталог проекта');
      return writeLink(deps.ctx.store, path, optionalString(body?.groupId), toLink(body?.link));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Body: unknown }>('/api/integrations/links', (request, reply) => {
    const body = request.body as { path?: unknown; groupId?: unknown } | null;
    try {
      const path = requireString(body?.path, 'path', 'не указан каталог проекта');
      return dropLink(deps.ctx.store, path, optionalString(body?.groupId));
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/**
 * Привязка из тела запроса: только известные поля и только строками.
 *
 * Форма «взять что прислали» здесь опасна — эта запись уходит агенту текстом
 * задания, и чужое поле в ней стало бы способом дописать агенту инструкцию
 * мимо всех проверок.
 */
function toLink(value: unknown): IntegrationLink {
  const raw = (value ?? {}) as Record<string, unknown>;
  const link: IntegrationLink = {
    jiraProjectKey: optionalString(raw.jiraProjectKey),
    jiraIssueKey: optionalString(raw.jiraIssueKey),
    jiraIssueTitle: optionalString(raw.jiraIssueTitle),
    confluencePageId: optionalString(raw.confluencePageId),
    confluencePageTitle: optionalString(raw.confluencePageTitle),
    forgeRepo: optionalString(raw.forgeRepo),
    note: optionalString(raw.note),
  };
  // Пустые поля выкидываем: `{}` в состоянии означает «привязки нет», а объект
  // из семи `undefined` выглядел бы привязкой и включал бы MCP на пустом месте.
  for (const key of Object.keys(link) as (keyof IntegrationLink)[]) {
    if (link[key] === undefined) delete link[key];
  }
  return link;
}
