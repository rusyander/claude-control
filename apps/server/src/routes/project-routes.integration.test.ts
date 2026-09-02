import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer, PermissionRule, Project } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProjectRoutes } from './project-routes.ts';

/**
 * Проектный уровень конфигурации: реестр проектов и правка их файлов
 * (CLAUDE.md, .claude/settings.json, .mcp.json) через существующие доменные
 * функции с проектными путями. Каталог .claude создаётся по мере записи.
 */
describe('project-routes: реестр и конфиги проекта', () => {
  let appDataRoot: string;
  let projectDir: string;
  let store: AppStore;
  let app: FastifyInstance;

  const claudeMd = (): string => join(projectDir, 'CLAUDE.md');
  const settingsJson = (): string => join(projectDir, '.claude', 'settings.json');
  const mcpJson = (): string => join(projectDir, '.mcp.json');

  beforeEach(async () => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-project-'));
    store = new AppStore(appDataRoot);

    const ctx = {
      store,
      backupDir: join(appDataRoot, 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerProjectRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** Добавить проект в реестр и вернуть его id. */
  const addProject = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: projectDir },
    });
    expect(res.statusCode).toBe(200);
    return res.json<Project>().id;
  };

  it('реестр: add → list → remove', async () => {
    const id = await addProject();

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json<Project[]>()).toHaveLength(1);
    expect(list.json<Project[]>()[0]?.path).toBe(projectDir);

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(after.json<Project[]>()).toHaveLength(0);
  });

  it('добавление несуществующего каталога отвергается 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: join(projectDir, 'does-not-exist') },
    });
    expect(res.statusCode).toBe(400);
  });

  it('один и тот же каталог не заводится дважды: повтор → 409, имя не переписывается', async () => {
    await addProject();
    // Тот же каталог другим регистром и слэшами, с новым именем.
    const again = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: projectDir.toUpperCase().replace(/\\/g, '/'), name: 'Другое имя' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string; project: Project }>().error).toBe('project_exists');

    const list = (await app.inject({ method: 'GET', url: '/api/projects' })).json<Project[]>();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).not.toBe('Другое имя');
  });

  it('нестроковое имя → 400, а не 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: projectDir, name: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_project');
  });

  it('удаление незнакомого id → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('обращение к незарегистрированному проекту → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/nope/rules' });
    expect(res.statusCode).toBe(404);
  });

  it('rules: PUT пишет CLAUDE.md проекта, GET читает целиком', async () => {
    const id = await addProject();

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/rules`,
      payload: { content: '# Проект\n\nПравила проекта.\n' },
    });
    expect(put.statusCode).toBe(200);
    expect(readFileSync(claudeMd(), 'utf8')).toBe('# Проект\n\nПравила проекта.\n');

    const get = await app.inject({ method: 'GET', url: `/api/projects/${id}/rules` });
    expect(get.json<{ content: string }>().content).toBe('# Проект\n\nПравила проекта.\n');
  });

  it('копии проектных файлов лежат под своим именем, а не под именем пользовательского файла', async () => {
    const id = await addProject();
    const backups = join(appDataRoot, 'backups');

    // Первая запись создаёт файл (копии нет), вторая — снимает копию.
    for (const content of ['# v1\n', '# v2\n']) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/rules`,
        payload: { content },
      });
      expect(put.statusCode).toBe(200);
    }
    for (const pattern of ['Bash(git status:*)', 'Bash(git diff:*)']) {
      const post = await app.inject({
        method: 'POST',
        url: `/api/projects/${id}/permissions`,
        payload: { pattern, decision: 'allow', groupIds: [] },
      });
      expect(post.statusCode).toBe(200);
    }

    const names = readdirSync(backups);
    // Раньше копия `<проект>/CLAUDE.md` называлась `CLAUDE.md.<метка>.bak` — как
    // пользовательская: попадала в её ленту истории, вытесняла её копии из
    // ротации и восстанавливалась поверх ~/.claude/CLAUDE.md.
    expect(names.some((name) => name.startsWith(`project-${id}-CLAUDE.md.`))).toBe(true);
    expect(names.some((name) => name.startsWith(`project-${id}-settings.json.`))).toBe(true);
    expect(names.some((name) => name.startsWith('CLAUDE.md.'))).toBe(false);
    expect(names.some((name) => name.startsWith('settings.json.'))).toBe(false);
  });

  it('rules: нестроковый content отклоняется 400, файл не тронут', async () => {
    const id = await addProject();
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/rules`,
      payload: { content: 'исходный' },
    });

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/rules`,
      payload: { content: 123 },
    });
    expect(bad.statusCode).toBe(400);
    expect(readFileSync(claudeMd(), 'utf8')).toBe('исходный');
  });

  it('mcp: сервер пишется в .mcp.json корня проекта, читается и удаляется', async () => {
    const id = await addProject();
    expect(existsSync(mcpJson())).toBe(false);

    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/mcp`,
      payload: {
        name: 'demo',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'x'],
        env: {},
        headers: {},
        groupIds: [],
      },
    });
    expect(create.statusCode).toBe(200);
    expect(existsSync(mcpJson())).toBe(true);
    // Файл проекта в стандартном формате Claude Code — секция mcpServers.
    const raw = JSON.parse(readFileSync(mcpJson(), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(raw.mcpServers.demo).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: `/api/projects/${id}/mcp` });
    const servers = list.json<McpServer[]>();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe('demo');
    expect(servers[0]?.isEnabled).toBe(true);

    // Выключение — перенос в служебную секцию файла.
    const toggle = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/mcp/demo/enabled`,
      payload: { isEnabled: false },
    });
    expect(toggle.statusCode).toBe(200);
    const afterToggle = (await app.inject({ method: 'GET', url: `/api/projects/${id}/mcp` })).json<
      McpServer[]
    >();
    expect(afterToggle[0]?.isEnabled).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}/mcp/demo` });
    expect(del.statusCode).toBe(200);
    const empty = (await app.inject({ method: 'GET', url: `/api/projects/${id}/mcp` })).json<
      McpServer[]
    >();
    expect(empty).toHaveLength(0);
  });

  it('permissions: каталог .claude создаётся при записи, право читается и удаляется', async () => {
    const id = await addProject();
    expect(existsSync(join(projectDir, '.claude'))).toBe(false);

    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/permissions`,
      payload: { pattern: 'Bash(git status:*)', decision: 'allow' },
    });
    expect(create.statusCode).toBe(200);
    // Запись создала каталог .claude и settings.json в нём.
    expect(existsSync(settingsJson())).toBe(true);

    const list = await app.inject({ method: 'GET', url: `/api/projects/${id}/permissions` });
    const rules = list.json<PermissionRule[]>();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe('Bash(git status:*)');
    expect(rules[0]?.decision).toBe('allow');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/permissions/${encodeURIComponent(rules[0]!.id)}`,
    });
    expect(del.statusCode).toBe(200);
    const empty = (
      await app.inject({ method: 'GET', url: `/api/projects/${id}/permissions` })
    ).json<PermissionRule[]>();
    expect(empty).toHaveLength(0);
  });

  it('permissions: дубль → 409 без записи, незнакомый id на PUT/DELETE → 404', async () => {
    const id = await addProject();
    const payload = { pattern: 'Bash(git status:*)', decision: 'allow' };
    await app.inject({ method: 'POST', url: `/api/projects/${id}/permissions`, payload });
    const before = readFileSync(settingsJson());

    const dup = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/permissions`,
      payload,
    });
    expect(dup.statusCode).toBe(409);
    // Файл лежит в гите проекта — переформатировать его ради no-op нельзя.
    expect(readFileSync(settingsJson()).equals(before)).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/permissions/${encodeURIComponent('deny:Bash(rm:*)')}`,
      payload: { pattern: 'Bash(rm:*)', decision: 'deny' },
    });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/permissions/${encodeURIComponent('deny:Bash(rm:*)')}`,
    });
    expect(del.statusCode).toBe(404);
    expect(readFileSync(settingsJson()).equals(before)).toBe(true);
  });

  it('реестр переживает пересоздание store (слияние состояния)', async () => {
    await addProject();
    // Новый store читает тот же state.json — записанный проект на месте.
    const reopened = new AppStore(appDataRoot);
    expect(reopened.getProjects()).toHaveLength(1);
    expect(reopened.getProjects()[0]?.path).toBe(projectDir);
  });
});
