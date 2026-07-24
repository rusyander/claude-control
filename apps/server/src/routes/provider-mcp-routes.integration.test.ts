import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderMcpRoutes } from './provider-mcp-routes.ts';

/**
 * Универсальные MCP-роуты Gemini/Codex. Провайдер задаётся настройкой, файл
 * конфигурации подменяется на tmp через claudeDirOverride — НО провайдеры codex/
 * gemini глобальны и override игнорируют, поэтому здесь мы проверяем маршрутную
 * логику (гейтинг, коды ответов) и, где путь в tmp, запись. Настоящий ~ не трогаем:
 * тесты записи, читающие реальный путь провайдера, вынесены в доменный тест.
 */
function makeCtx(root: string, provider: string): ServerContext {
  mkdirSync(join(root, 'claude-control'), { recursive: true });
  const store = new AppStore(join(root, 'claude-control'));
  if (provider !== 'claude') store.updateSettings({ provider });
  return {
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        mcpConfig: join(root, '.claude.json'),
        secretsEnv: join(root, '.mcp-secrets.env'),
        appData: join(root, 'claude-control'),
      },
    },
    store,
    backupDir: join(root, 'claude-control', 'backups'),
  } as unknown as ServerContext;
}

describe('provider-mcp роуты: гейтинг по провайдеру (fail-closed)', () => {
  let root: string;
  let app: FastifyInstance;

  const bootWith = async (provider: string): Promise<void> => {
    app = Fastify();
    registerProviderMcpRoutes(app, makeCtx(root, provider));
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-pmcp-route-'));
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('claude → 400 section_unsupported (у него свои роуты /api/mcp)', async () => {
    await bootWith('claude');
    const res = await app.inject({ method: 'GET', url: '/api/provider-mcp' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('section_unsupported');
  });

  it('aider (mcp≠ready) → 400 section_unsupported на всех методах', async () => {
    await bootWith('aider');
    for (const m of [
      { method: 'GET' as const, url: '/api/provider-mcp' },
      { method: 'POST' as const, url: '/api/provider-mcp' },
      { method: 'PUT' as const, url: '/api/provider-mcp/x' },
      { method: 'DELETE' as const, url: '/api/provider-mcp/x' },
    ]) {
      const res = await app.inject({ ...m, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
  });

  it('gemini → GET отдаёт метаданные и формат json', async () => {
    await bootWith('gemini');
    const res = await app.inject({ method: 'GET', url: '/api/provider-mcp' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providerId: string; format: string; readOnly: boolean }>();
    expect(body.providerId).toBe('gemini');
    expect(body.format).toBe('json');
    expect(body.readOnly).toBe(false);
  });

  it('codex → POST с невалидным черновиком → 400 invalid_draft', async () => {
    await bootWith('codex');
    const res = await app.inject({
      method: 'POST',
      url: '/api/provider-mcp',
      payload: { name: 'x', transport: 'stdio' }, // нет command
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_draft');
  });
});

/**
 * Ф8: cursor и opencode — рабочие разделы MCP. Пути их файлов глобальны
 * (`homedir()`), поэтому на время теста подменяем HOME/USERPROFILE на tmp —
 * настоящий ~ не трогаем.
 */
describe('provider-mcp роуты Ф8: cursor и opencode на tmp-HOME', () => {
  let home: string;
  let root: string;
  let app: FastifyInstance;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  const bootWith = async (provider: string): Promise<void> => {
    app = Fastify();
    registerProviderMcpRoutes(app, makeCtx(root, provider));
    await app.ready();
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-home-p8-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    root = mkdtempSync(join(tmpdir(), 'cc-pmcp-p8-'));
  });

  afterEach(async () => {
    await app?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('cursor → GET 200 (format json, ~/.cursor/mcp.json), POST сохраняет чужие ключи файла', async () => {
    const cursorDir = join(home, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    const mcpPath = join(cursorDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({ $schema: 'x', mcpServers: { old: { url: 'https://old/mcp' } } }, null, 2),
      'utf8',
    );

    await bootWith('cursor');
    const res = await app.inject({ method: 'GET', url: '/api/provider-mcp' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      providerId: string;
      format: string;
      readOnly: boolean;
      filePath: string;
      servers: { name: string; transport: string }[];
    }>();
    expect(body.providerId).toBe('cursor');
    expect(body.format).toBe('json');
    expect(body.readOnly).toBe(false);
    expect(body.filePath).toBe(mcpPath);
    expect(body.servers).toEqual([
      expect.objectContaining({ name: 'old', transport: 'http', url: 'https://old/mcp' }),
    ]);

    const post = await app.inject({
      method: 'POST',
      url: '/api/provider-mcp',
      payload: { name: 'new', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
    });
    expect(post.statusCode).toBe(200);
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(parsed.$schema).toBe('x');
    expect(parsed.mcpServers.old).toEqual({ url: 'https://old/mcp' });
    expect(parsed.mcpServers.new).toEqual({ command: 'npx', args: ['-y', 'pkg'] });
  });

  it('opencode → GET 200 (format opencode-json), PUT сохраняет enabled и прочие ключи', async () => {
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, 'opencode.json');
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'anthropic/claude-sonnet-4',
          mcp: {
            srv: { type: 'local', command: ['bun', 'x', 'srv'], enabled: true, futureField: 1 },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await bootWith('opencode');
    const res = await app.inject({ method: 'GET', url: '/api/provider-mcp' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providerId: string; format: string; servers: unknown[] }>();
    expect(body.providerId).toBe('opencode');
    expect(body.format).toBe('opencode-json');
    expect(body.servers).toEqual([
      expect.objectContaining({ name: 'srv', transport: 'stdio', command: 'bun' }),
    ]);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-mcp/srv',
      payload: { name: 'srv', transport: 'stdio', command: 'bun', args: ['x', 'srv2'] },
    });
    expect(put.statusCode).toBe(200);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(parsed.model).toBe('anthropic/claude-sonnet-4');
    expect(parsed.mcp.srv).toEqual({
      type: 'local',
      command: ['bun', 'x', 'srv2'],
      enabled: true,
      futureField: 1,
    });
  });

  it('opencode: битый opencode.json → GET readOnly, POST 422 format_unrecognized', async () => {
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, 'opencode.json');
    const broken = '{ "model": "x", "mcp": {';
    writeFileSync(cfgPath, broken, 'utf8');

    await bootWith('opencode');
    const res = await app.inject({ method: 'GET', url: '/api/provider-mcp' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ readOnly: boolean }>().readOnly).toBe(true);

    const post = await app.inject({
      method: 'POST',
      url: '/api/provider-mcp',
      payload: { name: 'a', transport: 'stdio', command: 'npx' },
    });
    expect(post.statusCode).toBe(422);
    expect(post.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(cfgPath, 'utf8')).toBe(broken);
  });
});

/**
 * Полный цикл записи через роуты на подменённом файле codex. Файл провайдера
 * глобален, поэтому подменяем сам путь: собираем ctx, где активен codex, и
 * инжектим POST — проверяем 422 на непарсящемся файле. Чтобы писать в tmp-файл
 * codex, монтируем провайдера с временным config через прямой доменный вызов —
 * но здесь достаточно проверить fail-closed на реальном сценарии 422.
 */
describe('provider-mcp роуты: codex fail-closed 422 на битом config.toml', () => {
  it('битый config.toml по пути провайдера → POST 422 format_unrecognized', async () => {
    // Пишем битый TOML прямо по пути провайдера в tmp-HOME, чтобы не трогать
    // реальный ~/.codex. Провайдер codex строит путь от homedir(); переопределяем
    // HOME/USERPROFILE на время теста.
    const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const cfgPath = join(codexDir, 'config.toml');
    const broken = 'model = "gpt\n[mcp_servers.x\ncommand =';
    writeFileSync(cfgPath, broken, 'utf8');

    const root = mkdtempSync(join(tmpdir(), 'cc-pmcp-422-'));
    const app = Fastify();
    registerProviderMcpRoutes(app, makeCtx(root, 'codex'));
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/provider-mcp',
        payload: { name: 'a', transport: 'stdio', command: 'npx' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: string }>().error).toBe('format_unrecognized');
      // Файл не тронут.
      expect(readFileSync(cfgPath, 'utf8')).toBe(broken);
    } finally {
      await app.close();
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUserProfile;
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
