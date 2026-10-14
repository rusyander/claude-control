import { join } from 'node:path';
import { readJsonFile } from '../../lib/safe-io/safe-io.ts';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { readMcpServers } from '../mcp/mcp.ts';
import { sessionBudget } from '../mcp/mcp-health.ts';
import { openMcpSession, type EnvLookup } from '../mcp-client/mcp-client.ts';
import { hasOAuthTokens, oauthProviderFor } from '../mcp-oauth/mcp-oauth.ts';
import type { LocalMcpSource, McpSourceEntry } from './local-mcp.ts';

/**
 * Источник MCP-серверов для локального прогона: реестр самой панели. Пользовательские
 * лежат в `~/.claude.json`, проектные — в `.mcp.json` проекта; тот же разбор, что у
 * раздела «MCP-серверы» (`domains/mcp/mcp.ts`), тот же клиент (`mcp-client.ts`), та же
 * подстановка `${VAR}` и тот же OAuth, что у проверки связи, — свой второй разбор
 * разошёлся бы с первым.
 */

export interface LocalMcpSourceDeps {
  /** Путь `~/.claude.json` (функцией: каталог конфигурации меняется на лету). */
  userConfig: () => string;
  store: AppStore;
  appData: () => string;
  envLookup: () => EnvLookup;
  networkTimeoutMs: () => number;
}

interface RawFile {
  mcpServers?: Record<string, Record<string, unknown>>;
}

export function createLocalMcpSource(deps: LocalMcpSourceDeps): LocalMcpSource {
  const fromFile = (path: string, scope: McpSourceEntry['scope']): McpSourceEntry[] => {
    const raw = readJsonFile<RawFile>(path, {}).mcpServers ?? {};
    return readMcpServers(path, deps.store, deps.appData())
      .filter((server) => server.isEnabled && raw[server.id])
      .map((server) => ({
        id: server.id,
        scope,
        transport: server.transport,
        config: raw[server.id] ?? {},
        server,
      }));
  };

  return {
    list(project) {
      const byId = new Map<string, McpSourceEntry>();
      for (const entry of fromFile(deps.userConfig(), 'user')) byId.set(entry.id, entry);
      // Порядок Claude Code: запись проекта сильнее личной с тем же именем.
      for (const entry of fromFile(join(project, '.mcp.json'), 'project'))
        byId.set(entry.id, entry);
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    },

    async tools(entry) {
      const server = entry.server;
      const auth =
        server.transport !== 'stdio' && hasOAuthTokens(deps.appData(), server.id)
          ? oauthProviderFor(server, deps.appData())
          : undefined;
      const timeout = deps.networkTimeoutMs();
      const session = await openMcpSession(
        server,
        sessionBudget(server.transport, 30_000, timeout),
        auth,
        timeout,
        deps.envLookup(),
      );
      try {
        return await session.listTools();
      } finally {
        await session.close();
      }
    },
  };
}
