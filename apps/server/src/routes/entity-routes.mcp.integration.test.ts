import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { hasOAuthTokens, oauthProviderFor, oauthStorePath } from '../domains/mcp-oauth.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Маршруты MCP-серверов: имя сервера — его идентификатор, и по нему ключуются
 * не только запись в ~/.claude.json, но и отметки в state.json (группы,
 * выключение) и сохранённый OAuth-вход в отдельном файле с токенами.
 *
 * Раньше правился только конфиг, поэтому переименование теряло группы и
 * авторизацию, а удаление оставляло чужой refresh-токен на диске навсегда.
 * Здесь дёргаются те же маршруты, что и из панели, на временном каталоге.
 */
describe('маршруты MCP: переименование и удаление', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance;
  let store: AppStore;

  const mcpConfigPath = (): string => join(root, '.claude.json');

  const saveTokenFor = (id: string): Promise<void> => {
    const server = {
      id,
      name: id,
      transport: 'http',
      args: [],
      env: {},
      headers: {},
      url: 'https://example.test/mcp',
      health: 'unknown',
      isEnabled: true,
      groupIds: [],
      hasOAuth: false,
    } as McpServer;
    const provider = oauthProviderFor(server, appData) as unknown as {
      saveTokens(t: { access_token: string; token_type: string }): Promise<void>;
    };

    return provider.saveTokens({ access_token: `secret-${id}`, token_type: 'Bearer' });
  };

  const readConfig = (): { mcpServers?: Record<string, unknown> } =>
    JSON.parse(readFileSync(mcpConfigPath(), 'utf8')) as { mcpServers?: Record<string, unknown> };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-mcp-routes-'));
    appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);

    const ctx = {
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: mcpConfigPath(),
          secretsEnv: join(root, '.mcp-secrets.env'),
        },
      },
      store,
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerEntityRoutes(app, ctx);
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: {
        name: 'linear',
        transport: 'http',
        args: [],
        url: 'https://example.test/mcp',
        env: {},
        headers: {},
        groupIds: [],
      },
    });
    expect(created.statusCode).toBe(200);
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const renameTo = (name: string) =>
    app.inject({
      method: 'PUT',
      url: '/api/mcp/linear',
      payload: {
        name,
        transport: 'http',
        args: [],
        url: 'https://example.test/mcp',
        env: {},
        headers: {},
        groupIds: [],
      },
    });

  it('переименование уносит с собой группы, отметку выключения и вход', async () => {
    store.saveGroup({
      id: 'g1',
      name: 'Работа',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'mcp', id: 'linear' }],
      env: {},
      isEnabled: true,
      order: 0,
    });
    store.setEnabled('mcp', 'linear', false);
    await saveTokenFor('linear');

    const response = await renameTo('linear-mcp');
    expect(response.statusCode).toBe(200);

    expect(store.getGroupIdsFor('mcp', 'linear-mcp')).toEqual(['g1']);
    expect(store.getGroupIdsFor('mcp', 'linear')).toEqual([]);
    expect(store.isDisabledManually('mcp', 'linear-mcp')).toBe(true);
    expect(store.isDisabledManually('mcp', 'linear')).toBe(false);
    expect(hasOAuthTokens(appData, 'linear-mcp')).toBe(true);
    expect(hasOAuthTokens(appData, 'linear')).toBe(false);
  });

  it('правка без смены имени вход не трогает', async () => {
    await saveTokenFor('linear');

    const response = await renameTo('linear');
    expect(response.statusCode).toBe(200);
    expect(hasOAuthTokens(appData, 'linear')).toBe(true);
  });

  it('переименование в занятое имя — 409, чужая запись и её вход целы', async () => {
    // Раньше запись шла по имени безусловно: настроенный «ctx7» молча
    // замещался, а переезд состояния уносил на него ещё и чужой OAuth-вход.
    await app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: {
        name: 'ctx7',
        transport: 'http',
        args: [],
        url: 'https://ctx7.test/mcp',
        env: {},
        headers: {},
        groupIds: [],
      },
    });
    await saveTokenFor('ctx7');

    const response = await renameTo('ctx7');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('server_exists');
    const servers = readConfig().mcpServers ?? {};
    expect(servers).toHaveProperty('linear');
    expect((servers as Record<string, { url?: string }>).ctx7?.url).toBe('https://ctx7.test/mcp');
    // Токен чужого сервера не переехал и не пропал.
    expect(hasOAuthTokens(appData, 'ctx7')).toBe(true);
  });

  it('создание с именем ВЫКЛЮЧЕННОГО сервера — 409, оригинал цел', async () => {
    // Имя, занятое выключенным тёзкой, попадало сразу в обе секции файла:
    // список показывал одну карточку, и первое же выключение уничтожало
    // выключенный оригинал.
    await app.inject({
      method: 'POST',
      url: '/api/entities/mcp/linear/enabled',
      payload: { isEnabled: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: {
        name: 'linear',
        transport: 'stdio',
        command: 'npx',
        args: ['другой'],
        env: {},
        headers: {},
        groupIds: [],
      },
    });

    expect(response.statusCode).toBe(409);
    const config = readConfig() as {
      mcpServers?: Record<string, unknown>;
      mcpServersDisabled?: Record<string, { url?: string }>;
    };
    expect(config.mcpServers ?? {}).not.toHaveProperty('linear');
    expect(config.mcpServersDisabled?.linear?.url).toBe('https://example.test/mcp');
  });

  it('удаление уносит участие в группах и отметки — новый тёзка их не наследует', async () => {
    store.saveGroup({
      id: 'g1',
      name: 'Работа',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'mcp', id: 'linear' }],
      env: {},
      isEnabled: true,
      order: 0,
    });
    store.setEnabled('mcp', 'linear', false);
    store.setGroupDisabled('mcp', 'linear', 'g1', true);

    const response = await app.inject({ method: 'DELETE', url: '/api/mcp/linear' });
    expect(response.statusCode).toBe(200);

    expect(store.getGroups()[0]?.members).toEqual([]);
    expect(store.getGroupIdsFor('mcp', 'linear')).toEqual([]);
    expect(store.isDisabled('mcp', 'linear')).toBe(false);

    // Сервер, заведённый под тем же именем, приходит чистым: без чужих групп и
    // без гашения группой, в которую он никогда не входил.
    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: {
        name: 'linear',
        transport: 'http',
        args: [],
        url: 'https://new.test/mcp',
        env: {},
        headers: {},
        groupIds: [],
      },
    });
    expect(created.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/mcp' });
    const server = list.json<McpServer[]>().find((item) => item.id === 'linear');
    expect(server?.groupIds).toEqual([]);
    expect(server?.isEnabled).toBe(true);
  });

  it('удаление сервера уносит его токены — карточки с «Выйти» больше нет', async () => {
    await saveTokenFor('linear');
    expect(hasOAuthTokens(appData, 'linear')).toBe(true);

    const response = await app.inject({ method: 'DELETE', url: '/api/mcp/linear' });
    expect(response.statusCode).toBe(200);

    expect(readConfig().mcpServers ?? {}).not.toHaveProperty('linear');
    expect(hasOAuthTokens(appData, 'linear')).toBe(false);
    // Токен не должен остаться и в самом файле хранилища — ключ удалён целиком.
    expect(readFileSync(oauthStorePath(appData), 'utf8')).not.toContain('secret-linear');
  });
});
