import { join, resolve } from 'node:path';
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
  /** Личный `settings.json`: там тоже живут одобрения проектных серверов. */
  userSettings: () => string;
  store: AppStore;
  appData: () => string;
  envLookup: () => EnvLookup;
  networkTimeoutMs: () => number;
}

interface RawFile {
  mcpServers?: Record<string, Record<string, unknown>>;
}

/** Ключи одобрения серверов проектного `.mcp.json` — те же, что пишет и читает Claude Code. */
interface McpApproval {
  enableAllProjectMcpServers?: unknown;
  enabledMcpjsonServers?: unknown;
  disabledMcpjsonServers?: unknown;
}

const namesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];

/** Ключ проекта в `~/.claude.json`: прямые слэши, а регистр буквы диска у Windows гуляет. */
const projectKey = (path: string): string => {
  const key = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

/**
 * Одобрил ли человек сервер проектного `.mcp.json`. Claude Code сам не запускает
 * неодобренный сервер проекта, а `--mcp-config` это одобрение обходит — поэтому
 * панель, отдавая проектные серверы через флаг, спрашивает те же ключи: запись
 * проекта в `~/.claude.json` и `settings.json` личный и проекта. Отказ сильнее.
 */
export function mcpjsonApproval(
  project: string,
  files: { userConfig: string; userSettings: string },
): (id: string) => boolean {
  const projects =
    readJsonFile<{ projects?: Record<string, McpApproval> }>(files.userConfig, {}).projects ?? {};
  const own = projectKey(project);
  const sources: McpApproval[] = [
    ...Object.entries(projects)
      .filter(([path]) => projectKey(path) === own)
      .map(([, entry]) => entry),
    readJsonFile<McpApproval>(files.userSettings, {}),
    readJsonFile<McpApproval>(join(project, '.claude', 'settings.json'), {}),
    readJsonFile<McpApproval>(join(project, '.claude', 'settings.local.json'), {}),
  ];
  const all = sources.some((source) => source.enableAllProjectMcpServers === true);
  const enabled = new Set(sources.flatMap((source) => namesOf(source.enabledMcpjsonServers)));
  const disabled = new Set(sources.flatMap((source) => namesOf(source.disabledMcpjsonServers)));
  return (id) => !disabled.has(id) && (all || enabled.has(id));
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
    list(project, options) {
      const byId = new Map<string, McpSourceEntry>();
      for (const entry of fromFile(deps.userConfig(), 'user')) byId.set(entry.id, entry);
      const approved = options?.approvedOnly
        ? mcpjsonApproval(project, {
            userConfig: deps.userConfig(),
            userSettings: deps.userSettings(),
          })
        : () => true;
      // Порядок Claude Code: запись проекта сильнее личной с тем же именем. Неодобренная
      // проектная запись отсеивается ДО слияния — личная с тем же именем остаётся.
      for (const entry of fromFile(join(project, '.mcp.json'), 'project'))
        if (approved(entry.id)) byId.set(entry.id, entry);
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
