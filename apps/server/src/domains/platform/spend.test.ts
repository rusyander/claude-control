import { describe, it, expect } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import type { Platform, PlatformSpendDay, PlatformSpendRecord } from '@agentdeck/contracts';
import type { PricingLookup } from '../analytics/pricing.ts';
import {
  addSpend,
  addToDay,
  budgetVerdict,
  BUDGET_WARN_SHARE,
  clearExhausted,
  daysSince,
  emptySpend,
  gatewayPricing,
  spendDay,
  spendInfo,
  SPEND_DAYS_KEPT,
  UNPRICED_MODELS_KEPT,
  sumDays,
  type SpendDelta,
} from './spend.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Учёт расхода контура.
 *
 * Здесь заперты три обещания карточки. Две величины никогда не складываются:
 * внутренняя единица контура считается от суммы токенов, деньги — по нашему
 * прайсу и только за модели, цена которых известна. Модель без цены не получает
 * ставку «неизвестной» и называется поимённо. И «бюджет исчерпан» — это ответ
 * контура (факт), а не наша оценка: снимает его только человек.
 */

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const platformOf = (patch: Partial<Platform>): Platform => ({ ...PLATFORM, ...patch });

const delta = (patch: Partial<SpendDelta> = {}): SpendDelta => ({
  model: 'claude-sonnet-5',
  promptTokens: 1_000_000,
  completionTokens: 0,
  totalTokens: 1_000_000,
  ...patch,
});

/** Прайс, в котором есть Sonnet 5 и нет модели компании. */
const LOOKUP: PricingLookup = {
  entries: [
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  ],
};

describe('день учёта', () => {
  it('день местный, а не UTC: человек сверяет с админкой в своём поясе', () => {
    // 23:30 местного времени — в UTC это уже следующие сутки в любом поясе к
    // востоку от Гринвича, и день учёта разошёлся бы с админкой на сутки.
    const at = new Date(2026, 8, 10, 23, 30);
    expect(spendDay(at)).toBe('2026-09-10');
  });
});

describe('расход одного ответа', () => {
  it('день копит токены и деньги, и второй величины у него нет', () => {
    let day = addToDay(
      addToDay(emptyDay(), delta({ totalTokens: 33_333 }), LOOKUP),
      delta({ totalTokens: 33_333 }),
      LOOKUP,
    );
    day = addToDay(day, delta({ totalTokens: 33_333 }), LOOKUP);
    expect(day.totalTokens).toBe(99_999);
    expect(day.requests).toBe(3);
    // Деньги — сумма посчитанного по каждому ответу, без потери копеек на
    // округлениях: три ответа по миллиону входных токенов Sonnet 5 = 9 $.
    expect(day.money.usd).toBe(9);
    expect(day.money.pricedTokens).toBe(99_999);
    // И НИКАКОЙ «внутренней единицы контура» рядом: её формулы больше нет,
    // вернуться поле может только вместе с этой проверкой.
    expect(day).not.toHaveProperty('unitUsd');
  });

  it('деньги считаются по прайсу: миллион входных токенов Sonnet 5 — три доллара', () => {
    const day = addToDay(emptyDay(), delta(), LOOKUP);
    expect(day.money.usd).toBe(3);
    expect(day.money.pricedTokens).toBe(1_000_000);
    expect(day.money.unpricedTokens).toBe(0);
    expect(day.money.unpricedModels).toEqual([]);
  });

  it('модель без цены в деньги НЕ переводится и названа поимённо', () => {
    const day = addToDay(emptyDay(), delta({ model: 'enterprise-platform-corp-l' }), LOOKUP);
    expect(day.money.usd).toBe(0);
    expect(day.money.pricedTokens).toBe(0);
    expect(day.money.unpricedTokens).toBe(1_000_000);
    expect(day.money.unpricedModels).toEqual(['enterprise-platform-corp-l']);
    // Токены при этом посчитаны: расход есть, неизвестна только его цена.
    expect(day.totalTokens).toBe(1_000_000);
  });

  it('одна и та же модель без цены не повторяется в списке', () => {
    let day = addToDay(emptyDay(), delta({ model: 'enterprise-platform-corp-l' }), LOOKUP);
    day = addToDay(day, delta({ model: 'enterprise-platform-corp-l' }), LOOKUP);
    expect(day.money.unpricedModels).toEqual(['enterprise-platform-corp-l']);
  });

  // Найдено враждебным ревью Т8: имя модели приходит из тела запроса КЛИЕНТА,
  // и версионные суффиксы или перебирающий имена прогон растили бы этот список
  // без предела — а он лежит в `state.json`, который пишется целиком, и выходит
  // на карточку одной строкой.
  it('имён моделей без цены помним ограниченное число, а токены считаем все', () => {
    let day = emptyDay();
    for (let index = 0; index < UNPRICED_MODELS_KEPT + 5; index += 1) {
      day = addToDay(day, delta({ model: `модель-${index}` }), LOOKUP);
    }
    expect(day.money.unpricedModels).toHaveLength(UNPRICED_MODELS_KEPT);
    expect(day.money.unpricedTokens).toBe(1_000_000 * (UNPRICED_MODELS_KEPT + 5));
    expect(day.requests).toBe(UNPRICED_MODELS_KEPT + 5);
  });

  it('длинное имя модели обрезается: это подпись, а не текст', () => {
    const day = addToDay(emptyDay(), delta({ model: 'м'.repeat(500) }), LOOKUP);
    const name = day.money.unpricedModels[0]!;
    expect(name.length).toBeLessThan(200);
    expect(name.endsWith('…')).toBe(true);
  });

  it('без имени модели цену искать не по чему — и в список это не пишется', () => {
    const day = addToDay(emptyDay(), delta({ model: '' }), LOOKUP);
    expect(day.money.unpricedTokens).toBe(1_000_000);
    expect(day.money.unpricedModels).toEqual([]);
  });
});

describe('запись контура', () => {
  it('расход ложится в свой день, а дни держатся по возрастанию', () => {
    let record = emptySpend('enterprise-platform-dev');
    record = addSpend(record, delta(), new Date(2026, 8, 10), LOOKUP);
    // Часы могли отъехать назад (перевод времени, правка системных часов):
    // «вчерашняя» запись обязана встать перед сегодняшней, а не в конец.
    record = addSpend(record, delta(), new Date(2026, 8, 9), LOOKUP);
    record = addSpend(record, delta(), new Date(2026, 8, 10), LOOKUP);

    expect(record.days.map((day) => day.day)).toEqual(['2026-09-09', '2026-09-10']);
    expect(record.days[1]!.requests).toBe(2);
  });

  it('дней хранится ограниченное число — учёт не архив', () => {
    let record = emptySpend('enterprise-platform-dev');
    for (let index = 0; index < SPEND_DAYS_KEPT + 5; index += 1) {
      record = addSpend(record, delta(), new Date(2026, 0, 1 + index), LOOKUP);
    }
    expect(record.days).toHaveLength(SPEND_DAYS_KEPT);
    // Обрезается НАЧАЛО: свежие дни — те, ради которых учёт и ведётся.
    expect(record.days[0]!.day).toBe(spendDay(new Date(2026, 0, 6)));
  });

  it('сумма дней складывает деньги и собирает все модели без цены', () => {
    let record = emptySpend('enterprise-platform-dev');
    record = addSpend(record, delta(), new Date(2026, 8, 9), LOOKUP);
    record = addSpend(record, delta({ model: 'enterprise-platform-corp-l' }), new Date(2026, 8, 10), LOOKUP);

    const total = sumDays(record.days);
    expect(total.requests).toBe(2);
    expect(total.money.usd).toBe(3);
    expect(total.money.unpricedModels).toEqual(['enterprise-platform-corp-l']);
    // Токены модели без цены в деньги НЕ вошли — ровно как у контура, который
    // модель без цены тоже не списывает.
    expect(total.money.pricedTokens).toBe(1_000_000);
    expect(total.money.unpricedTokens).toBe(1_000_000);
  });
});

describe('период бюджета', () => {
  const days = [dayOf('2026-09-01'), dayOf('2026-09-05'), dayOf('2026-09-10')];

  it('пустая дата означает «с начала учёта», а не «ничего»', () => {
    expect(daysSince(days, '')).toHaveLength(3);
  });

  it('день начала входит в период', () => {
    expect(daysSince(days, '2026-09-05').map((day) => day.day)).toEqual([
      '2026-09-05',
      '2026-09-10',
    ]);
  });
});

describe('итог по бюджету', () => {
  /**
   * Запись на `usd` долларов НАШЕЙ оценки. Именно по ней теперь идёт полоса
   * бюджета: «внутренней единицы контура» (токены × 0.00001 $) не существует —
   * контур тарифицирует по ценам своего реестра.
   */
  const record = (usd: number): PlatformSpendRecord => ({
    platformId: 'enterprise-platform-dev',
    days: [
      {
        ...dayOf('2026-09-10'),
        totalTokens: 1_000_000,
        money: { usd, pricedTokens: 1_000_000, unpricedTokens: 0, unpricedModels: [] },
      },
    ],
  });

  it('ноль означает «не следить», а не «исчерпан»', () => {
    const verdict = budgetVerdict(platformOf({ budgetUsd: 0 }), record(62));
    expect(verdict).toMatchObject({ tracked: false, overEstimate: false, nearLimit: false });
    // Расход при этом посчитан: цифра показывается и без бюджета.
    expect(verdict.spentUsd).toBeCloseTo(62, 6);
  });

  it('доля не растёт за край, а порог внимания — до отказа, а не после', () => {
    expect(budgetVerdict(platformOf({ budgetUsd: 100 }), record(62))).toMatchObject({
      share: 0.62,
      nearLimit: false,
      overEstimate: false,
    });
    // 85 % — предупреждение заранее. Отказом контура это НЕ подтверждается:
    // исчерпанный бюджет ключа он отдаёт кодом 401, неотличимым от отозванного.
    const warn = budgetVerdict(platformOf({ budgetUsd: 70 }), record(62));
    expect(warn.nearLimit).toBe(true);
    expect(warn.overEstimate).toBe(false);
    expect(62 / 70).toBeGreaterThan(BUDGET_WARN_SHARE);

    expect(budgetVerdict(platformOf({ budgetUsd: 50 }), record(62))).toMatchObject({
      share: 1,
      overEstimate: true,
    });
  });

  it('период считается от названного дня — расход до него в бюджет не входит', () => {
    const spend: PlatformSpendRecord = {
      platformId: 'enterprise-platform-dev',
      days: [
        {
          ...dayOf('2026-08-31'),
          totalTokens: 5_000_000,
          money: { usd: 50, pricedTokens: 5_000_000, unpricedTokens: 0, unpricedModels: [] },
        },
        {
          ...dayOf('2026-09-01'),
          totalTokens: 1_000_000,
          money: { usd: 10, pricedTokens: 1_000_000, unpricedTokens: 0, unpricedModels: [] },
        },
      ],
    };
    const verdict = budgetVerdict(platformOf({ budgetUsd: 20, budgetSince: '2026-09-01' }), spend);
    expect(verdict.spentUsd).toBeCloseTo(10, 6);
    expect(verdict.overEstimate).toBe(false);
  });

  it('402 — факт, и чей это лимит доезжает до экрана', () => {
    const spend: PlatformSpendRecord = {
      ...record(1),
      exhaustedAt: '2026-09-10T10:00:00.000Z',
      exhaustedScope: 'limit',
      exhaustedLevel: 'org_monthly',
    };
    const verdict = budgetVerdict(platformOf({ budgetUsd: 100 }), spend);
    // Наш счёт далеко от бюджета — и всё равно контур уже отказывает. Что
    // именно кончилось, обязано доехать до карточки: без этого строка
    // сообщала бы, что кончилось не то, что кончилось.
    expect(verdict.overEstimate).toBe(false);
    expect(verdict.exhausted).toBe(true);
    expect(verdict.exhaustedAt).toBe('2026-09-10T10:00:00.000Z');
    expect(verdict.exhaustedScope).toBe('limit');
    expect(verdict.exhaustedLevel).toBe('org_monthly');
  });

  it('уровня контур не назвал — поля нет вовсе, а не пустая строка', () => {
    const verdict = budgetVerdict(platformOf({ budgetUsd: 100 }), {
      ...record(1),
      exhaustedAt: '2026-09-10T10:00:00.000Z',
    });
    expect(verdict.exhausted).toBe(true);
    expect(verdict).not.toHaveProperty('exhaustedLevel');
    expect(verdict).not.toHaveProperty('exhaustedScope');
  });
});

describe('снятие отметки «исчерпан»', () => {
  const storeOf = (record?: PlatformSpendRecord) => {
    let state: Record<string, PlatformSpendRecord> = record ? { [record.platformId]: record } : {};
    return {
      getPlatformSpend: () => state,
      savePlatformSpend: (next: PlatformSpendRecord) => {
        state = { ...state, [next.platformId]: next };
      },
      read: () => state,
    };
  };

  it('снимает отметку и говорит, что снимать было что', () => {
    const store = storeOf({
      platformId: 'enterprise-platform-dev',
      days: [],
      exhaustedAt: '2026-09-10T10:00:00.000Z',
      exhaustedScope: 'key',
    });
    expect(clearExhausted(store, 'enterprise-platform-dev')).toBe(true);
    // Снимается вся отметка: оставшийся scope всплыл бы у следующего отказа.
    expect(store.read()['enterprise-platform-dev']).toEqual({ platformId: 'enterprise-platform-dev', days: [] });
  });

  it('снимать нечего — запись не трогается вовсе', () => {
    const store = storeOf({ platformId: 'enterprise-platform-dev', days: [] });
    expect(clearExhausted(store, 'enterprise-platform-dev')).toBe(false);
    expect(clearExhausted(store, 'нет-такого')).toBe(false);
  });
});

describe('расход для экрана', () => {
  it('дни отдаются целиком, а период — суммой: это разные вопросы', () => {
    const spend: PlatformSpendRecord = {
      platformId: 'enterprise-platform-dev',
      days: [
        {
          ...dayOf('2026-08-31'),
          totalTokens: 5_000_000,
          money: { usd: 50, pricedTokens: 5_000_000, unpricedTokens: 0, unpricedModels: [] },
        },
        {
          ...dayOf('2026-09-01'),
          totalTokens: 1_000_000,
          money: { usd: 10, pricedTokens: 1_000_000, unpricedTokens: 0, unpricedModels: [] },
        },
      ],
    };
    const info = spendInfo(platformOf({ budgetSince: '2026-09-01' }), spend);
    expect(info.days).toHaveLength(2);
    expect(info.period.totalTokens).toBe(1_000_000);
    expect(info.total.totalTokens).toBe(6_000_000);
    expect(info.budgetSince).toBe('2026-09-01');
  });
});

describe('цены для оценки', () => {
  it('свои цены человека перебивают прайс, и прайс читается ЖИВЫМ', () => {
    let entries = LOOKUP.entries!;
    const lookup = gatewayPricing(
      {
        getSettings: () =>
          ({ modelPricing: {} }) as unknown as ReturnType<
            Parameters<typeof gatewayPricing>[0]['getSettings']
          >,
      },
      { current: () => ({ entries }) },
    );
    expect(lookup().entries).toBe(entries);

    // Прайс обновился между запросами — следующий же расход считается по новому.
    entries = [];
    expect(lookup().entries).toEqual([]);
  });
});

function emptyDay() {
  return dayOf('2026-09-10');
}

function dayOf(day: string): PlatformSpendDay {
  return {
    day,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    money: { usd: 0, pricedTokens: 0, unpricedTokens: 0, unpricedModels: [] },
  };
}
