import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePricingTable, parseModelCell, fetchPricing, PricingStore } from './pricing-source.ts';
import { findEntry } from './pricing.ts';

/**
 * Разбор живого прайса Anthropic.
 *
 * Ставка теста высока: ошибка разбора — это не пустой экран, а НЕВЕРНЫЕ ДЕНЬГИ
 * в отчёте, причём правдоподобные. Поэтому проверяется не только «разобралось»,
 * но и что при любой неожиданности разбор ОТКАЗЫВАЕТСЯ, а не выдаёт что попало:
 * показать вчерашнюю цену не страшно, показать выдуманную — страшно.
 *
 * Фикстура ниже — фрагмент настоящей страницы (со ссылками, пометками
 * «deprecated» и двумя строками Sonnet 5), а следом за таблицей цен идёт другая
 * таблица: на реальной странице их несколько подряд.
 */
const PAGE = `# Pricing

## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| ----- | ----------------- | --------------- | --------------- | ---------------------- | ------------- |
| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 ([deprecated](/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 [through August 31, 2026](/docs/en/about-claude/pricing) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |

## Batch processing

| Model | Batch input | Batch output |
| ----- | ----------- | ------------ |
| Claude Opus 4.8 | $2.50 / MTok | $12.50 / MTok |
`;

describe('parsePricingTable', () => {
  it('разбирает таблицу целиком', () => {
    const entries = parsePricingTable(PAGE);
    expect(entries).toHaveLength(6);
  });

  it('раскладывает цены по нужным колонкам, а не по порядку', () => {
    const opus = parsePricingTable(PAGE).find((entry) => entry.id === 'claude-opus-4-8');
    // Колонка «1h Cache Writes» ($10) стоит между записью и чтением кэша —
    // при разборе по номерам колонок она бы уехала в цену чтения.
    expect(opus?.price).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      cacheWrite1h: 10,
    });
  });

  describe('часовая запись кэша — своя колонка (регрессия)', () => {
    // Разбор брал только «5m Cache Writes», а транскрипты пишут почти весь объём
    // в часовой кэш — он в 1.6 раза дороже. Вся запись кэша считалась по дешёвой
    // ставке, и стоимость в панели выходила заниженной примерно на 38%.
    it('ставка $10 за час берётся из своей колонки, а не приравнивается к $6.25', () => {
      const opus = parsePricingTable(PAGE).find((entry) => entry.id === 'claude-opus-4-8');
      expect(opus?.price.cacheWrite1h).toBe(10);
      expect(opus?.price.cacheWrite).toBe(6.25);
    });

    it('часовая ставка разобрана у всех строк таблицы', () => {
      const entries = parsePricingTable(PAGE);
      expect(
        entries.every((entry) => (entry.price.cacheWrite1h ?? 0) > entry.price.cacheWrite),
      ).toBe(true);
    });

    it('колонки нет — разбор не отменяется, ставка просто не проставлена', () => {
      // Обязательной её делать нельзя: пропажа увела бы панель на встроенную
      // таблицу целиком, а это хуже, чем вывести часовую ставку из пятиминутной.
      const withoutLong = `## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | Cache Hits & Refreshes | Output Tokens |
| ----- | ----------------- | --------------- | ---------------------- | ------------- |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $0.50 / MTok | $25 / MTok |
`;
      const opus = parsePricingTable(withoutLong).find((entry) => entry.id === 'claude-opus-4-8');

      expect(opus?.price.cacheWrite).toBe(6.25);
      expect(opus?.price.cacheRead).toBe(0.5);
      expect(opus?.price.cacheWrite1h).toBeUndefined();
    });
  });

  it('останавливается на конце таблицы и не тянет цены из соседней', () => {
    const entries = parsePricingTable(PAGE);
    // У пакетных цен Opus 4.8 стоит $2.50 — если бы разбор пошёл дальше,
    // появилась бы вторая строка про ту же модель с другими числами.
    expect(entries.filter((entry) => entry.id === 'claude-opus-4-8')).toHaveLength(1);
  });

  it('пометки в скобках не попадают в имя модели', () => {
    const entries = parsePricingTable(PAGE);
    expect(entries.map((entry) => entry.id)).toContain('claude-opus-4-1');
    expect(entries.map((entry) => entry.label)).toContain('Claude Opus 4.1');
  });

  describe('две цены одной модели различаются сроком действия', () => {
    const sonnet = parsePricingTable(PAGE).filter((entry) => entry.id === 'claude-sonnet-5');

    it('обе строки Sonnet 5 разобраны', () => {
      expect(sonnet).toHaveLength(2);
    });

    it('у вводной цены проставлен срок окончания', () => {
      const intro = sonnet.find((entry) => entry.price.input === 2);
      expect(intro?.until).toBe('2026-08-31');
      expect(intro?.from).toBeUndefined();
    });

    it('у последующей — дата начала', () => {
      const regular = sonnet.find((entry) => entry.price.input === 3);
      expect(regular?.from).toBe('2026-09-01');
      expect(regular?.until).toBeUndefined();
    });

    it('разобранный прайс выбирает цену по дате так же, как встроенный', () => {
      const entries = parsePricingTable(PAGE);
      const during = Date.parse('2026-07-19T00:00:00.000Z');
      const after = Date.parse('2026-10-01T00:00:00.000Z');
      expect(findEntry('claude-sonnet-5', entries, during)?.price.input).toBe(2);
      expect(findEntry('claude-sonnet-5', entries, after)?.price.input).toBe(3);
    });
  });

  describe('отказ разбора вместо неверных чисел', () => {
    it('нет таблицы — пустой результат', () => {
      expect(parsePricingTable('# Pricing\n\nЦены переехали на другую страницу.')).toEqual([]);
    });

    it('колонка переименована — разбор отказывается целиком', () => {
      // Пропала колонка «Cache Hits & Refreshes»: продолжить разбор значило бы
      // молча посчитать чтение кэша нулём.
      const broken = PAGE.replace('Cache Hits & Refreshes', 'Cached');
      expect(parsePricingTable(broken)).toEqual([]);
    });

    it('пустая строка на входе не роняет разбор', () => {
      expect(() => parsePricingTable('')).not.toThrow();
      expect(parsePricingTable('')).toEqual([]);
    });
  });
});

describe('колонка output ищется по последнему совпадению (регрессия)', () => {
  // Комментарий в коде обещал «последнее совпадение», а findIndex брал первое.
  // Стоит появиться в заголовке колонке со словом «output» ЛЕВЕЕ настоящей —
  // цена вывода уезжала в неё. Здесь это зафиксировано на разметке с колонкой
  // «Batch Output» перед «Output Tokens».
  const PAGE_EXTRA_OUTPUT = `## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | Batch Output | Cache Hits & Refreshes | Output Tokens |
| ----- | ----------------- | --------------- | ------------ | ---------------------- | ------------- |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $12.50 / MTok | $0.50 / MTok | $25 / MTok |
`;

  it('берёт настоящую колонку вывода ($25), а не «Batch Output» ($12.50)', () => {
    const opus = parsePricingTable(PAGE_EXTRA_OUTPUT).find((e) => e.id === 'claude-opus-4-8');
    expect(opus?.price.output).toBe(25);
    expect(opus?.price).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });
});

describe('срок действия цены — дата собирается локально, без сдвига на день', () => {
  // Грабля: `new Date('August 31, 2026').toISOString()` в поясах восточнее UTC
  // отдаёт `2026-08-30` — вводная цена «закончилась» бы на сутки раньше. Дату
  // собираем из ЛОКАЛЬНЫХ полей, поэтому день не должен уезжать ни при каком TZ.
  it('through August 31, 2026 → ровно 2026-08-31', () => {
    expect(parseModelCell('Claude Sonnet 5 through August 31, 2026')?.until).toBe('2026-08-31');
  });

  it('starting September 1, 2026 → ровно 2026-09-01', () => {
    expect(parseModelCell('Claude Sonnet 5 starting September 1, 2026')?.from).toBe('2026-09-01');
  });

  it('первый день месяца не откатывается в предыдущий месяц', () => {
    // Именно на первых числах ошибка -1 день заметнее всего: 2026-09-01 → 08-31.
    expect(parseModelCell('Claude X starting March 1, 2027')?.from).toBe('2027-03-01');
  });
});

describe('parseModelCell', () => {
  it('обычная модель', () => {
    expect(parseModelCell('Claude Opus 4.8')).toMatchObject({
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
    });
  });

  it('ссылка-пометка убирается', () => {
    expect(parseModelCell('Claude Opus 4 ([retired](/docs/x))')?.id).toBe('claude-opus-4');
  });

  it('строка не про модель отбрасывается', () => {
    expect(parseModelCell('Billing unit')).toBeUndefined();
    expect(parseModelCell('')).toBeUndefined();
  });
});

describe('fetchPricing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('отдаёт разобранный прайс с отметкой источника', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PAGE, { status: 200 })),
    );

    const snapshot = await fetchPricing('https://example.test/pricing.md');
    expect(snapshot.source).toBe('anthropic');
    expect(snapshot.entries).toHaveLength(6);
    expect(Date.parse(snapshot.fetchedAt)).not.toBeNaN();
  });

  it('ошибка HTTP — исключение, а не пустой прайс', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(fetchPricing('https://example.test/pricing.md')).rejects.toThrow('500');
  });

  it('страница без таблицы — исключение', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('# Pricing', { status: 200 })),
    );
    await expect(fetchPricing('https://example.test/pricing.md')).rejects.toThrow(/таблица/i);
  });
});

describe('PricingStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pricing-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const stubOk = (): ReturnType<typeof vi.fn> => {
    const spy = vi.fn(async () => new Response(PAGE, { status: 200 }));
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  it('без кэша работает по встроенной таблице', () => {
    const store = new PricingStore(dir);
    expect(store.current().source).toBe('built-in');
    expect(store.current().entries.length).toBeGreaterThan(0);
    expect(store.isStale()).toBe(true);
  });

  it('битый кэш не валит старт панели, а откатывает на встроенную таблицу', () => {
    // Оборванная запись: конструктор зовётся на старте сервера, до app.listen —
    // исключение отсюда означало бы «панель не открывается вовсе».
    writeFileSync(join(dir, 'pricing-cache.json'), '{"entries": [{"id": "claude-opus');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const store = new PricingStore(dir);

      expect(store.current().source).toBe('built-in');
      expect(store.isStale()).toBe(true);
      // Подмена молчком неотличима от свежего прайса — про неё должно быть сказано.
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('обновление сохраняет прайс на диск и делает его актуальным', async () => {
    const store = new PricingStore(dir);
    await store.refresh();

    expect(store.current().source).toBe('anthropic');
    expect(store.isStale()).toBe(false);
    expect(existsSync(join(dir, 'pricing-cache.json'))).toBe(true);
  });

  it('свежий кэш не ходит в сеть повторно', async () => {
    const spy = stubOk();
    const store = new PricingStore(dir);

    await store.refresh();
    await store.refresh();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('кнопка «обновить» ходит в сеть даже по свежему кэшу', async () => {
    const spy = stubOk();
    const store = new PricingStore(dir);

    await store.refresh();
    await store.refresh({ force: true });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('параллельные запросы дёргают сеть один раз', async () => {
    const spy = stubOk();
    const store = new PricingStore(dir);

    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('новый экземпляр поднимает прайс из кэша, не заглядывая в сеть', async () => {
    stubOk();
    await new PricingStore(dir).refresh();

    const restarted = new PricingStore(dir);
    expect(restarted.current().source).toBe('anthropic');
    expect(restarted.isStale()).toBe(false);
  });

  describe('сеть недоступна', () => {
    it('прайс остаётся прежним, исключение наружу не летит', async () => {
      stubOk();
      const store = new PricingStore(dir);
      await store.refresh();
      const before = store.current();

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ENOTFOUND');
        }),
      );

      // Тут важно именно отсутствие исключения: сбой сети не должен ронять
      // открытие настроек, а расход должен продолжать считаться.
      await expect(store.refresh({ force: true })).resolves.toEqual(before);
      expect(store.current().source).toBe('anthropic');
    });

    /**
     * Регрессия: неудача обновления не оставляла следа, и маршрут не мог
     * отличить «сходили и не смогли» от «ходить было незачем» — кнопка
     * «Обновить» отвечала успехом при выключенной сети.
     */
    it('причина неудачи запоминается и снимается после удачного обновления', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ENOTFOUND');
        }),
      );
      const store = new PricingStore(dir);

      await store.refresh({ force: true });
      expect(store.lastError()).toContain('ENOTFOUND');

      stubOk();
      await store.refresh({ force: true });
      expect(store.lastError()).toBeUndefined();
    });

    it('на первом запуске без сети остаёмся на встроенной таблице', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ENOTFOUND');
        }),
      );

      const store = new PricingStore(dir);
      const snapshot = await store.refresh();
      expect(snapshot.source).toBe('built-in');
      expect(snapshot.entries.length).toBeGreaterThan(0);
    });
  });

  it('битый кэш не обнуляет расчёт — откат на встроенную таблицу', () => {
    writeFileSync(join(dir, 'pricing-cache.json'), '{"entries":[]}', 'utf8');
    const store = new PricingStore(dir);
    expect(store.current().source).toBe('built-in');
    expect(store.current().entries.length).toBeGreaterThan(0);
  });

  /**
   * Регрессия: `Date.now() - Date.parse('вчера')` — это NaN, а любое сравнение с
   * NaN ложно. Кэш с испорченной датой объявлялся свежим НАВСЕГДА: в сеть панель
   * больше не ходила и до конца дней считала расход по замороженным ценам.
   */
  it('нечитаемая дата в кэше не делает прайс свежим навсегда', async () => {
    stubOk();
    const file = join(dir, 'pricing-cache.json');
    await new PricingStore(dir).refresh();

    const cached = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...cached, fetchedAt: 'позавчера' }), 'utf8');

    const restarted = new PricingStore(dir);
    expect(restarted.isStale()).toBe(true);

    const spy = stubOk();
    await restarted.refresh();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('сохранённый кэш читается обратно как валидный JSON', async () => {
    stubOk();
    const store = new PricingStore(dir);
    await store.refresh();

    const raw = readFileSync(join(dir, 'pricing-cache.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
