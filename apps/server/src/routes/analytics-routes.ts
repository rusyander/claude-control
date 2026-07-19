import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Analytics } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { scanAnalytics } from '../domains/analytics/scanner.ts';
import { getRunningAgents, getSkillUsage } from '../domains/analytics/runtime.ts';

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
      const key = `days:${days}`;
      const isFresh = cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS;
      const forceRefresh = request.query.refresh === 'true';

      if (!isFresh || forceRefresh) {
        const projectsDir = join(ctx.location.paths.root, 'projects');
        cache = {
          key,
          at: Date.now(),
          data: await scanAnalytics(projectsDir, { days, recentSessionsLimit: 25 }),
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
}
