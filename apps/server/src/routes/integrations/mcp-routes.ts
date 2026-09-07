import type { FastifyInstance } from 'fastify';
import {
  ATLASSIAN_MCP_ID,
  isAtlassianMcpRegistered,
  registerAtlassianMcp,
  unregisterAtlassianMcp,
} from '../../domains/integrations/mcp-server.ts';
import { fail, type IntegrationsDeps } from './shared.ts';

/**
 * Подключение собственного MCP-переходника к Claude Code.
 *
 * Регистрация — действие ЧЕЛОВЕКА кнопкой и ничем иным: запись уходит в
 * `~/.claude.json`, то есть в конфигурацию CLI, а не в состояние панели. Делать
 * это молча нельзя даже ради удобства.
 *
 * В записи НЕТ токена Atlassian. Переходник ходит в саму панель, а к Atlassian
 * ходит уже она — поэтому в окружение процесса уходит только адрес панели.
 */
export function registerIntegrationMcpRoutes(app: FastifyInstance, deps: IntegrationsDeps): void {
  const options = (): Parameters<typeof registerAtlassianMcp>[0] => ({
    mcpConfigPath: deps.ctx.location.paths.mcpConfig,
    backupDir: deps.ctx.backupDir,
    selfBaseUrl: deps.selfBaseUrl,
  });

  app.get('/api/integrations/mcp/connect', () => ({
    name: ATLASSIAN_MCP_ID,
    connected: isAtlassianMcpRegistered(deps.ctx.location.paths.mcpConfig),
  }));

  app.post('/api/integrations/mcp/connect', (_request, reply) => {
    try {
      return { name: registerAtlassianMcp(options()), connected: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/integrations/mcp/connect', (_request, reply) => {
    try {
      const removed = unregisterAtlassianMcp(options());
      return { name: ATLASSIAN_MCP_ID, connected: false, removed };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
