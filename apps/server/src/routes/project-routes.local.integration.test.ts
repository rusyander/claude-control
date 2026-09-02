import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Project, ProjectLocalConfig } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { registerProjectLocalRoutes } from './project-local-routes.ts';

/**
 * Чтение собственного `.claude` проекта через API: по id из реестра и по
 * абсолютному пути. Оба маршрута живут рядом с остальными проектными и
 * подчиняются тому же гейту провайдера; писать они ничего не умеют.
 */
describe('project-routes: GET .claude проекта («Из проекта»)', () => {
  let appDataRoot: string;
  let projectDir: string;
  let store: AppStore;
  let app: FastifyInstance;

  const claude = (...parts: string[]): string => join(projectDir, '.claude', ...parts);

  const write = (path: string, content: string): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  /** Минимальный `.claude` проекта: скилл, хук в каждом файле, правило. */
  const seedProject = (): void => {
    write(claude('skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: d\n---\n');
    write(
      claude('settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo own' }] }] } }),
    );
    write(
      claude('settings.local.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo local' }] }] },
      }),
    );
    write(claude('rules', 'style.md'), '---\npaths: "src/**"\n---\n# Стиль\n');
  };

  beforeEach(async () => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-project-'));
    store = new AppStore(appDataRoot);

    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;

    app = Fastify();
    // Регистрируем ОБА модуля, как в index.ts: так проверяется и то, что
    // статический `/api/projects/local` не перехватывается соседями с `:id`.
    registerProjectRoutes(app, ctx);
    registerProjectLocalRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const addProject = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: projectDir },
    });
    expect(res.statusCode).toBe(200);
    return res.json<Project>().id;
  };

  const byPath = (path: string): string => `/api/projects/local?path=${encodeURIComponent(path)}`;

  it('незарегистрированный проект → 404 not_found', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/nope/local' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });

  it('активен не Claude → 400 section_unsupported на обоих маршрутах', async () => {
    const id = await addProject();
    store.updateSettings({ provider: 'cursor' });

    const byId = await app.inject({ method: 'GET', url: `/api/projects/${id}/local` });
    expect(byId.statusCode).toBe(400);
    expect(byId.json<{ error: string }>().error).toBe('section_unsupported');

    const viaPath = await app.inject({ method: 'GET', url: byPath(projectDir) });
    expect(viaPath.statusCode).toBe(400);
    expect(viaPath.json<{ error: string }>().error).toBe('section_unsupported');
  });

  it('по пути: нет path, относительный, несуществующий, файл → 400 invalid_path', async () => {
    write(join(projectDir, 'file.txt'), 'x');
    for (const url of [
      '/api/projects/local',
      byPath('relative/dir'),
      byPath(join(projectDir, 'does-not-exist')),
      byPath(join(projectDir, 'file.txt')),
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: string }>().error, url).toBe('invalid_path');
    }
  });

  it('по id: проект без .claude → exists:false и пустые списки', async () => {
    const id = await addProject();
    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/local` });
    expect(res.statusCode).toBe(200);
    const config = res.json<ProjectLocalConfig>();
    expect(config.exists).toBe(false);
    expect(config.root).toBe(claude());
    expect(config.skills).toEqual([]);
    expect(config.hooks).toEqual([]);
    expect(config.rules).toEqual([]);
  });

  it('по id и по пути отдают одинаковый снимок .claude проекта', async () => {
    seedProject();
    const id = await addProject();

    const byId = await app.inject({ method: 'GET', url: `/api/projects/${id}/local` });
    const viaPath = await app.inject({ method: 'GET', url: byPath(projectDir) });
    expect(byId.statusCode).toBe(200);
    expect(viaPath.statusCode).toBe(200);
    expect(viaPath.json()).toEqual(byId.json());

    const config = byId.json<ProjectLocalConfig>();
    expect(config.exists).toBe(true);
    expect(config.skills.map((skill) => skill.id)).toEqual(['deploy']);
    expect(config.hooks.map((hook) => [hook.command, hook.source])).toEqual([
      ['echo own', 'settings'],
      ['echo local', 'settings-local'],
    ]);
    expect(config.rules.map((rule) => [rule.path, rule.title, rule.paths])).toEqual([
      ['style.md', 'Стиль', ['src/**']],
    ]);
  });

  it('снимок выключенного хука из состояния панели в проектный список не попадает', async () => {
    seedProject();
    const id = await addProject();
    store.rememberDisabledHook({
      id: 'x',
      event: 'Stop',
      command: 'echo remembered',
      isEnabled: false,
      groupIds: [],
      source: 'settings',
    });

    const config = (
      await app.inject({ method: 'GET', url: `/api/projects/${id}/local` })
    ).json<ProjectLocalConfig>();
    expect(config.hooks.map((hook) => hook.command)).toEqual(['echo own', 'echo local']);
    expect(config.hooks.every((hook) => hook.isEnabled && hook.groupIds.length === 0)).toBe(true);
  });

  it('путь нормализуется: `..` внутри пути ведёт к тому же .claude', async () => {
    seedProject();
    const nested = join(projectDir, 'sub', '..');
    const res = await app.inject({ method: 'GET', url: byPath(nested) });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectLocalConfig>().root).toBe(claude());
  });
});
