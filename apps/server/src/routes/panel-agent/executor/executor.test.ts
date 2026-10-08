import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createRouteInjector } from './executor.ts';

/**
 * Срок чтения у исполнителя: настоящий Fastify, маршрут, который отвечает
 * дольше срока. Чтение обязано вернуться честным отказом, а запись — дождаться
 * ответа: её исход после срока был бы неизвестен.
 */
describe('исполнитель действий: срок маршрута чтения', () => {
  let app: FastifyInstance;
  const access = { requiresToken: () => false, expectedToken: () => '' };
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

  afterEach(async () => {
    await app.close();
  });

  const build = async (): Promise<FastifyInstance> => {
    app = Fastify();
    app.get('/api/fast', () => ({ ok: true }));
    app.get('/api/plugins/available', async () => {
      await wait(400);
      return { ok: true };
    });
    app.post('/api/slow-write', async () => {
      await wait(400);
      return { written: true };
    });
    await app.ready();
    return app;
  };

  it('зависшее чтение — честный отказ по сроку, быстрое — ответ как есть', async () => {
    const inject = createRouteInjector(await build(), access, undefined, 100);
    const startedAt = Date.now();
    const late = inject({ method: 'GET', url: '/api/plugins/available' });
    await expect(late).rejects.toThrow(/No answer within/);
    // F-295: чтение после срока может доделать свою работу (фоновый вызов
    // модели, обход каталога) — обещание «ничего не изменено» было ложным.
    await expect(late).rejects.not.toThrow(/Nothing was changed/);
    expect(Date.now() - startedAt).toBeLessThan(350);
    await expect(inject({ method: 'GET', url: '/api/fast' })).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
  });

  it('запись сроком чтения не обрывается: её исход иначе был бы неизвестен', async () => {
    const inject = createRouteInjector(await build(), access, undefined, 100);
    await expect(
      inject({ method: 'POST', url: '/api/slow-write', body: {} }),
    ).resolves.toMatchObject({
      status: 200,
      body: { written: true },
    });
  });
});
