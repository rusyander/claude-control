import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Аудит 2026-09-02, маршруты MCP: черновик не по правилу — 400, а не 500 и не
 * запись мусора в ~/.claude.json; сервера нет — 404 без перезаписи файла (и без
 * отметки в state.json у тумблера); итог проверки связи сохраняется и приходит
 * в списке; тумблер называет копию.
 */
describe('маршруты MCP: проверка черновика, 404 и сохранённый итог проверки', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance;
  let store: AppStore;

  const mcpConfigPath = (): string => join(root, '.claude.json');
  const readConfigText = (): string => readFileSync(mcpConfigPath(), 'utf8');

  const httpDraft = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    transport: 'http',
    args: [],
    url: 'https://example.test/mcp',
    env: {},
    headers: {},
    groupIds: [],
    ...over,
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-mcp-valid-'));
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
      payload: httpDraft('linear'),
    });
    expect(created.statusCode).toBe(200);
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe('POST /api/mcp — черновик', () => {
    it('тело без транспорта — 400 с причиной, файл не тронут', async () => {
      const before = readConfigText();
      const res = await app.inject({ method: 'POST', url: '/api/mcp', payload: { name: 'ctx7' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_mcp_draft' });
      expect(String(res.json().message)).toMatch(/Транспорт/);
      expect(readConfigText()).toBe(before);
    });

    it('stdio без команды и http с негодным адресом — 400', async () => {
      const noCommand = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        payload: { name: 'a', transport: 'stdio' },
      });
      expect(noCommand.statusCode).toBe(400);

      const badUrl = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        payload: httpDraft('b', { url: 'not a url' }),
      });
      expect(badUrl.statusCode).toBe(400);
      expect(String(badUrl.json().message)).toMatch(/URL/);
    });

    it('имя с пробелом — 400; занятое имя — 409', async () => {
      const spaced = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        payload: httpDraft('my server'),
      });
      expect(spaced.statusCode).toBe(400);

      const taken = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        payload: httpDraft('linear'),
      });
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toMatchObject({ error: 'server_exists' });
    });
  });

  describe('нет такого сервера', () => {
    it('PUT — 404, файл не тронут', async () => {
      const before = readConfigText();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mcp/ghost',
        payload: httpDraft('ghost'),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
      expect(readConfigText()).toBe(before);
    });

    it('DELETE — 404, файл не тронут', async () => {
      const before = readConfigText();
      const res = await app.inject({ method: 'DELETE', url: '/api/mcp/ghost' });
      expect(res.statusCode).toBe(404);
      expect(readConfigText()).toBe(before);
    });

    it('тумблер — 404 и никакой отметки в state.json', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/entities/mcp/ghost/enabled',
        payload: { isEnabled: false },
      });
      expect(res.statusCode).toBe(404);
      expect(store.isDisabled('mcp', 'ghost')).toBe(false);
    });
  });

  it('тумблер существующего сервера отвечает копией файла — тост её называет', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/entities/mcp/linear/enabled',
      payload: { isEnabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; backupPath?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.backupPath).toBe('string');

    const list = (await app.inject({ method: 'GET', url: '/api/mcp' })).json() as McpServer[];
    expect(list.find((s) => s.id === 'linear')?.isEnabled).toBe(false);
  });

  it('PUT сохраняет чужие ключи записи', async () => {
    const config = JSON.parse(readConfigText()) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    config.mcpServers.linear = { ...config.mcpServers.linear, alwaysAllow: ['search'] };
    writeFileSync(mcpConfigPath(), JSON.stringify(config, null, 2));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/mcp/linear',
      payload: httpDraft('linear', { url: 'https://example.test/v2' }),
    });
    expect(res.statusCode).toBe(200);

    const after = JSON.parse(readConfigText()) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(after.mcpServers.linear?.url).toBe('https://example.test/v2');
    expect(after.mcpServers.linear?.alwaysAllow).toEqual(['search']);
  });

  it('итог проверки связи сохраняется и приходит в списке вместе со временем', async () => {
    // Процесс, который сразу выходит: рукопожатие падает за доли секунды.
    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: {
        name: 'dying',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(2)'],
      },
    });
    expect(created.statusCode).toBe(200);

    const health = await app.inject({ method: 'POST', url: '/api/mcp/dying/health' });
    expect(health.statusCode).toBe(200);
    const result = health.json() as { health: string; checkedAt?: string; detail?: string };
    expect(result.health).toBe('failed');
    expect(typeof result.checkedAt).toBe('string');

    const list = (await app.inject({ method: 'GET', url: '/api/mcp' })).json() as McpServer[];
    const dying = list.find((s) => s.id === 'dying');
    expect(dying?.health).toBe('failed');
    expect(dying?.checkedAt).toBe(result.checkedAt);
    expect(dying?.healthDetail).toBe(result.detail);

    // Переживает перезапуск: запись лежит в state.json.
    const state = JSON.parse(readFileSync(join(appData, 'state.json'), 'utf8')) as {
      mcpHealth?: Record<string, { health: string }>;
    };
    expect(state.mcpHealth?.dying?.health).toBe('failed');

    // Удаление сервера забирает и его итог.
    await app.inject({ method: 'DELETE', url: '/api/mcp/dying' });
    expect(store.getMcpHealth().dying).toBeUndefined();
  }, 20_000);

  it('сервер, созданный под именем удалённого мимо панели, не наследует его отметку проверки', async () => {
    // Отметка осталась от сервера, которого в файле уже нет (удалён руками или `claude mcp remove`).
    store.saveMcpHealth('reborn', {
      health: 'connected',
      checkedAt: '2026-01-01T00:00:00.000Z',
      toolCount: 3,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: { name: 'reborn', transport: 'stdio', command: process.execPath },
    });
    expect(created.statusCode).toBe(200);

    expect(store.getMcpHealth().reborn).toBeUndefined();
    const list = (await app.inject({ method: 'GET', url: '/api/mcp' })).json() as McpServer[];
    const reborn = list.find((s) => s.id === 'reborn');
    expect(reborn?.health).toBe('unknown');
    expect(reborn?.checkedAt).toBeUndefined();
    expect(reborn?.toolCount).toBeUndefined();
  });

  it('незаданная ссылка ${VAR} называется в причине отказа, а не уходит на сервер буквально', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: httpDraft('secured', {
        headers: { Authorization: 'Bearer ${AUDIT_MISSING_TOKEN}' },
      }),
    });
    expect(created.statusCode).toBe(200);

    const health = await app.inject({ method: 'POST', url: '/api/mcp/secured/health' });
    const result = health.json() as { health: string; detail?: string };
    expect(result.health).toBe('failed');
    expect(result.detail).toMatch(/AUDIT_MISSING_TOKEN/);
    expect(result.detail).toMatch(/Переменные/);
  });
});
