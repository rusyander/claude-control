import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { registerIntegrationConnectorRoutes } from './integrations/connector-routes.ts';
import { registerIntegrationJiraRoutes } from './integrations/jira-routes.ts';
import { registerIntegrationConfluenceRoutes } from './integrations/confluence-routes.ts';
import { registerIntegrationLinkRoutes } from './integrations/link-routes.ts';
import { registerIntegrationMcpRoutes } from './integrations/mcp-routes.ts';
import { registerIntegrationExchangeRoutes } from './integrations/exchange-routes.ts';
import type { IntegrationsDeps } from './integrations/shared.ts';

/**
 * Внешние интеграции: Jira и Confluence, фордж по токену, Telegram,
 * тест-менеджмент и подхват отчётов CI.
 *
 * ОДНА учётная запись на систему обслуживает обе стороны: человека в панели и
 * агента через собственный MCP-переходник, который ходит сюда же. Поэтому
 * второго клиента Atlassian в проекте нет и быть не должно.
 *
 * Адрес самой панели приходит снаружи, из сборки приложения: только там он
 * известен (порт задаётся переменной окружения), а переходнику он нужен, чтобы
 * знать, куда стучаться.
 *
 * Сами маршруты разложены по `integrations/*`; здесь только сборка.
 */
export function registerIntegrationsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  selfBaseUrl: string,
): void {
  const deps: IntegrationsDeps = { ctx, selfBaseUrl };
  registerIntegrationConnectorRoutes(app, deps);
  registerIntegrationJiraRoutes(app, deps);
  registerIntegrationConfluenceRoutes(app, deps);
  registerIntegrationLinkRoutes(app, deps);
  registerIntegrationMcpRoutes(app, deps);
  registerIntegrationExchangeRoutes(app, deps);
}
