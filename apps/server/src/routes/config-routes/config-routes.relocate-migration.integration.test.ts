import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { registerConfigRoutes } from './config-routes.ts';

/**
 * Разовая отмена недоведённых прежних групп (этап 10, F1) нужна и каталогу, на который
 * переключились на лету (POST /api/location, PATCH /api/settings): у него свой state.json,
 * а сборка отменяла только план каталога, с которым панель стартовала.
 *
 * Контекст настоящий (`ServerContext.relocate`), оба каталога — временные.
 */
describe('смена каталога на лету отменяет недоведённые прежние группы нового каталога', () => {
  let root: string;
  let bootDir: string;
  let otherDir: string;
  let app: FastifyInstance;
  let ctx: ServerContext;
  const previousEnv = process.env.CLAUDE_CONFIG_DIR;

  const halfRunPlan = (dir: string): void => {
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    new AppStore(join(dir, 'agentdeck')).setSplitPlan({
      parentChatId: 'half',
      projectPath: join(dir, 'repo'),
      createdAt: '2026-10-01T00:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [] },
      groups: [{ index: 0, title: 'g', branch: 'b', after: [], status: 'started' }],
    } as unknown as SplitPlanRecord);
  };

  const cancelledAt = (): string | undefined => ctx.store.getSplitPlans().half?.cancelledAt;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-relocate-migration-'));
    bootDir = join(root, 'boot');
    otherDir = join(root, 'other');
    mkdirSync(bootDir, { recursive: true });
    halfRunPlan(otherDir);
    process.env.CLAUDE_CONFIG_DIR = bootDir;
    ctx = new ServerContext();
    app = Fastify();
    registerConfigRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (previousEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousEnv;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('POST /api/location — план нового каталога отменён, повторное переключение его не трогает', async () => {
    const moved = await app.inject({
      method: 'POST',
      url: '/api/location',
      payload: { path: otherDir },
    });
    expect(moved.json<{ isValid: boolean }>().isValid).toBe(true);
    const first = cancelledAt();
    expect(first).toBeTruthy();
    await app.inject({ method: 'POST', url: '/api/location', payload: { path: otherDir } });
    expect(cancelledAt()).toBe(first);
  });

  it('PATCH /api/settings с новым каталогом — то же', async () => {
    const moved = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { claudeDirOverride: otherDir },
    });
    expect(moved.statusCode).toBe(200);
    expect(cancelledAt()).toBeTruthy();
  });
});
