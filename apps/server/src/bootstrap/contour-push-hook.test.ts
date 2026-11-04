import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@agentdeck/contracts';
import { createContourPush } from '../domains/platform/contours/index.ts';
import { registerContourPushHook } from './contour-push-hook.ts';

type Facts = Pick<
  AppSettings,
  'platforms' | 'activePlatformId' | 'platformGateway' | 'dlp' | 'endpointProfiles'
>;

/**
 * Ответ на запись контура уходит после того, как ядро её применило (s10 G7). Ядро здесь — счётчик
 * с задержкой: ответ обязан прийти ПОСЛЕ его ответа, иначе панель сказала бы «сохранено», пока шлюз
 * человека держит прежний маршрут.
 */
function stand() {
  const settings = {
    platforms: [],
    activePlatformId: '',
    platformGateway: {},
    dlp: { enabled: false },
    endpointProfiles: [],
    theme: 'dark',
  } as unknown as Facts & { theme: string };
  const order: string[] = [];
  const push = createContourPush({
    settings: () => settings,
    apply: async () => {
      order.push('apply:start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('apply:done');
      return true;
    },
  });
  const app = Fastify();
  registerContourPushHook(app, push);
  app.post('/mode', async () => {
    (settings as { activePlatformId: string }).activePlatformId = 'dev';
    return { ok: true };
  });
  app.post('/theme', async () => {
    settings.theme = 'light';
    return { ok: true };
  });
  app.get('/read', async () => ({ ok: true }));
  return { app, order };
}

describe('правка контура доходит до ядра до ответа (s10 G7)', () => {
  it('запись контура — ответ после применения ядром; повтор без правки ядро не зовёт', async () => {
    const { app, order } = stand();
    const reply = await app.inject({ method: 'POST', url: '/mode' });
    order.push('reply');
    expect(reply.statusCode).toBe(200);
    expect(order).toEqual(['apply:start', 'apply:done', 'reply']);
    await app.inject({ method: 'POST', url: '/mode' });
    expect(order.filter((step) => step === 'apply:start')).toHaveLength(1);
  });

  it('запрос, не тронувший факты контура, и чтение — ядро не зовут', async () => {
    const { app, order } = stand();
    await app.inject({ method: 'POST', url: '/theme' });
    await app.inject({ method: 'GET', url: '/read' });
    expect(order).toEqual([]);
  });

  it('ядро не ответило — ответ всё равно уходит (такт ядра подхватит правку)', async () => {
    let reads = 0;
    const push = createContourPush({
      settings: () => ({ ...base, activePlatformId: String((reads += 1)) }),
      apply: () => Promise.reject(new Error('down')),
    });
    const app = Fastify();
    registerContourPushHook(app, push);
    app.post('/x', async () => ({ ok: true }));
    expect((await app.inject({ method: 'POST', url: '/x' })).statusCode).toBe(200);
  });
});

const base = {
  platforms: [],
  activePlatformId: '',
  platformGateway: {},
  dlp: { enabled: false },
  endpointProfiles: [],
} as unknown as Facts;
