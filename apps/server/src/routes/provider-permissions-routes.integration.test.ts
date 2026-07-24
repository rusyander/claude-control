import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderPermissionsRoutes } from './provider-permissions-routes.ts';

/**
 * Универсальные роуты прав Codex. Провайдер задаётся настройкой; файл провайдера
 * глобален (config.toml от homedir), поэтому там, где нужна запись в конкретный
 * файл, переопределяем HOME/USERPROFILE на tmp — настоящий ~ не трогаем.
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

describe('provider-permissions роуты: гейтинг по провайдеру (fail-closed)', () => {
  let root: string;
  let app: FastifyInstance;

  const bootWith = async (provider: string): Promise<void> => {
    app = Fastify();
    registerProviderPermissionsRoutes(app, makeCtx(root, provider));
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-pperm-route-'));
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('claude → 400 section_unsupported (у него свои роуты прав)', async () => {
    await bootWith('claude');
    const res = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('section_unsupported');
  });

  it('opencode (permissions=planned) → 400 section_unsupported на всех методах', async () => {
    await bootWith('opencode');
    for (const m of [
      { method: 'GET' as const, url: '/api/provider-permissions' },
      { method: 'PUT' as const, url: '/api/provider-permissions' },
    ]) {
      const res = await app.inject({
        ...m,
        payload: { approvalPolicy: 'never', sandboxMode: 'read-only' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
  });

  // GEMINI-2: у gemini раздел теперь ready, но модель ДРУГАЯ — codex-черновик в
  // неё не подходит и обязан быть отклонён до записи.
  it('gemini (permissions=ready) → GET 200 с моделью gemini; codex-черновик → 400', async () => {
    await bootWith('gemini');
    const info = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(info.statusCode).toBe(200);
    expect(info.json<{ kind: string }>().kind).toBe('gemini');
    expect(info.json<{ approvalModes: string[] }>().approvalModes).toEqual([
      'default',
      'auto_edit',
      'plan',
    ]);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { approvalPolicy: 'never', sandboxMode: 'read-only' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_draft');
  });

  it('codex → PUT с невалидным enum → 400 invalid_draft', async () => {
    await bootWith('codex');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { approvalPolicy: 'always', sandboxMode: 'read-only' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_draft');
  });
});

/**
 * Полный цикл на подменённом config.toml codex в tmp-HOME. GET читает корневые
 * значения + допустимые наборы, PUT меняет только корневые скаляры (одноимённые
 * ключи в [profiles.x] целы), битый файл → 422.
 */
describe('provider-permissions роуты: codex на tmp-HOME config.toml', () => {
  let home: string;
  let root: string;
  let app: FastifyInstance;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let cfgPath: string;

  const boot = async (): Promise<void> => {
    app = Fastify();
    registerProviderPermissionsRoutes(app, makeCtx(root, 'codex'));
    await app.ready();
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-home-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, '.codex'), { recursive: true });
    cfgPath = join(home, '.codex', 'config.toml');
    root = mkdtempSync(join(tmpdir(), 'cc-pperm-'));
  });
  afterEach(async () => {
    await app?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('GET читает корневые значения + допустимые наборы; PUT меняет только корень, [profiles.x] цел', async () => {
    writeFileSync(
      cfgPath,
      `model = "gpt-5"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.safe]
approval_policy = "untrusted"
sandbox_mode = "read-only"
`,
      'utf8',
    );
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(get.statusCode).toBe(200);
    const body = get.json<{
      providerId: string;
      format: string;
      approvalPolicy: string;
      sandboxMode: string;
      approvalPolicies: string[];
      sandboxModes: string[];
    }>();
    expect(body.providerId).toBe('codex');
    expect(body.format).toBe('toml');
    expect(body.approvalPolicy).toBe('on-request');
    expect(body.sandboxMode).toBe('workspace-write');
    expect(body.approvalPolicies).toEqual(['untrusted', 'on-request', 'never']);
    expect(body.sandboxModes).toEqual(['read-only', 'workspace-write', 'danger-full-access']);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
    });
    expect(put.statusCode).toBe(200);

    const parsed = parseToml(readFileSync(cfgPath, 'utf8')) as {
      model: string;
      approval_policy: string;
      sandbox_mode: string;
      profiles: Record<string, { approval_policy: string; sandbox_mode: string }>;
    };
    expect(parsed.model).toBe('gpt-5');
    // Корневые скаляры изменены.
    expect(parsed.approval_policy).toBe('never');
    expect(parsed.sandbox_mode).toBe('danger-full-access');
    // Одноимённые ключи в профиле НЕ тронуты.
    expect(parsed.profiles.safe!.approval_policy).toBe('untrusted');
    expect(parsed.profiles.safe!.sandbox_mode).toBe('read-only');
  });

  it('битый config.toml → PUT 422 format_unrecognized, файл не тронут', async () => {
    const broken = 'model = "gpt\napproval_policy =';
    writeFileSync(cfgPath, broken, 'utf8');
    await boot();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { approvalPolicy: 'never', sandboxMode: 'read-only' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(cfgPath, 'utf8')).toBe(broken);
  });
});
