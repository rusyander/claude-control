import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Analytics, AnalyticsPricing } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { scanAnalytics } from '../domains/analytics/scanner.ts';
import { getRunningAgents, getSkillUsage } from '../domains/analytics/runtime.ts';
import { PRICING_URL } from '../domains/analytics/pricing-source.ts';
import { longCacheRate, withOwnLongCacheRate } from '../domains/analytics/pricing.ts';

/**
 * Аналитика. Полный обход транскриптов стоит секунд, поэтому результат
 * кэшируется: открытие страницы и переключение фильтров не должны каждый раз
 * перечитывать тысячу файлов. Список процессов живёт на своём коротком кэше
 * (`runtime.ts`) — он показывает происходящее прямо сейчас, но на Windows его
 * обход стоит секунды, а не копейки.
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  key: string;
  at: number;
  data: Omit<Analytics, 'runningAgents' | 'topSkills'>;
}

let cache: CacheEntry | undefined;

/**
 * Границы периода «сегодня» — ровно одни календарные сутки: от местной полуночи
 * текущего дня до полуночи следующего. Правый край — не «сейчас»: запись с
 * меткой позже текущего момента (часы машины ушли вперёд) относится к этому же
 * дню и попадает в столбец `byDay` за сегодня, значит обязана попасть и в итоги.
 */
function todayRange(): { since: number; until: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return { since: start.getTime(), until: endOfLocalDay(start.getTime()) };
}

/**
 * Последняя миллисекунда местных суток, начавшихся в `start`. Конец берём
 * следующей полуночью ПО КАЛЕНДАРЮ, а не «плюс 24 часа»: в день перевода часов
 * сутки длятся 23 или 25 часов, и арифметика на миллисекундах отрезала бы час
 * своего дня или прихватывала час соседнего.
 */
function endOfLocalDay(start: number): number {
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next.getTime() - 1;
}

/**
 * Границы произвольного диапазона из `?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Даты разбираются как МЕСТНЫЕ сутки, а не UTC (`new Date('2026-07-26')` — это
 * полночь по Гринвичу, в поясе +3 она уже вчерашний вечер): группировка по дням
 * и часам в `scanner.ts` тоже локальная, границы обязаны совпадать с ней.
 * Правая граница включительна — до 23:59:59.999 выбранного дня.
 *
 * Мусор или неполная пара («только from») — не диапазон: возвращаем undefined и
 * маршрут молча падает на период по дням, вместо 500 на NaN.
 */
/**
 * Пресет в N дней — календарные сутки: сегодня и N−1 предыдущих, от местной
 * полуночи. Скользящие N×24 часа давали лишний, частичный день в начале ряда:
 * «7 дней» рисовались восемью точками, первая — обрезок вчерашнего вечера.
 */
function presetRange(days: number): { since: number; until: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { since: start.getTime(), until: endOfLocalDay(today.getTime()) };
}

function parseRange(from?: string, to?: string): { since: number; until: number } | undefined {
  const start = parseLocalDay(from);
  const end = parseLocalDay(to);
  if (start === undefined || end === undefined) return undefined;

  // Перепутанные местами даты выбираются пикером на раз — не ошибка, а порядок.
  const [since, endDay] = start <= end ? [start, end] : [end, start];
  return { since, until: endOfLocalDay(endDay) };
}

function parseLocalDay(value?: string): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export function registerAnalyticsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { days?: string; from?: string; to?: string; refresh?: string } }>(
    '/api/analytics',
    async (request): Promise<Analytics> => {
      // Явный диапазон из пикера перебивает период по дням.
      const range = parseRange(request.query.from, request.query.to);
      // days=today — календарные сутки целиком: от местной полуночи текущего дня
      // до полуночи следующего, а не скользящие 24 часа до текущего момента
      // (иначе утром в отчёт попадала бы половина вчерашнего дня). Дата дня и
      // час берутся по локальному времени (`scanner.ts`), поэтому и границы
      // периода — локальные.
      //
      // days=0 означает «за всё время»: берём заведомо больший интервал,
      // чем возраст любых транскриптов, вместо отдельной ветки без фильтра.
      // Нечисловой ввод (`?days=abc` → NaN) откатываем к периоду по умолчанию:
      // иначе NaN пролез бы в расчёт since и уронил сборку отчёта.
      const raw = request.query.days ?? 'today';
      const isToday = raw === 'today';
      const requested = Number(raw);
      const normalized = Number.isFinite(requested) ? requested : 30;
      const days = isToday
        ? 1
        : normalized === 0
          ? 36_500
          : Math.min(Math.max(normalized, 1), 3650);
      // Явный диапазон перебивает пресет; пресеты в днях — календарные, от
      // местной полуночи; границ нет только у «за всё время» — сканер сам
      // отсчитает `days` назад от текущего момента.
      const bounds =
        range ?? (isToday ? todayRange() : normalized === 0 ? undefined : presetRange(days));
      const since = bounds?.since;
      const until = bounds?.until;
      const snapshot = ctx.pricing.current();
      const projectsDir = join(ctx.location.paths.root, 'projects');
      // Тарифы входят в ключ: иначе после правки цен (или после обновления
      // прайса) панель ещё минуту показывала бы стоимость по старым.
      //
      // Каталог конфигурации — тоже: при переключении на другой ~/.claude всё
      // остальное в ключе совпадает (у свежего каталога нет своего кэша прайса,
      // и обе стороны падают на встроенный снимок с одной и той же датой), и
      // панель ещё минуту выдавала бы расход ПРЕЖНЕГО каталога за новый.
      const key = [
        // В ключе стоят сами границы, а не пресет: «сегодня» и «1 день» — разные
        // периоды при одном days, а ещё ответ за вчера не должен доживать в кэше
        // до сегодняшнего запроса «сегодня» — с полуночью меняются и границы.
        bounds ? `range:${bounds.since}-${bounds.until}` : `days:${days}`,
        projectsDir,
        JSON.stringify(ctx.store.getSettings().modelPricing),
        snapshot.fetchedAt,
      ].join('|');
      const isFresh = cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS;
      const forceRefresh = request.query.refresh === 'true';

      if (!isFresh || forceRefresh) {
        cache = {
          key,
          at: Date.now(),
          data: await scanAnalytics(projectsDir, {
            days,
            since,
            until,
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
   *
   * Исключение — явное `refresh=true`: нажатая кнопка обязана уметь провалиться.
   * Ответ 200 с прежними строками неотличим от «цены и так свежие», поэтому
   * неудачное принудительное обновление отвечает ошибкой (её покажет тост), а
   * карточка остаётся на прошлых ценах — они верны, просто не обновились.
   */
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/analytics/pricing',
    async (request, reply) => {
      const force = request.query.refresh === 'true';
      const snapshot = await ctx.pricing.refresh({ force });

      const failure = ctx.pricing.lastError();
      if (force && failure)
        return reply.code(502).send({ message: `Не удалось обновить прайс: ${failure}` });

      const custom = ctx.store.getSettings().modelPricing;

      const body: AnalyticsPricing = {
        // Часовую ставку проставляем ЗДЕСЬ, а не на фронте: правило вывода
        // (×1.6 для прайса, «как введено» для своей цены) живёт в одном месте,
        // иначе таблица настроек показывала бы одну цифру, а счёт считался бы
        // по другой. На сам расчёт это не влияет — там те же функции.
        entries: snapshot.entries.map((entry) => ({
          ...entry,
          price: { ...entry.price, cacheWrite1h: longCacheRate(entry.price) },
        })),
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
        url: snapshot.url ?? PRICING_URL,
        stale: ctx.pricing.isStale(),
        custom: Object.fromEntries(
          Object.entries(custom).map(([fragment, price]) => [
            fragment,
            withOwnLongCacheRate(price),
          ]),
        ),
      };

      return body;
    },
  );
}
