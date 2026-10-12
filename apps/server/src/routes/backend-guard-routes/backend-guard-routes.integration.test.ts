import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendGuardSettings, BackendGuardStatus } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerBackendGuardRoutes } from './backend-guard-routes.ts';

/**
 * Маршруты защиты бэкенда целиком по HTTP: тело, граница «свой проект», 409 на
 * настройках без защиты, установка → настройки → снятие и «Проверить команду»
 * по НЕсохранённым настройкам формы. Ничего не подменено — файлы во временном
 * проекте.
 */

const SETTINGS: BackendGuardSettings = { prodMarkers: ['db.prod.internal'], disabled: [] };

describe('backend-guard: маршруты', () => {
  let app: FastifyInstance;
  let root: string;
  let project: string;
  let stranger: string;
  let store: AppStore;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-guard-routes-')));
    project = join(root, 'shop');
    stranger = join(root, 'other');
    for (const dir of [project, stranger]) mkdirSync(dir, { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.addProject({ id: 'shop', name: 'shop', path: project });
    app = Fastify();
    registerBackendGuardRoutes(app, {
      store,
      backupDir: join(root, 'backups'),
    } as unknown as ServerContext);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const get = (path: string) =>
    app.inject({ method: 'GET', url: `/api/backend-guard?path=${encodeURIComponent(path)}` });
  const post = (url: string, payload: Record<string, unknown>, method: 'POST' | 'PUT' = 'POST') =>
    app.inject({ method, url, payload });

  it('без пути — 400, чужой каталог — 403, ничего не записано', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/backend-guard' })).json()).toMatchObject({
      code: 'guard-path-required',
    });
    const refused = await post('/api/backend-guard/install', {
      path: stranger,
      settings: SETTINGS,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'guard-project-unregistered' });
    expect(existsSync(join(stranger, '.claude'))).toBe(false);
  });

  it('настройки до установки — 409 и никакого файла', async () => {
    const response = await post(
      '/api/backend-guard/settings',
      { path: project, settings: SETTINGS },
      'PUT',
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'guard-not-installed' });
    expect(existsSync(join(project, '.claude', 'backend-guard.json'))).toBe(false);
  });

  it('метка прода короче трёх знаков — 400 по схеме', async () => {
    const response = await post('/api/backend-guard/install', {
      path: project,
      settings: { prodMarkers: ['pr'], disabled: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('установка → настройки → снятие', async () => {
    expect((await get(project)).json<BackendGuardStatus>().state).toBe('none');

    const installed = (
      await post('/api/backend-guard/install', { path: project, settings: SETTINGS, lang: 'en' })
    ).json<BackendGuardStatus>();
    expect(installed).toMatchObject({
      state: 'installed',
      groupName: 'Backend guard · shop',
      files: {
        script: '.claude/hooks/backend-guard.mjs',
        settings: '.claude/settings.json',
        rule: '.claude/rules/backend-safety.md',
        config: '.claude/backend-guard.json',
      },
    });

    const saved = (
      await post(
        '/api/backend-guard/settings',
        { path: project, settings: { prodMarkers: ['10.0.0.5'], disabled: ['infra-change'] } },
        'PUT',
      )
    ).json<BackendGuardStatus>();
    expect(saved.settings).toEqual({ prodMarkers: ['10.0.0.5'], disabled: ['infra-change'] });
    expect((await get(project)).json<BackendGuardStatus>().settings.disabled).toEqual([
      'infra-change',
    ]);

    const removed = (
      await post('/api/backend-guard/remove', { path: project })
    ).json<BackendGuardStatus>();
    expect(removed.state).toBe('none');
    expect(store.getGroups()).toEqual([]);
  });

  it('проверка команды — по настройкам из формы, без установки', async () => {
    const check = (command: string, settings = SETTINGS) =>
      post('/api/backend-guard/check', { command, settings }).then((response) => response.json());
    expect(await check('psql -h db.prod.internal -c "select 1"')).toEqual({
      hit: { rule: 'prod-target', match: 'db.prod.internal' },
    });
    expect(await check('npm test')).toEqual({});
    expect(
      await check('terraform destroy', { prodMarkers: [], disabled: ['infra-change'] }),
    ).toEqual({});
  });
});
