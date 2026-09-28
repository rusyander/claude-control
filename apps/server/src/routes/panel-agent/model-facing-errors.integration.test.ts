import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { PanelActionResult } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { ServerContext } from '../../context.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';
import { PANEL_ACTIONS } from './actions.ts';
import { definePanelAction } from './registry.ts';

/**
 * Отказ действия уходит модели текстом, и адрес маршрута в нём — это рассказ о
 * том, как панель устроена внутри: промпт агента запрещает ему говорить про
 * `/api/…`, а сам отказ подсовывал адрес («Route GET:/api/rules not found»).
 *
 * Приложение здесь несёт ТОЛЬКО маршруты агента: всё, что зовут действия, в нём
 * отсутствует, и Fastify отвечает своим 404 с адресом внутри — ровно тот текст,
 * который протекал. Действия настоящие, путь настоящий: `POST /api/agent/actions/:name`.
 */
describe('отказ действия глазами модели — без адресов маршрутов', () => {
  let appData: string;
  let app: FastifyInstance;

  const leaky = definePanelAction({
    name: 'leaky_local',
    section: 'test',
    risk: 'read',
    description: 'd',
    input: z.object({}),
    local: () => {
      throw new Error('fetch http://127.0.0.1:5178/api/chats/abc/messages failed: ECONNRESET');
    },
  });

  beforeAll(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-errors-'));
    const ctx = {
      store: { getSettings: () => ({ language: 'ru' }) },
      location: { paths: { appData } },
    } as unknown as ServerContext;
    app = Fastify();
    registerPanelAgentRoutes(app, ctx, {
      hub: createEventHub(),
      pending: new PanelPendingActions(10_000),
      access: {
        allowedOrigins: allowedOrigins(8888),
        requiresToken: () => false,
        expectedToken: () => '',
      },
      actions: [...PANEL_ACTIONS, leaky],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(appData, { recursive: true, force: true });
  });

  const call = async (name: string): Promise<PanelActionResult> =>
    (
      await app.inject({
        method: 'POST',
        url: `/api/agent/actions/${name}`,
        headers: { [PANEL_AGENT_HEADER]: '1' },
        payload: { input: {} },
      })
    ).json<PanelActionResult>();

  it('каждое действие чтения, принимающее пустой вход: в тексте отказа нет /api/', async () => {
    const reads = PANEL_ACTIONS.filter(
      (action) => action.risk === 'read' && action.input.safeParse({}).success,
    );
    expect(reads.length).toBeGreaterThan(10);
    const leaks: string[] = [];
    let failed = 0;
    for (const action of reads) {
      const result = await call(action.name);
      if (result.outcome === 'failed') failed += 1;
      if (/\/api\//.test(result.message ?? '')) leaks.push(`${action.name}: ${result.message}`);
    }
    // Проверка, которая не видела ни одного отказа, ничего не доказывает.
    expect(failed).toBeGreaterThan(5);
    expect(leaks).toEqual([]);
  });

  it('исключение с адресом внутри — модель получает причину, но не адрес', async () => {
    const result = await call('leaky_local');
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('ECONNRESET');
    expect(result.message).not.toMatch(/\/api\/|127\.0\.0\.1/);
  });
});
