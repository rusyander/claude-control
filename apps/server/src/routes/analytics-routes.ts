import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Analytics, AnalyticsPricing } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { scanAnalytics } from '../domains/analytics/scanner.ts';
import { getRunningAgents, getSkillUsage } from '../domains/analytics/runtime.ts';
import { PRICING_URL } from '../domains/analytics/pricing-source.ts';

/**
 * Аналитика. Полный обход транскриптов стоит секунд, поэтому результат
 * кэшируется: открытие страницы и переключение фильтров не должны каждый раз
 * перечитывать тысячу файлов. Список процессов при этом всегда свежий —
 * он дешёвый, а именно он показывает, что происходит прямо сейчас.
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  key: string;
  at: number;
  data: Omit<Analytics, 'runningAgents' | 'topSkills'>;
}

let cache: CacheEntry | undefined;

export function registerAnalyticsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { days?: string; refresh?: string } }>(
    '/api/analytics',
    async (request): Promise<Analytics> => {
      // days=0 означает «за всё время»: берём заведомо больший интервал,
      // чем возраст любых транскриптов, вместо отдельной ветки без фильтра.
      const requested = Number(request.query.days ?? 30);
      const days = requested === 0 ? 36_500 : Math.min(Math.max(requested, 1), 3650);
      const snapshot = ctx.pricing.current();
      // Тарифы входят в ключ: иначе после правки цен (или после обновления
      // прайса) панель ещё минуту показывала бы стоимость по старым.
      const key = [
        `days:${days}`,
        JSON.stringify(ctx.store.getSettings().modelPricing),
        snapshot.fetchedAt,
      ].join('|');
      const isFresh = cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS;
      const forceRefresh = request.query.refresh === 'true';

      if (!isFresh || forceRefresh) {
        const projectsDir = join(ctx.location.paths.root, 'projects');
        cache = {
          key,
          at: Date.now(),
          data: await scanAnalytics(projectsDir, {
            days,
            recentSessionsLimit: 25,
            // Свои тарифы из настроек перебивают прайс: пользователь мог
            // считать по своим условиям.
            pricing: ctx.store.getSettings().modelPricing,
            // Актуальный прайс Anthropic из кэша. В сеть здесь не ходим:
            // аналитика и так тяжёлая, обновление живёт на своей точке.
            pricingEntries: snapshot.entries,
          }),
        };
      }

      const [runningAgents, topSkills] = [
        await getRunningAgents(),
        getSkillUsage(ctx.location.paths.mcpConfig),
      ];

      return { ...cache!.data, runningAgents, topSkills };
    },
  );

  /** Отдельная точка для живых данных: обновляется чаще, чем тяжёлая аналитика. */
  app.get('/api/analytics/live', async () => ({
    runningAgents: await getRunningAgents(),
    at: new Date().toISOString(),
  }));

  /**
   * Тарифы: актуальный прайс и свои цены. Нужны настройкам, чтобы показать,
   * по каким ценам считается стоимость, и дать их поправить — не заставляя
   * вспоминать прайс с нуля.
   *
   * Открытие настроек — и есть повод обновиться: прайс тянется с сайта, если
   * кэшу больше суток. Сеть недоступна — отдаём прошлый кэш, а `source` и
   * `fetchedAt` честно скажут интерфейсу, какой он давности.
   */
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/analytics/pricing',
    async (request): Promise<AnalyticsPricing> => {
      const snapshot = await ctx.pricing.refresh({ force: request.query.refresh === 'true' });

      return {
        entries: snapshot.entries,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
        url: snapshot.url ?? PRICING_URL,
        stale: ctx.pricing.isStale(),
        custom: ctx.store.getSettings().modelPricing,
      };
    },
  );
}
