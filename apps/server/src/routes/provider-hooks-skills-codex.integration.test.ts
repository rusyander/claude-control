import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderHooksInfo, ProviderSkillsInfo } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderHooksRoutes } from './provider-hooks-routes.ts';
import { registerProviderSkillsRoutes } from './provider-skills-routes.ts';

/**
 * MAP 26, маршруты при активном Codex: `/api/provider-hooks` и `/api/provider-skills`.
 *
 * Дом временный целиком: `CODEX_HOME` (hooks.json, config.toml) и `HOME`/
 * `USERPROFILE` (личный каталог скиллов `~/.agents/skills`), — настоящий `~`
 * пользователя не читается и не пишется. Форма файла сверена живым app-server
 * (`hooks/list`): `timeout` в секундах, `timeoutSec` CLI не читает; здесь
 * проверяется, что панель пишет ровно эту форму и отказывает там, где CLI молча
 * исказил бы правило.
 */
describe('Codex: хуки в hooks.json и скиллы в ~/.agents/skills', () => {
  let appDataRoot: string;
  let home: string;
  let codexHome: string;
  let app: FastifyInstance | undefined;
  const saved: Record<string, string | undefined> = {};
  const keys = ['CODEX_HOME', 'HOME', 'USERPROFILE'] as const;

  const boot = async (): Promise<void> => {
    const store = new AppStore(appDataRoot);
    store.updateSettings({ provider: 'codex' });
    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;
    app = Fastify();
    registerProviderHooksRoutes(app, ctx);
    registerProviderSkillsRoutes(app, ctx);
    await app.ready();
  };

  const hooksFile = (): string => join(codexHome, 'hooks.json');
  const getHooks = async (): Promise<ProviderHooksInfo> =>
    (await app!.inject({ method: 'GET', url: '/api/provider-hooks' })).json<ProviderHooksInfo>();
  const putRules = (rules: unknown[]) =>
    app!.inject({ method: 'PUT', url: '/api/provider-hooks', payload: { rules } });

  beforeEach(() => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    home = mkdtempSync(join(tmpdir(), 'cc-codex-home-'));
    codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    for (const key of keys) saved[key] = process.env[key];
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('сводка хуков: hooks.json, двенадцать событий, секунды, свои пределы и одобрение', async () => {
    await boot();
    const info = await getHooks();
    expect(info.format).toBe('codex-json');
    expect(info.shape).toBe('event-rules');
    expect(info.filePath).toBe(hooksFile());
    expect(info.present).toBe(false);
    expect(info.readOnly).toBe(false);
    expect(info.events.map((event) => event.name)).toHaveLength(12);
    expect(info.timeoutUnit).toBe('s');
    expect(info.timeoutDefault).toBe(600);
    expect(info.trustRequired).toBe(true);
    const byName = new Map(info.events.map((event) => [event.name, event]));
    expect(byName.get('Interrupt')).toMatchObject({ timeoutMax: 3, timeoutDefault: 1 });
    expect(byName.get('SessionEnd')).toMatchObject({ timeoutMax: 3, timeoutDefault: 1 });
    expect(byName.get('UserPromptSubmit')?.supportsMatcher).toBe(false);
    expect(byName.get('PreToolUse')?.supportsMatcher).toBe(true);
    // Чтение файла не создаёт.
    expect(existsSync(hooksFile())).toBe(false);
  });

  it('запись: форма Claude, `timeout` в секундах, чужой ключ корня цел, round-trip', async () => {
    writeFileSync(hooksFile(), JSON.stringify({ description: 'мои хуки', hooks: {} }, null, 2));
    await boot();
    const rules = [
      { event: 'PreToolUse', matcher: '^Bash$', command: 'node guard.js', timeout: 30 },
      { event: 'Stop', command: 'node stop.js' },
      { event: 'Interrupt', command: 'node int.js', timeout: 3 },
    ];
    const res = await putRules(rules);
    expect(res.statusCode, res.body).toBe(200);

    const written = JSON.parse(readFileSync(hooksFile(), 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({
      description: 'мои хуки',
      hooks: {
        PreToolUse: [
          {
            matcher: '^Bash$',
            hooks: [{ type: 'command', command: 'node guard.js', timeout: 30 }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }],
        Interrupt: [{ hooks: [{ type: 'command', command: 'node int.js', timeout: 3 }] }],
      },
    });
    expect(JSON.stringify(written)).not.toContain('timeoutSec');

    const info = await getHooks();
    expect(info.present).toBe(true);
    expect(info.rules).toEqual(rules);
  });

  it('отказ ДО записи: Interrupt дольше 3 с, матчер у UserPromptSubmit, чужое событие', async () => {
    await boot();
    for (const rules of [
      [{ event: 'Interrupt', command: 'x', timeout: 4 }],
      [{ event: 'SessionEnd', command: 'x', timeout: 30 }],
      [{ event: 'UserPromptSubmit', matcher: 'x', command: 'x' }],
      [{ event: 'Notification', command: 'x' }],
      [{ event: 'PreToolUse', command: 'x', timeout: 3601 }],
    ]) {
      const res = await putRules(rules);
      expect(res.statusCode, JSON.stringify(rules)).toBe(400);
    }
    expect(existsSync(hooksFile())).toBe(false);
    // Граница внутри: ровно 3 с у Interrupt и 3600 у прочих принимаются.
    const ok = await putRules([
      { event: 'Interrupt', command: 'x', timeout: 3 },
      { event: 'PreToolUse', command: 'y', timeout: 3600 },
    ]);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('событие чужой формы (commandWindows) сохраняется целиком, черновик с ним → 422', async () => {
    const foreign = [{ hooks: [{ type: 'command', command: 'sh a.sh', commandWindows: 'a.cmd' }] }];
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { SessionStart: foreign } }));
    await boot();
    const info = await getHooks();
    expect(info.preservedRules.map((entry) => entry.key)).toEqual(['SessionStart']);

    const refused = await putRules([{ event: 'SessionStart', command: 'x' }]);
    expect(refused.statusCode).toBe(422);

    const res = await putRules([{ event: 'Stop', command: 'node stop.js' }]);
    expect(res.statusCode, res.body).toBe(200);
    const written = JSON.parse(readFileSync(hooksFile(), 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    expect(written.hooks.SessionStart).toEqual(foreign);
  });

  it('config.toml рядом: рубильник [features] hooks = false и таблицы [[hooks.X]] названы', async () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        '[features]',
        'hooks = false',
        '',
        '[[hooks.Stop]]',
        '[[hooks.Stop.hooks]]',
        'type = "command"',
        'command = "echo toml"',
        '',
      ].join('\n'),
    );
    await boot();
    const info = await getHooks();
    expect(info.disableAll).toBe(true);
    expect(info.alsoDefinedIn).toBe(join(codexHome, 'config.toml'));
  });

  it('устаревшее имя рубильника codex_hooks тоже названо; без таблиц — без пути', async () => {
    writeFileSync(join(codexHome, 'config.toml'), '[features]\ncodex_hooks = false\n');
    await boot();
    const info = await getHooks();
    expect(info.disableAll).toBe(true);
    expect(info.alsoDefinedIn).toBeUndefined();
  });

  it('битый config.toml раздел хуков не роняет', async () => {
    writeFileSync(join(codexHome, 'config.toml'), '[features\nhooks = ');
    await boot();
    const res = await app!.inject({ method: 'GET', url: '/api/provider-hooks' });
    expect(res.statusCode).toBe(200);
    const info = res.json<ProviderHooksInfo>();
    expect(info.readOnly).toBe(false);
    expect(info.disableAll).toBeUndefined();
  });

  it('скиллы: каталог ~/.agents/skills, $CODEX_HOME/skills назван, запись ложится в первый', async () => {
    await boot();
    const info = (
      await app!.inject({ method: 'GET', url: '/api/provider-skills' })
    ).json<ProviderSkillsInfo>();
    const agentsDir = join(home, '.agents', 'skills');
    expect(info.skillsDir).toBe(agentsDir);
    expect(info.externalDirs.map((dir) => dir.path)).toEqual([join(codexHome, 'skills')]);

    const res = await app!.inject({
      method: 'PUT',
      url: '/api/provider-skills/skill',
      payload: { path: 'greet/SKILL.md', name: 'greet', description: 'Say hi', body: 'Hi.\n' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const text = readFileSync(join(agentsDir, 'greet', 'SKILL.md'), 'utf8');
    expect(text).toContain('name: greet');
    expect(text).toContain('description: Say hi');
    expect(existsSync(join(codexHome, 'skills'))).toBe(false);
  });

  it('скиллы: имя длиннее 64 знаков — 400, как отказал бы сам CLI', async () => {
    await boot();
    const name = `n${'a'.repeat(64)}`;
    const res = await app!.inject({
      method: 'PUT',
      url: '/api/provider-skills/skill',
      payload: { path: `${name}/SKILL.md`, name, description: 'x', body: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('skill-name-too-long');
    expect(existsSync(join(home, '.agents', 'skills', name))).toBe(false);
  });
});
