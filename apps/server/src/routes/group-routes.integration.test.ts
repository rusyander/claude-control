import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Переключатель группы — не отметка в интерфейсе, а настоящая правка файлов:
 * правило уезжает в раздел отключённых CLAUDE.md, хук исчезает из
 * settings.json, папка скилла переезжает в skills-disabled.
 *
 * Здесь всё это проверяется на временном каталоге, а не на настоящем ~/.claude:
 * поднимается живой Fastify с настоящими доменами и дёргается тот же маршрут,
 * что и из панели.
 */
describe('маршруты групп: переключатель гасит участников', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let groupId: string;

  const settingsPath = (): string => join(root, 'settings.json');
  const claudeMdPath = (): string => join(root, 'CLAUDE.md');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-routes-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    mkdirSync(join(root, 'skills', 'мой-скилл'), { recursive: true });
    writeFileSync(join(root, 'skills', 'мой-скилл', 'SKILL.md'), '---\nname: мой-скилл\n---\nтело');

    writeFileSync(
      claudeMdPath(),
      '# Правила\n\n## ПРАВИЛО: моё правило\n\nТекст правила.\n',
      'utf8',
    );
    writeFileSync(
      settingsPath(),
      JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo групповой' }] }] } },
        null,
        2,
      ),
    );

    store = new AppStore(join(root, 'claude-control'));

    const ctx = {
      location: {
        paths: {
          root,
          settings: settingsPath(),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: claudeMdPath(),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
        },
      },
      store,
      backupDir: join(root, 'claude-control', 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerGroupRoutes(app, ctx);
    registerEntityRoutes(app, ctx);
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: {
        name: 'Набор под задачу',
        members: [
          { kind: 'rule', id: 'moe-pravilo' },
          { kind: 'skill', id: 'мой-скилл' },
          { kind: 'hook', id: 'Stop:0:0' },
        ],
      },
    });
    groupId = created.json<{ id: string }>().id;
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const toggle = (isEnabled: boolean) =>
    app.inject({ method: 'POST', url: `/api/groups/${groupId}/enabled`, payload: { isEnabled } });

  it('выключение группы гасит все её участники разом', async () => {
    const res = await toggle(false);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ affected: number }>().affected).toBe(3);

    // Скилл физически уехал в skills-disabled.
    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(false);
    expect(existsSync(join(root, 'skills-disabled', 'мой-скилл'))).toBe(true);

    // Хук исчез из settings.json.
    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks?: Record<string, unknown[]>;
    };
    expect(settings.hooks?.Stop ?? []).toHaveLength(0);

    // Правило уехало в раздел отключённых.
    expect(readFileSync(claudeMdPath(), 'utf8')).toMatch(/Отключённые|disabled/i);
  });

  it('включение группы возвращает участников на место', async () => {
    await toggle(false);
    await toggle(true);

    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.hooks?.Stop?.[0]?.hooks[0]?.command).toBe('echo групповой');
  });

  it('участник, выключенный вручную, не оживает при включении группы', async () => {
    // Человек выключил скилл сам, отдельно от группы.
    await app.inject({
      method: 'POST',
      url: '/api/entities/skill/мой-скилл/enabled',
      payload: { isEnabled: false },
    });

    await toggle(false);
    await toggle(true);

    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(false);
    expect(store.isDisabledManually('skill', 'мой-скилл')).toBe(true);
  });

  it('одиночный переключатель не может включить то, что гасит группа', async () => {
    await toggle(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/entities/skill/мой-скилл/enabled',
      payload: { isEnabled: true },
    });

    expect(res.statusCode).toBe(200);
    // Группа всё ещё выключена — скилл остаётся погашенным.
    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(false);
  });

  it('команда выключенного хука не теряется: включение возвращает её дословно', async () => {
    // Регрессия найденного бага: хук выключается удалением из settings.json,
    // а его текст жил только там — включить обратно было нечего.
    await app.inject({
      method: 'POST',
      url: '/api/entities/hook/Stop:0:0/enabled',
      payload: { isEnabled: false },
    });

    const afterOff = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      { command: string; isEnabled: boolean }[]
    >();
    // Хук остался в списке — выключенным, с целой командой.
    expect(afterOff).toHaveLength(1);
    expect(afterOff[0]?.isEnabled).toBe(false);
    expect(afterOff[0]?.command).toBe('echo групповой');

    await app.inject({
      method: 'POST',
      url: '/api/entities/hook/Stop:0:0/enabled',
      payload: { isEnabled: true },
    });

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.hooks?.Stop?.[0]?.hooks[0]?.command).toBe('echo групповой');
  });

  it('состояние группы сохраняется', async () => {
    await toggle(false);

    const groups = await app.inject({ method: 'GET', url: '/api/groups' });
    expect(groups.json<{ isEnabled: boolean }[]>()[0]?.isEnabled).toBe(false);
  });

  it('удаление выключенной группы отпускает её участников', async () => {
    await toggle(false);
    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(false);

    await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}` });

    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(true);
    expect(store.disablingGroups('skill', 'мой-скилл')).toEqual([]);
  });

  it('переключение несуществующей группы — 404, а не тихий успех', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/нет-такой/enabled',
      payload: { isEnabled: false },
    });

    expect(res.statusCode).toBe(404);
  });

  const readEnv = (): Record<string, string> =>
    (JSON.parse(readFileSync(settingsPath(), 'utf8')) as { env?: Record<string, string> }).env ??
    {};

  it('переменные группы уходят в settings.json при включении и снимаются при выключении', async () => {
    // Раньше поле env группы сохранялось, но в settings.json не попадало.
    await app.inject({
      method: 'PUT',
      url: `/api/groups/${groupId}`,
      payload: { name: 'g', members: [], env: { MY_VAR: '123', TOKEN: 'abc' }, isEnabled: true },
    });
    expect(readEnv().MY_VAR).toBe('123');
    expect(readEnv().TOKEN).toBe('abc');

    await toggle(false);
    expect(readEnv().MY_VAR).toBeUndefined();
    expect(readEnv().TOKEN).toBeUndefined();
  });

  it('ручную переменную с тем же именем группа не затирает и не удаляет', async () => {
    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      env?: Record<string, string>;
    };
    settings.env = { MANUAL: 'keep' };
    writeFileSync(settingsPath(), JSON.stringify(settings));

    await app.inject({
      method: 'PUT',
      url: `/api/groups/${groupId}`,
      payload: { name: 'g', members: [], env: { MANUAL: 'group', OWN: 'x' }, isEnabled: true },
    });
    // Ручную не тронули, свою добавили.
    expect(readEnv().MANUAL).toBe('keep');
    expect(readEnv().OWN).toBe('x');

    await toggle(false);
    // Ручная осталась, свою сняли.
    expect(readEnv().MANUAL).toBe('keep');
    expect(readEnv().OWN).toBeUndefined();
  });
});

/**
 * Записи из settings.local.json панель показывает, но не правит. Отказ должен
 * быть явным: молчаливое «сохранено» без записи хуже отказа.
 */
describe('маршруты сущностей: локальные настройки только на чтение', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-local-routes-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'основной' }] }] } }),
    );
    writeFileSync(
      join(root, 'settings.local.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'локальный' }] }] },
        permissions: { deny: ['Bash(rm:*)'] },
        env: { PERSONAL: 'моё' },
      }),
    );

    const ctx = {
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
        },
      },
      store: new AppStore(join(root, 'claude-control')),
      backupDir: join(root, 'claude-control', 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerEntityRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/hooks отдаёт записи обоих файлов с пометкой источника', async () => {
    const hooks = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      { command: string; source: string }[]
    >();

    expect(hooks).toHaveLength(2);
    expect(hooks.find((hook) => hook.command === 'локальный')?.source).toBe('settings-local');
  });

  it('GET /api/permissions показывает локальный запрет', async () => {
    const rules = (await app.inject({ method: 'GET', url: '/api/permissions' })).json<
      { pattern: string; source: string }[]
    >();

    expect(rules.find((rule) => rule.pattern === 'Bash(rm:*)')?.source).toBe('settings-local');
  });

  it('GET /api/env показывает локальную переменную', async () => {
    const vars = (await app.inject({ method: 'GET', url: '/api/env' })).json<
      { key: string; source: string }[]
    >();

    expect(vars.find((item) => item.key === 'PERSONAL')?.source).toBe('settings-local');
  });

  /**
   * Правка локальной записи возвращается в свой файл. Это главное свойство:
   * личная настройка не должна переехать в общий конфиг и начать действовать
   * шире, чем её задумывали, — и наоборот, общая не должна уйти в личный.
   */
  it('удаление локального хука убирает его из локального файла', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      { id: string; source: string }[]
    >();
    const local = before.find((hook) => hook.source === 'settings-local');

    const res = await app.inject({ method: 'DELETE', url: `/api/hooks/${local!.id}` });
    expect(res.statusCode).toBe(200);

    expect(readFileSync(join(root, 'settings.local.json'), 'utf8')).not.toContain('локальный');
    // Основной файл не тронут.
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toContain('основной');
  });

  it('удаление локального права трогает только локальный файл', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/permissions/${encodeURIComponent('local:deny:Bash(rm:*)')}`,
    });
    expect(res.statusCode).toBe(200);

    const rules = (await app.inject({ method: 'GET', url: '/api/permissions' })).json<
      { pattern: string }[]
    >();
    expect(rules.find((rule) => rule.pattern === 'Bash(rm:*)')).toBeUndefined();
  });

  it('удаление локальной переменной трогает только локальный файл', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/env?key=PERSONAL&source=settings-local',
    });
    expect(res.statusCode).toBe(200);

    expect(readFileSync(join(root, 'settings.local.json'), 'utf8')).not.toContain('PERSONAL');
  });

  it('правка обычного хука по-прежнему работает и не задевает локальный файл', async () => {
    const hooks = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      { id: string; source: string }[]
    >();
    const own = hooks.find((hook) => hook.source === 'settings');

    const res = await app.inject({ method: 'DELETE', url: `/api/hooks/${own!.id}` });

    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(root, 'settings.local.json'), 'utf8')).toContain('локальный');
  });
});
