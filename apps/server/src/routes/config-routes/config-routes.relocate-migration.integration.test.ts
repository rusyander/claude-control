import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { GroupAsk } from '../../domains/groups/model.ts';
import { registerConfigRoutes } from './config-routes.ts';
import { registerGroupPathRoutes } from '../group-path-routes/group-path-routes.ts';

/**
 * Ревью 28.09 (F-119): перенос старого «Порядка работы» в «Путь» шёл только
 * на `onReady`. Смена каталога на лету (POST /api/location, PATCH /api/settings)
 * переключала хранилище без переноса: группа из нового каталога показывала
 * пустой путь, а первая же правка пути навсегда отрезала старые шаги.
 *
 * Контекст настоящий (`ServerContext.relocate`), оба каталога — временные.
 */
describe('F-119: перенос «Порядка работы» после смены каталога на лету', () => {
  let root: string;
  let bootDir: string;
  let otherDir: string;
  let app: FastifyInstance;
  let ctx: ServerContext;
  const previousEnv = process.env.CLAUDE_CONFIG_DIR;

  const legacyGroup = (dir: string): void => {
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    new AppStore(join(dir, 'agentdeck')).saveGroup({
      id: 'g1',
      name: 'Задача из трекера',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 0,
      scenario: {
        when: 'когда прилетел тикет',
        trigger: 'PRJ-\\d+',
        steps: [
          { title: 'Забрать тикет', body: 'assign', gate: '' },
          { title: 'Ветка', body: '', gate: '' },
        ],
      },
    });
  };

  const stepsOf = (): number => ctx.store.getGroups()[0]?.path?.steps.length ?? 0;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-relocate-migration-'));
    bootDir = join(root, 'boot');
    otherDir = join(root, 'other');
    mkdirSync(bootDir, { recursive: true });
    legacyGroup(otherDir);
    process.env.CLAUDE_CONFIG_DIR = bootDir;
    ctx = new ServerContext();
    const ask: GroupAsk = async () => '';
    app = Fastify();
    registerConfigRoutes(app, ctx);
    registerGroupPathRoutes(app, ctx, () => ask);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (previousEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousEnv;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('POST /api/location переносит шаги группы нового каталога', async () => {
    const moved = await app.inject({
      method: 'POST',
      url: '/api/location',
      payload: { path: otherDir },
    });
    expect(moved.json<{ isValid: boolean }>().isValid).toBe(true);
    expect(stepsOf()).toBe(2);
    const view = await app.inject({ method: 'GET', url: '/api/groups/g1/path' });
    expect(view.body).toContain('Забрать тикет');
  });

  it('PATCH /api/settings с новым каталогом — то же', async () => {
    const moved = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { claudeDirOverride: otherDir },
    });
    expect(moved.statusCode).toBe(200);
    expect(stepsOf()).toBe(2);
  });
});
