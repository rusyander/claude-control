import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { PricingStore } from '../domains/analytics/pricing-source.ts';
import type { ServerContext } from '../context.ts';
import { registerAnalyticsRoutes } from './analytics-routes.ts';

/**
 * Маршрут тарифов глазами панели: настройки открываются — прайс приезжает
 * свежий, сеть отвалилась — приезжает прошлый с честной отметкой источника.
 *
 * Проверяется через настоящий Fastify на временном каталоге: именно этот
 * маршрут дёргает карточка «Тарифы», и именно его ответ решает, по каким
 * ценам будет посчитан расход.
 */
const PAGE = `## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| ----- | ----------------- | --------------- | --------------- | ---------------------- | ------------- |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
`;

describe('маршрут тарифов', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const build = (): void => {
    const appData = join(root, 'claude-control');

    store = new AppStore(appData);
    const ctx = {
      location: { paths: { root, appData, mcpConfig: join(root, '.claude.json') } },
      store,
      pricing: new PricingStore(appData),
    } as unknown as ServerContext;

    app = Fastify();
    registerAnalyticsRoutes(app, ctx);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-analytics-routes-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PAGE, { status: 200 })),
    );
    build();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('отдаёт свежий прайс с отметкой источника и датой', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/analytics/pricing' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.source).toBe('anthropic');
    expect(body.stale).toBe(false);
    expect(Date.parse(body.fetchedAt)).not.toBeNaN();
    expect(body.entries).toHaveLength(2);
    expect(body.url).toContain('pricing');
  });

  it('цены разложены по нужным полям', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/analytics/pricing' })).json();
    const opus = body.entries.find((entry: { id: string }) => entry.id === 'claude-opus-4-8');

    expect(opus.price).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it('повторное открытие настроек не ходит в сеть — прайс кэширован на сутки', async () => {
    await app.inject({ method: 'GET', url: '/api/analytics/pricing' });
    await app.inject({ method: 'GET', url: '/api/analytics/pricing' });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refresh=true обновляет принудительно', async () => {
    await app.inject({ method: 'GET', url: '/api/analytics/pricing' });
    await app.inject({ method: 'GET', url: '/api/analytics/pricing?refresh=true' });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('свои цены из настроек приезжают вместе с прайсом', async () => {
    store.updateSettings({
      modelPricing: { 'claude-opus-4-8': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    });

    const body = (await app.inject({ method: 'GET', url: '/api/analytics/pricing' })).json();
    expect(body.custom['claude-opus-4-8'].input).toBe(1);
  });

  describe('сеть недоступна', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ENOTFOUND');
        }),
      );
      build();
    });

    it('маршрут отвечает встроенной таблицей, а не ошибкой', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/analytics/pricing' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Настройки должны открываться без интернета — иначе панель, чья работа
      // в том числе про офлайн-конфиг, окажется от него зависимой.
      expect(body.source).toBe('built-in');
      expect(body.stale).toBe(true);
      expect(body.entries.length).toBeGreaterThan(0);
    });
  });
});
