import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { PricingStore } from '../domains/analytics/pricing-source.ts';
import type { ServerContext } from '../context.ts';
import { registerAnalyticsRoutes } from './analytics-routes.ts';

// Живые данные маршрута — обход процессов всей машины: в тесте он и не нужен,
// и стоит секунды (на Windows это запуск PowerShell).
vi.mock('../domains/analytics/runtime.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../domains/analytics/runtime.ts')>()),
  getRunningAgents: vi.fn(async () => []),
  getSkillUsage: vi.fn(() => []),
}));

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

/**
 * Тот же прайс без колонки часовой записи: она объявлена НЕОБЯЗАТЕЛЬНОЙ
 * намеренно (требовать её — значит уронить разбор всей таблицы, когда сайт
 * переименует колонку). Тогда часовая ставка выводится из пятиминутной.
 */
const PAGE_NO_LONG_CACHE = `## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | Cache Hits & Refreshes | Output Tokens |
| ----- | ----------------- | --------------- | ---------------------- | ------------- |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $0.50 / MTok | $25 / MTok |
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

    expect(opus.price).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      // Часовая запись кэша — своя ставка, а не та же пятиминутная.
      cacheWrite1h: 10,
    });
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

  /**
   * Регрессия про ДЕНЬГИ: часовая ставка не доживала до карточки «Тарифы».
   * Схема знала четыре поля, zod срезал пятое (проверка схемы —
   * `settings-validation.test.ts`), карточка не могла ни показать часовую цену,
   * ни задать её — а расчёт при этом домножал введённую пятиминутную на 1.6.
   */
  it('своя часовая ставка доезжает до карточки как задана', async () => {
    const price = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 7 };
    store.updateSettings({ modelPricing: { 'claude-opus-4-8': price } });

    const body = (await app.inject({ method: 'GET', url: '/api/analytics/pricing' })).json();
    expect(body.custom['claude-opus-4-8']).toEqual(price);
  });

  it('своя цена без часовой ставки показывается как введена, без ×1.6', async () => {
    store.updateSettings({
      modelPricing: { 'claude-opus-4-8': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    });

    const body = (await app.inject({ method: 'GET', url: '/api/analytics/pricing' })).json();
    // 4, а не 6.4: карточка обязана показывать ту цифру, по которой считает счёт.
    expect(body.custom['claude-opus-4-8'].cacheWrite1h).toBe(4);
  });

  it('строка прайса без часовой колонки приезжает с выведенной ставкой', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PAGE_NO_LONG_CACHE, { status: 200 })),
    );

    const body = (await app.inject({ method: 'GET', url: '/api/analytics/pricing' })).json();
    const opus = body.entries.find((entry: { id: string }) => entry.id === 'claude-opus-4-8');
    // 6.25 × 1.6 = 10 ровно, без двоичного хвоста — колонка не должна пустовать,
    // расчёт всё равно идёт по этой ставке.
    expect(opus.price.cacheWrite1h).toBe(10);
  });

  /**
   * Период запроса: «сегодня» по умолчанию и произвольный диапазон дат из
   * пикера. Проверяется на маршруте, а не в сканере: именно здесь строка
   * запроса превращается в границы периода — и именно здесь легко получить
   * UTC-полночь вместо местной.
   */
  describe('период запроса', () => {
    const roots: string[] = [];
    const apps: FastifyInstance[] = [];

    /** Строка транскрипта: один ответ модели с заданным временем и входом. */
    const line = (id: string, at: Date, input: number): string =>
      `${JSON.stringify({
        type: 'assistant',
        timestamp: at.toISOString(),
        sessionId: 'sess',
        cwd: '/work/a',
        message: {
          id,
          model: 'claude-opus-4-8',
          usage: { input_tokens: input, output_tokens: 0 },
        },
      })}\n`;

    /** Каталог с двумя записями: вчерашний полдень и текущие сутки, плюс `extra`. */
    const buildWithDays = (extra = ''): FastifyInstance => {
      const configRoot = mkdtempSync(join(tmpdir(), 'cc-analytics-period-'));
      roots.push(configRoot);
      const appData = join(configRoot, 'claude-control');
      mkdirSync(appData, { recursive: true });

      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const yesterdayNoon = new Date(midnight.getTime() - 12 * 60 * 60 * 1000);

      const sessionDir = join(configRoot, 'projects', 'proj');
      mkdirSync(sessionDir, { recursive: true });

      writeFileSync(
        join(sessionDir, 'sess.jsonl'),
        line('msg-yesterday', yesterdayNoon, 100) + line('msg-today', midnight, 7) + extra,
      );

      const ctx = {
        location: {
          paths: { root: configRoot, appData, mcpConfig: join(configRoot, '.claude.json') },
        },
        store: new AppStore(appData),
        pricing: new PricingStore(appData),
      } as unknown as ServerContext;

      const instance = Fastify();
      registerAnalyticsRoutes(instance, ctx);
      apps.push(instance);
      return instance;
    };

    /** Местная дата в том же виде, в каком её присылает `input[type=date]`. */
    const isoDay = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}`;

    afterEach(async () => {
      await Promise.all(apps.map((instance) => instance.close()));
      apps.length = 0;
      for (const dir of roots) rmSync(dir, { recursive: true, force: true });
      roots.length = 0;
    });

    it('без параметров период — сегодняшние сутки', async () => {
      const instance = buildWithDays();
      const body = (await instance.inject({ method: 'GET', url: '/api/analytics' })).json();

      // Вчерашний полдень отсечён, хотя от него меньше суток.
      expect(body.overall.input).toBe(7);
      const from = new Date(body.from);
      expect([from.getHours(), from.getMinutes()]).toEqual([0, 0]);
      expect(isoDay(from)).toBe(isoDay(new Date()));
    });

    it('«сегодня» — сутки целиком, а не отрезок до текущего момента', async () => {
      const lateToday = new Date();
      lateToday.setHours(23, 59, 59, 0);
      const tomorrow = new Date();
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const instance = buildWithDays(
        line('msg-late', lateToday, 3) + line('msg-tomorrow', tomorrow, 1000),
      );
      const body = (
        await instance.inject({ method: 'GET', url: '/api/analytics?days=today' })
      ).json();

      // 7 + 3: запись с меткой позже «сейчас» (часы машины ушли вперёд) — та же
      // дата и тот же столбец byDay, значит и те же итоги. Завтрашняя полночь
      // уже за правой границей.
      expect(body.overall.input).toBe(10);
    });

    it('диапазон дат отдаёт только свои сутки', async () => {
      const instance = buildWithDays();
      const yesterday = isoDay(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const body = (
        await instance.inject({
          method: 'GET',
          url: `/api/analytics?from=${yesterday}&to=${yesterday}`,
        })
      ).json();

      expect(body.overall.input).toBe(100);
    });

    it('мусорные границы диапазона не роняют маршрут', async () => {
      const instance = buildWithDays();
      const response = await instance.inject({
        method: 'GET',
        url: '/api/analytics?from=вчера&to=сегодня&days=30',
      });

      // Непонятный диапазон игнорируется — работает период по дням.
      expect(response.statusCode).toBe(200);
      expect(response.json().overall.input).toBe(107);
    });
  });

  /**
   * Кэш аналитики живёт в модуле маршрута и переживает смену каталога
   * конфигурации: ключ складывался из периода, своих цен и даты прайса — у двух
   * свежих каталогов всё это совпадает (оба падают на встроенный снимок с
   * фиксированной датой). После переключения каталога панель ещё минуту
   * показывала расход ПРЕЖНЕГО каталога как расход нового.
   */
  describe('кэш аналитики привязан к каталогу конфигурации (регрессия)', () => {
    const roots: string[] = [];
    const apps: FastifyInstance[] = [];

    /** Каталог конфигурации с одним транскриптом на заданное число токенов. */
    const buildOn = (input: number): FastifyInstance => {
      const configRoot = mkdtempSync(join(tmpdir(), 'cc-analytics-dir-'));
      roots.push(configRoot);
      const appData = join(configRoot, 'claude-control');
      mkdirSync(appData, { recursive: true });

      const sessionDir = join(configRoot, 'projects', 'proj');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'sess.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          sessionId: 'sess',
          cwd: '/work/a',
          message: {
            id: `msg-${input}`,
            model: 'claude-opus-4-8',
            usage: { input_tokens: input, output_tokens: 0 },
          },
        })}\n`,
      );

      const ctx = {
        location: {
          paths: { root: configRoot, appData, mcpConfig: join(configRoot, '.claude.json') },
        },
        store: new AppStore(appData),
        pricing: new PricingStore(appData),
      } as unknown as ServerContext;

      const instance = Fastify();
      registerAnalyticsRoutes(instance, ctx);
      apps.push(instance);
      return instance;
    };

    afterEach(async () => {
      await Promise.all(apps.map((instance) => instance.close()));
      apps.length = 0;
      for (const dir of roots) rmSync(dir, { recursive: true, force: true });
      roots.length = 0;
    });

    it('второй каталог отдаёт свои цифры, а не кэш первого', async () => {
      const before = buildOn(111);
      const after = buildOn(222);

      const first = (await before.inject({ method: 'GET', url: '/api/analytics?days=30' })).json();
      const second = (await after.inject({ method: 'GET', url: '/api/analytics?days=30' })).json();

      expect(first.overall.input).toBe(111);
      expect(second.overall.input).toBe(222);
    });

    it('тот же каталог по-прежнему берётся из кэша', async () => {
      const instance = buildOn(111);
      const first = (
        await instance.inject({ method: 'GET', url: '/api/analytics?days=30' })
      ).json();
      const again = (
        await instance.inject({ method: 'GET', url: '/api/analytics?days=30' })
      ).json();

      // Кэш обязан работать: полный обход транскриптов стоит секунд, и признак
      // попадания — тот же самый отчёт целиком, включая отметку времени `to`.
      expect(again.to).toBe(first.to);
      expect(again.overall.input).toBe(111);
    });
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

    /**
     * Регрессия: нажатая кнопка «Обновить» обязана уметь провалиться. Маршрут
     * отвечал 200 с прежними строками и прежней датой, карточка перерисовывала
     * ровно то же самое — неудача была неотличима от «цены и так свежие», и
     * пользователь жал кнопку снова.
     */
    it('принудительное обновление без сети отвечает ошибкой, а не прежним прайсом', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/analytics/pricing?refresh=true',
      });

      expect(response.statusCode).toBe(502);
      // Текст уезжает в тост — в нём должна быть причина, а не «Bad Gateway».
      expect(response.json().message).toContain('ENOTFOUND');
    });

    it('после удачного обновления маршрут снова отвечает прайсом', async () => {
      await app.inject({ method: 'GET', url: '/api/analytics/pricing?refresh=true' });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(PAGE, { status: 200 })),
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/analytics/pricing?refresh=true',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().source).toBe('anthropic');
    });

    it('обычное открытие настроек без сети ошибкой не отвечает', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/analytics/pricing' });
      expect(response.statusCode).toBe(200);
    });
  });
});
