import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

  it('cursor и aider (permissions не заявлены) → 400 section_unsupported на всех методах', async () => {
    for (const provider of ['cursor', 'aider']) {
      await bootWith(provider);
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
      await app.close();
    }
  });

  // OPENCODE-1: у opencode раздел стал ready, но модель ТРЕТЬЯ — ни codex-, ни
  // gemini-черновик в неё не подходят и обязаны быть отклонены до записи.
  it('opencode (permissions=ready) → GET 200 с моделью opencode; чужой черновик → 400', async () => {
    await bootWith('opencode');
    const info = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(info.statusCode).toBe(200);
    const body = info.json<{ kind: string; levels: string[]; tools: string[] }>();
    expect(body.kind).toBe('opencode');
    expect(body.levels).toEqual(['allow', 'deny', 'ask']);
    expect(body.tools).toEqual(['edit', 'bash', 'webfetch']);

    for (const payload of [
      { approvalPolicy: 'never', sandboxMode: 'read-only' },
      { approvalMode: 'plan', coreTools: [], excludeTools: [] },
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/provider-permissions', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_draft');
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

/**
 * OPENCODE-1: полный цикл на подменённом `opencode.json` в tmp-HOME. GET читает
 * ключ `permission` + наборы для селектов, PUT меняет ТОЛЬКО этот ключ (`$schema`,
 * `model`, `mcp`, `agent` целы), незнакомая запись внутри `permission` переживает
 * запись, битый JSON → 422. Настоящий ~ не трогаем.
 */
describe('provider-permissions роуты: opencode на tmp-HOME opencode.json', () => {
  let home: string;
  let root: string;
  let app: FastifyInstance;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let prevXdg: string | undefined;
  let prevOpencodeConfig: string | undefined;
  let cfgPath: string;

  const boot = async (): Promise<void> => {
    app = Fastify();
    registerProviderPermissionsRoutes(app, makeCtx(root, 'opencode'));
    await app.ready();
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-home-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevOpencodeConfig = process.env.OPENCODE_CONFIG;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_CONFIG;
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    cfgPath = join(home, '.config', 'opencode', 'opencode.json');
    root = mkdtempSync(join(tmpdir(), 'cc-pperm-oc-'));
  });
  afterEach(async () => {
    await app?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevOpencodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = prevOpencodeConfig;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const CONFIG = JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4',
      mcp: { probe: { type: 'local', command: ['node', 'x.js'] } },
      agent: { review: { permission: { edit: 'deny' } } },
      permission: { edit: 'deny', bash: 'ask', deploy: 'ask' },
    },
    null,
    2,
  );

  it('GET читает permission и наборы; PUT меняет только его, прочие ключи целы', async () => {
    writeFileSync(cfgPath, CONFIG, 'utf8');
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(get.statusCode).toBe(200);
    const body = get.json<{
      providerId: string;
      format: string;
      entries: { tool: string; mode: string; level?: string }[];
      preserved: { key: string; value: string }[];
      patternTools: string[];
      usingDefaults: boolean;
    }>();
    expect(body.providerId).toBe('opencode');
    expect(body.format).toBe('opencode-json');
    expect(body.entries).toEqual([
      { tool: 'edit', mode: 'level', level: 'deny' },
      { tool: 'bash', mode: 'level', level: 'ask' },
    ]);
    // Чужой инструмент показан отдельно и только для чтения.
    expect(body.preserved).toEqual([{ key: 'deploy', value: '"ask"' }]);
    expect(body.patternTools).toEqual(['bash']);
    expect(body.usingDefaults).toBe(false);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: {
        entries: [
          { tool: 'edit', mode: 'level', level: 'allow' },
          {
            tool: 'bash',
            mode: 'patterns',
            patterns: [
              { pattern: '*', level: 'ask' },
              { pattern: 'git push *', level: 'deny' },
            ],
          },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    const written = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const before = JSON.parse(CONFIG) as Record<string, unknown>;
    expect(written.$schema).toEqual(before.$schema);
    expect(written.model).toEqual(before.model);
    expect(written.mcp).toEqual(before.mcp);
    expect(written.agent).toEqual(before.agent);
    expect(written.permission).toEqual({
      edit: 'allow',
      bash: { '*': 'ask', 'git push *': 'deny' },
      // Незнакомая запись сохранена как была.
      deploy: 'ask',
    });
  });

  it('уровень вне набора → 400 invalid_draft, файл не тронут', async () => {
    writeFileSync(cfgPath, CONFIG, 'utf8');
    await boot();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { entries: [{ tool: 'bash', mode: 'level', level: 'sometimes' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_draft');
    expect(readFileSync(cfgPath, 'utf8')).toBe(CONFIG);
  });

  it('битый opencode.json → GET readOnly, PUT 422 format_unrecognized, файл не тронут', async () => {
    const broken = '{ "permission": { "edit": ';
    writeFileSync(cfgPath, broken, 'utf8');
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ readOnly: boolean }>().readOnly).toBe(true);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { entries: [{ tool: 'edit', mode: 'level', level: 'ask' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(cfgPath, 'utf8')).toBe(broken);
  });

  it('OPENCODE_CONFIG переносит файл прав целиком', async () => {
    const moved = join(root, 'elsewhere', 'oc.json');
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(moved, JSON.stringify({ permission: { webfetch: 'deny' } }), 'utf8');
    process.env.OPENCODE_CONFIG = moved;
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-permissions' });
    expect(get.json<{ filePath: string }>().filePath).toBe(moved);
    expect(get.json<{ entries: { tool: string }[] }>().entries).toEqual([
      { tool: 'webfetch', mode: 'level', level: 'deny' },
    ]);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-permissions',
      payload: { entries: [{ tool: 'edit', mode: 'level', level: 'ask' }] },
    });
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(moved, 'utf8'))).toEqual({ permission: { edit: 'ask' } });
    // Канонический путь при этом не создавался.
    expect(existsSync(cfgPath)).toBe(false);
  });
});
