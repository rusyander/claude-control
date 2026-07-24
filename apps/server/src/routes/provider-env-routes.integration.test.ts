import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderEnvRoutes } from './provider-env-routes.ts';

/**
 * Универсальные env-роуты Codex. Провайдер задаётся настройкой; файл провайдера
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

describe('provider-env роуты: гейтинг по провайдеру (fail-closed)', () => {
  let root: string;
  let app: FastifyInstance;

  const bootWith = async (provider: string): Promise<void> => {
    app = Fastify();
    registerProviderEnvRoutes(app, makeCtx(root, provider));
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-penv-route-'));
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('claude → 400 section_unsupported (у него свои роуты /api/env)', async () => {
    await bootWith('claude');
    const res = await app.inject({ method: 'GET', url: '/api/provider-env' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('section_unsupported');
  });

  // OPENCODE-2: у OpenCode хранить переменные окружения негде — он только
  // подставляет `{env:ПЕРЕМЕННАЯ}` из уже заданного окружения процесса, своего
  // `.env` не читает. Возможность объявлена `unsupported`, роуты обязаны
  // отказывать так же, как у cursor: файл, который никто не прочтёт, не создаём.
  it('opencode (env=unsupported, OPENCODE-2) → 400 section_unsupported на всех методах', async () => {
    await bootWith('opencode');
    for (const m of [
      { method: 'GET' as const, url: '/api/provider-env' },
      { method: 'PUT' as const, url: '/api/provider-env' },
    ]) {
      const res = await app.inject({ ...m, payload: { vars: [{ key: 'A', value: '1' }] } });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
  });

  it('cursor (env≠ready) → 400 section_unsupported на всех методах', async () => {
    await bootWith('cursor');
    for (const m of [
      { method: 'GET' as const, url: '/api/provider-env' },
      { method: 'PUT' as const, url: '/api/provider-env' },
    ]) {
      const res = await app.inject({ ...m, payload: { vars: [] } });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
  });

  // GEMINI-3: у gemini раздел теперь ready (файл .env) — GET обязан отвечать 200.
  it('gemini (env=ready) → GET 200 с форматом dotenv', async () => {
    await bootWith('gemini');
    const res = await app.inject({ method: 'GET', url: '/api/provider-env' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ format: string; providerId: string }>().format).toBe('dotenv');
    expect(res.json<{ providerId: string }>().providerId).toBe('gemini');
  });

  it('codex → PUT с невалидным телом → 400 invalid_draft', async () => {
    await bootWith('codex');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-env',
      payload: { vars: [{ key: '', value: '1' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_draft');
  });
});

/**
 * Полный цикл на подменённом config.toml codex в tmp-HOME. GET читает set, PUT
 * меняет только set (политика/mcp_servers целы), битый файл → 422.
 */
describe('provider-env роуты: codex на tmp-HOME config.toml', () => {
  let home: string;
  let root: string;
  let app: FastifyInstance;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let cfgPath: string;

  const boot = async (): Promise<void> => {
    app = Fastify();
    registerProviderEnvRoutes(app, makeCtx(root, 'codex'));
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
    root = mkdtempSync(join(tmpdir(), 'cc-penv-'));
  });
  afterEach(async () => {
    await app?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('GET читает set; PUT меняет только set, политика и mcp_servers целы', async () => {
    writeFileSync(
      cfgPath,
      `model = "gpt-5"
[shell_environment_policy]
inherit = "all"
set = { CI = "1" }
[mcp_servers.x]
command = "node"
`,
      'utf8',
    );
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-env' });
    expect(get.statusCode).toBe(200);
    const body = get.json<{ providerId: string; format: string; vars: { key: string }[] }>();
    expect(body.providerId).toBe('codex');
    expect(body.format).toBe('toml');
    expect(body.vars.map((v) => v.key)).toEqual(['CI']);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-env',
      payload: {
        vars: [
          { key: 'CI', value: '1' },
          { key: 'NEW', value: '2' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    const parsed = parseToml(readFileSync(cfgPath, 'utf8')) as {
      model: string;
      shell_environment_policy: { inherit: string; set: Record<string, string> };
      mcp_servers: Record<string, unknown>;
    };
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.shell_environment_policy.inherit).toBe('all');
    expect(parsed.shell_environment_policy.set).toEqual({ CI: '1', NEW: '2' });
    expect(parsed.mcp_servers.x).toEqual({ command: 'node' });
  });

  it('битый config.toml → PUT 422 format_unrecognized, файл не тронут', async () => {
    const broken = 'model = "gpt\n[shell_environment_policy\nset =';
    writeFileSync(cfgPath, broken, 'utf8');
    await boot();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-env',
      payload: { vars: [{ key: 'A', value: '1' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(cfgPath, 'utf8')).toBe(broken);
  });
});
