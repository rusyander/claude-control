import type { FastifyInstance } from 'fastify';
import {
  ATLASSIAN_MCP_ID,
  isAtlassianMcpRegistered,
  registerAtlassianMcp,
  unregisterAtlassianMcp,
} from '../../domains/integrations/mcp-server.ts';
import { fail, type IntegrationsDeps } from './shared.ts';

/**
 * Подключение собственного MCP-переходника к активному CLI.
 *
 * Регистрация — действие ЧЕЛОВЕКА кнопкой и ничем иным: запись уходит в
 * конфигурацию CLI, а не в состояние панели. Делать это молча нельзя даже ради
 * удобства.
 *
 * Куда именно — решает активный провайдер: у Claude это `~/.claude.json`, у
 * остальных — их собственный файл MCP (`domains/provider-mcp.ts`), с их
 * форматом и их же бэкапом. Провайдер без поддержки MCP записи не получает.
 *
 * В записи НЕТ токена Atlassian. Переходник ходит в саму панель, а к Atlassian
 * ходит уже она — поэтому в окружение процесса уходит только адрес панели.
 */
export function registerIntegrationMcpRoutes(app: FastifyInstance, deps: IntegrationsDeps): void {
  const options = (): Parameters<typeof registerAtlassianMcp>[0] => ({
    mcpConfigPath: deps.ctx.location.paths.mcpConfig,
    backupDir: deps.ctx.backupDir,
    selfBaseUrl: deps.selfBaseUrl,
    // Настройки решают, в чей конфиг уйдёт запись: у Claude свой файл, у
    // остальных девяти CLI — их собственный раздел MCP.
    store: deps.ctx.store,
  });

  app.get('/api/integrations/mcp/connect', () => ({
    name: ATLASSIAN_MCP_ID,
    connected: isAtlassianMcpRegistered(deps.ctx.location.paths.mcpConfig, deps.ctx.store),
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
