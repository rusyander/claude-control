import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderEnvRoutes } from './provider-env-routes.ts';
import { registerProviderPermissionsRoutes } from './provider-permissions-routes.ts';

/**
 * Универсальные роуты env и прав под активным провайдером Gemini (GEMINI-2/3).
 *
 * HOME/USERPROFILE подменяются на временный каталог: настоящий `~` панель в
 * тестах не трогает ни на чтение, ни на запись. Проверяем полный цикл GET→PUT→GET
 * на обоих файлах (`~/.gemini/.env` и `~/.gemini/settings.json`), сохранность
 * чужих ключей, отказ от `yolo` и fail-closed на нераспознанном файле.
 */
function makeCtx(root: string, provider: string): ServerContext {
  mkdirSync(join(root, 'claude-control'), { recursive: true });
  const store = new AppStore(join(root, 'claude-control'));
  if (provider !== 'claude') store.updateSettings({ provider });
  return {
    location: { paths: { root, appData: join(root, 'claude-control') } },
    store,
    backupDir: join(root, 'claude-control', 'backups'),
  } as unknown as ServerContext;
}

describe('gemini: env (.env) и права (settings.json) на tmp-HOME', () => {
  let home: string;
  let root: string;
  let app: FastifyInstance;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let envPath: string;
  let settingsPath: string;

  const boot = async (provider = 'gemini'): Promise<void> => {
    app = Fastify();
    const ctx = makeCtx(root, provider);
    registerProviderEnvRoutes(app, ctx);
    registerProviderPermissionsRoutes(app, ctx);
    await app.ready();
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-home-gemini-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, '.gemini'), { recursive: true });
    envPath = join(home, '.gemini', '.env');
    settingsPath = join(home, '.gemini', 'settings.json');
    root = mkdtempSync(join(tmpdir(), 'cc-gemini-routes-'));
  });
  afterEach(async () => {
    await app?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  // --- Переменные окружения (GEMINI-3) ---

  it('env: GET читает .env, PUT правит только свои строки — комментарии и порядок целы', async () => {
    writeFileSync(
      envPath,
      `# Ключи Gemini

GEMINI_API_KEY=old
export HTTPS_PROXY="http://127.0.0.1:8080" # прокси
`,
      'utf8',
    );
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-env' });
    expect(get.statusCode).toBe(200);
    const body = get.json<{ format: string; readOnly: boolean; vars: Array<{ key: string }> }>();
    expect(body.format).toBe('dotenv');
    expect(body.readOnly).toBe(false);
    expect(body.vars.map((v) => v.key)).toEqual(['GEMINI_API_KEY', 'HTTPS_PROXY']);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-env',
      payload: {
        vars: [
          { key: 'GEMINI_API_KEY', value: 'new' },
          { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:8080' },
          { key: 'GEMINI_MODEL', value: 'gemini-2.5-pro' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    expect(readFileSync(envPath, 'utf8')).toBe(`# Ключи Gemini

GEMINI_API_KEY=new
export HTTPS_PROXY="http://127.0.0.1:8080" # прокси
GEMINI_MODEL=gemini-2.5-pro
`);
  });

  it('env: нераспознанный .env → GET readOnly, PUT 422, файл не тронут', async () => {
    const broken = 'A=1\nэто не присваивание\n';
    writeFileSync(envPath, broken, 'utf8');
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-env' });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ readOnly: boolean }>().readOnly).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-env',
      payload: { vars: [{ key: 'A', value: '2' }] },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(envPath, 'utf8')).toBe(broken);
  });

  it('env: имя переменной вне формата .env → 400 invalid_draft до касания файла', async () => {
    await boot();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-env',
      payload: { vars: [{ key: 'MY-KEY', value: '1' }] },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json<{ error: string }>().error).toBe('invalid_draft');
    expect(existsSync(envPath)).toBe(false);
  });

  // --- Права/аппрувы (GEMINI-2) ---

  const SETTINGS = `${JSON.stringify(
    {
      theme: 'GitHub',
      general: { preferredEditor: 'vscode' },
      mcpServers: { probe: { command: 'node', args: ['x.js'] } },
    },
    null,
    2,
  )}\n`;

  it('права: GET отдаёт модель gemini, PUT пишет три ключа и сохраняет mcpServers', async () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(get.statusCode).toBe(200);
    const body = get.json<{
      kind: string;
      format: string;
      approvalMode: string;
      approvalModes: string[];
      usingDefaults: boolean;
    }>();
    expect(body.kind).toBe('gemini');
    expect(body.format).toBe('gemini-json');
    expect(body.approvalMode).toBe('default');
    expect(body.approvalModes).toEqual(['default', 'auto_edit', 'plan']);
    expect(body.usingDefaults).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: {
        approvalMode: 'auto_edit',
        coreTools: ['ReadFile'],
        excludeTools: ['run_shell_command'],
      },
    });
    expect(put.statusCode).toBe(200);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(parsed.theme).toBe('GitHub');
    expect(parsed.mcpServers).toEqual({ probe: { command: 'node', args: ['x.js'] } });
    expect(parsed.general).toEqual({ preferredEditor: 'vscode', defaultApprovalMode: 'auto_edit' });
    expect(parsed.coreTools).toEqual(['ReadFile']);
    expect(parsed.excludeTools).toEqual(['run_shell_command']);
  });

  // Главное правило GEMINI-2: `yolo` — режим только для флага CLI, в
  // settings.json он валит запуск. Панель обязана отказать и НИЧЕГО не писать.
  it('права: yolo → 400 mode_cli_only, файл не создаётся и не меняется', async () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');
    await boot();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { approvalMode: 'yolo', coreTools: [], excludeTools: [] },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json<{ error: string }>().error).toBe('mode_cli_only');
    expect(put.json<{ message: string }>().message).toContain('yolo');
    expect(readFileSync(settingsPath, 'utf8')).toBe(SETTINGS);
  });

  it('права: невалидный enum и не-массив в списке → 400 invalid_draft', async () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');
    await boot();

    for (const payload of [
      { approvalMode: 'always', coreTools: [], excludeTools: [] },
      { approvalMode: 'plan', coreTools: 'ReadFile', excludeTools: [] },
      { approvalPolicy: 'never', sandboxMode: 'read-only' },
    ]) {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/provider-permissions',
        payload,
      });
      expect(put.statusCode).toBe(400);
      expect(put.json<{ error: string }>().error).toBe('invalid_draft');
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(SETTINGS);
  });

  it('права: битый settings.json → GET readOnly, PUT 422, файл не тронут', async () => {
    const broken = '{ "general": ';
    writeFileSync(settingsPath, broken, 'utf8');
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ readOnly: boolean; kind: string }>()).toMatchObject({
      readOnly: true,
      kind: 'gemini',
    });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { approvalMode: 'plan', coreTools: [], excludeTools: [] },
    });
    expect(put.statusCode).toBe(422);
    expect(readFileSync(settingsPath, 'utf8')).toBe(broken);
  });

  // РЕГРЕСС-НОЛЬ ДЛЯ CLAUDE: при активном claude универсальные роуты отказывают,
  // и ни один файл gemini не читается и не пишется.
  it('claude активен → оба универсальных раздела 400, файлы gemini не тронуты', async () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');
    writeFileSync(envPath, 'A=1\n', 'utf8');
    await boot('claude');

    for (const url of ['/api/provider-env', '/api/provider-permissions']) {
      const get = await app.inject({ method: 'GET', url });
      expect(get.statusCode).toBe(400);
      expect(get.json<{ error: string }>().error).toBe('section_unsupported');

      const put = await app.inject({ method: 'PUT', url, payload: { vars: [] } });
      expect(put.statusCode).toBe(400);
    }

    expect(readFileSync(settingsPath, 'utf8')).toBe(SETTINGS);
    expect(readFileSync(envPath, 'utf8')).toBe('A=1\n');
  });
});
