import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CascadeRuleView } from '@agentdeck/contracts/model-cascade';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { registerChatCascadeRoutes } from './cascade-routes.ts';

/**
 * «Ревью после работы» рядом с подбором модели (Telegram R3(d), 26.10) на настоящем
 * Fastify и настоящем хранилище: два тумблера одного правила проекта, и запись
 * одного не трогает другой — ради этого тумблер и заведён отдельно.
 */
describe('PUT/GET /api/chat/cascade — «Ревью после работы»', () => {
  let dir: string;
  let project: string;
  let store: AppStore;
  let app: FastifyInstance;

  const read = async (path = project): Promise<CascadeRuleView> =>
    (
      await app.inject({ method: 'GET', url: `/api/chat/cascade?path=${encodeURIComponent(path)}` })
    ).json<CascadeRuleView>();
  const write = async (body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/chat/cascade', payload: { path: project, ...body } });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-review-after-'));
    project = join(dir, 'repo');
    mkdirSync(project);
    store = new AppStore(join(dir, 'app'));
    app = Fastify();
    registerChatCascadeRoutes(app, {
      store,
      location: { paths: { appData: join(dir, 'app') } },
    } as unknown as ServerContext);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('умолчание — оба включены', async () => {
    expect(await read()).toMatchObject({ enabled: true, reviewAfterWork: true });
  });

  it('выключенное ревью не трогает подбор, и действует в копии ветки', async () => {
    const response = await write({ reviewAfterWork: false });

    expect(response.statusCode).toBe(200);
    expect(response.json<CascadeRuleView>()).toMatchObject({
      enabled: true,
      reviewAfterWork: false,
    });
    expect(await read()).toMatchObject({ enabled: true, reviewAfterWork: false });
    expect(await read(join(`${project}-worktrees`, 'feature-x'))).toMatchObject({
      reviewAfterWork: false,
    });
    expect(store.getProjectReviewEntries()).toHaveLength(1);
  });

  it('выключенный подбор не трогает ревью; старое тело `{ path }` включает подбор', async () => {
    await write({ enabled: false });
    // Запись ревью при выключенном подборе не включает его обратно.
    await write({ reviewAfterWork: false });
    expect(await read()).toMatchObject({ enabled: false, reviewAfterWork: false });

    await write({});
    expect(await read()).toMatchObject({ enabled: true, reviewAfterWork: false });

    await write({ reviewAfterWork: true });
    expect(await read()).toMatchObject({ enabled: true, reviewAfterWork: true });
    // Включённое — возврат к умолчанию: записи не остаётся.
    expect(store.getProjectReviewEntries()).toEqual([]);
  });
});
